import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex } from 'viem';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleModule,
  chainConfig,
  requestFixture,
  rpcFixture,
  hash,
} from './helpers.mjs';

void test(
  'real durable runtime preserves ownership, idempotency and pending or rejected transaction recovery across restart',
  { timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultratokenizer-durable-'));
    const domain = await bundleModule('../../../packages/domain/src/index.ts');
    const observer = await bundleModule('../src/chain-observer.ts');
    const code = await build({
      entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: ['cloudflare:workers'],
      logLevel: 'silent',
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const request = domain.module.parseIssuanceRequest({
      ...requestFixture,
      recipient: account.address,
      validUntil: String(Math.floor(Date.now() / 1000) + 3600),
    });
    const digest = domain.module.getIssuanceRequestDigest(request);
    const signature = await account.signTypedData(
      domain.module.getIssuanceRequestTypedData(request),
    );
    const keys = await generateKeyPair('RS256', { modulusLength: 2048 });
    const jwks = JSON.stringify({
      keys: [
        {
          ...(await exportJWK(keys.publicKey)),
          alg: 'RS256',
          kid: 'test-key',
          use: 'sig',
        },
      ],
    });
    let rpc = rpcFixture(request, digest, observer.module.issuanceEvent);
    let indexed = false;
    let transactionIndexed = false;
    let missingTransactionReads = 0;
    const observedMethods = [];
    const outboundErrors = [];
    const options = {
      workers: [
        {
          name: 'issuance-test',
          modules: true,
          script: code.outputFiles[0].text,
          compatibilityDate: '2026-09-08',
          compatibilityFlags: ['nodejs_compat'],
          durableObjects: {
            TENANTS: {
              className: 'IssuanceTenantCoordinator',
              useSQLite: true,
            },
          },
          ratelimits: {
            API_RATE_LIMIT: {
              namespace_id: '1001',
              simple: { limit: 1000, period: 60 },
            },
          },
          bindings: {
            AUTH_ISSUER: 'https://identity.synthetic.invalid/',
            AUTH_AUDIENCE: 'ultratokenizer-api',
            AUTH_JWKS: jwks,
            ALLOWED_ORIGIN: 'https://app.synthetic.invalid',
            CHAIN_ID: chainConfig.chainId,
            GATE_ADDRESS: chainConfig.gate,
            GATE_CODE_HASH: chainConfig.codeHash,
            RPC_URL: chainConfig.rpcUrl,
            MIN_CONFIRMATIONS: '2',
          },
          outboundService: async (outbound) => {
            try {
              assert.equal(
                outbound.url,
                chainConfig.rpcUrl,
                'No external network request is permitted.',
              );
              const input = await outbound.json();
              observedMethods.push(input.method);
              assert.ok(
                !input.method.startsWith('eth_send'),
                'Observer must never broadcast.',
              );
              const missingReceipt =
                !indexed && input.method === 'eth_getTransactionReceipt';
              const missingTransaction =
                !transactionIndexed &&
                input.method === 'eth_getTransactionByHash';
              if (missingTransaction) missingTransactionReads++;
              const result =
                missingReceipt || missingTransaction
                  ? null
                  : rpc.values[input.method];
              return Response.json({ jsonrpc: '2.0', id: input.id, result });
            } catch (error) {
              outboundErrors.push(error.message);
              throw error;
            }
          },
        },
      ],
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.ERROR),
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: dir,
    };
    const tenantName = keccak256(
      stringToHex(
        JSON.stringify([
          'ultratokenizer.observation-tenant.v1',
          options.workers[0].bindings.AUTH_ISSUER,
          options.workers[0].bindings.AUTH_AUDIENCE,
        ]),
      ),
    );
    let mf;
    async function bearer(subject = 'holder', wallet = account.address) {
      const now = Math.floor(Date.now() / 1000);
      return `Bearer ${await new SignJWT({ wallet })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' })
        .setIssuer(options.workers[0].bindings.AUTH_ISSUER)
        .setAudience(options.workers[0].bindings.AUTH_AUDIENCE)
        .setSubject(subject)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(keys.privateKey)}`;
    }
    async function call(
      path,
      { method = 'GET', body, subject = 'holder', authorization, origin } = {},
    ) {
      const headers = {
        authorization: authorization ?? (await bearer(subject)),
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (origin) headers.origin = origin;
      return mf.dispatchFetch(`https://api.synthetic.invalid${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    try {
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
      assert.equal(
        (await mf.dispatchFetch('https://api.synthetic.invalid/healthz'))
          .status,
        200,
      );
      assert.equal(
        (
          await call('/v1/requests', {
            method: 'POST',
            body: { request, holderSignature: signature },
            authorization: 'Bearer malformed',
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await call('/v1/requests', {
            method: 'POST',
            body: { request, holderSignature: signature },
            origin: 'https://wrong.invalid',
          })
        ).status,
        403,
      );
      const body = { request, holderSignature: signature };
      const created = await Promise.all(
        Array.from({ length: 8 }, () =>
          call('/v1/requests', { method: 'POST', body }),
        ),
      );
      for (const response of created) {
        assert.equal(response.status, 200, await response.clone().text());
        const value = await response.json();
        assert.equal(value.id, digest);
        assert.equal(value.revision, 1);
        assert.equal(value.status, 'awaiting_submission');
        assert.equal(value.ownerId, undefined);
      }
      assert.equal(
        (await call(`/v1/requests/${digest}`, { subject: 'other-holder' }))
          .status,
        404,
      );
      const persistent = await mf.unsafeGetDurableObjectStorage(
        'issuance-test',
        'IssuanceTenantCoordinator',
        { name: tenantName },
      );
      await persistent.exec(
        "CREATE TRIGGER fail_submission BEFORE INSERT ON events WHEN NEW.status = 'submitted' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END",
      );
      assert.equal(
        (
          await call(`/v1/requests/${digest}/transactions`, {
            method: 'POST',
            body: { transactionHash: hash },
          })
        ).status,
        503,
      );
      assert.equal(
        (await (await call(`/v1/requests/${digest}`)).json()).status,
        'awaiting_submission',
      );
      assert.equal(
        (await (await call(`/v1/requests/${digest}`)).json()).revision,
        1,
      );
      await persistent.exec('DROP TRIGGER fail_submission');
      const submitted = await call(`/v1/requests/${digest}/transactions`, {
        method: 'POST',
        body: { transactionHash: hash },
      });
      assert.equal(submitted.status, 202, await submitted.clone().text());
      assert.equal((await submitted.json()).status, 'submitted');
      assert.equal(
        (await call(`/v1/requests/${digest}/cancel`, { method: 'POST' }))
          .status,
        409,
      );
      assert.equal(
        (
          await call(`/v1/requests/${digest}/transactions`, {
            method: 'POST',
            body: { transactionHash: `0x${'ef'.repeat(32)}` },
          })
        ).status,
        409,
      );

      // Stop the runtime with an outstanding durable alarm, then load the same storage.
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
      let state = await (await call(`/v1/requests/${digest}`)).json();
      assert.equal(state.transactionHash, hash);
      assert.ok(['submitted', 'checking'].includes(state.status));
      indexed = true;
      // A receipt can be indexed before its transaction body. That incomplete
      // observation must preserve this same hash for durable automatic recovery.
      const bodyDeadline = Date.now() + 12_000;
      while (
        Date.now() < bodyDeadline &&
        (missingTransactionReads === 0 ||
          state.status !== 'submitted' ||
          state.observation?.reason !== 'not_indexed')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await (await call(`/v1/requests/${digest}`)).json();
      }
      assert.ok(
        missingTransactionReads > 0,
        'The actual worker requested the unavailable transaction body.',
      );
      assert.equal(state.observation?.reason, 'not_indexed');
      assert.equal(state.status, 'submitted', JSON.stringify(state));
      assert.equal(state.transactionHash, hash);
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
      state = await (await call(`/v1/requests/${digest}`)).json();
      assert.equal(state.transactionHash, hash);
      assert.equal(state.observation?.reason, 'not_indexed');
      assert.deepEqual(state.priorTransactionHashes, []);
      const completeLogs = rpc.values.eth_getTransactionReceipt.logs;
      rpc.values.eth_getTransactionReceipt.logs = [null];
      transactionIndexed = true;
      const logDeadline = Date.now() + 12_000;
      while (
        Date.now() < logDeadline &&
        (state.status !== 'submitted' ||
          state.observation?.reason !== 'rpc_unavailable')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await (await call(`/v1/requests/${digest}`)).json();
      }
      assert.equal(state.status, 'submitted', JSON.stringify(state));
      assert.equal(state.observation?.reason, 'rpc_unavailable');
      assert.equal(state.transactionHash, hash);
      assert.deepEqual(state.priorTransactionHashes, []);
      rpc.values.eth_getTransactionReceipt.logs = completeLogs;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && state.status !== 'confirmed') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await (await call(`/v1/requests/${digest}`)).json();
      }
      assert.equal(
        state.status,
        'confirmed',
        JSON.stringify({ state, observedMethods, outboundErrors }),
      );
      assert.equal(state.observation.blockNumber, '16');
      assert.equal(state.leaseId, undefined);
      assert.equal(
        (
          await call(`/v1/requests/${digest}/transactions`, {
            method: 'POST',
            body: { transactionHash: hash },
          })
        ).status,
        202,
      );
      const storage = await mf.unsafeGetDurableObjectStorage(
        'issuance-test',
        'IssuanceTenantCoordinator',
        { name: tenantName },
      );
      const rows = await storage.exec(
        'SELECT state FROM requests WHERE id = ?',
        digest,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state.includes(signature), false);
      const events = await storage.exec(
        'SELECT sequence, status FROM events WHERE request_id = ? ORDER BY sequence',
        digest,
      );
      assert.equal(events[0].status, 'awaiting_submission');
      assert.equal(events.at(-1).status, 'confirmed');
      assert.equal(
        new Set(events.map((event) => event.sequence)).size,
        events.length,
      );
      // Resume a persisted near-exhaustion checkpoint, then verify a corrected reference.
      const second = domain.module.parseIssuanceRequest({
        ...request,
        requestId: `0x${'91'.repeat(32)}`,
        nonce: '1',
      });
      const secondId = domain.module.getIssuanceRequestDigest(second);
      const secondSignature = await account.signTypedData(
        domain.module.getIssuanceRequestTypedData(second),
      );
      assert.equal(
        (
          await call('/v1/requests', {
            method: 'POST',
            body: { request: second, holderSignature: secondSignature },
          })
        ).status,
        200,
      );
      indexed = false;
      const droppedHash = `0x${'88'.repeat(32)}`;
      assert.equal(
        (
          await call(`/v1/requests/${secondId}/transactions`, {
            method: 'POST',
            body: { transactionHash: droppedHash },
          })
        ).status,
        202,
      );
      const secondStorage = await mf.unsafeGetDurableObjectStorage(
        'issuance-test',
        'IssuanceTenantCoordinator',
        { name: tenantName },
      );
      const checkpoint = JSON.parse(
        (
          await secondStorage.exec(
            'SELECT state FROM requests WHERE id = ?',
            secondId,
          )
        )[0].state,
      );
      checkpoint.attempts = 23;
      await secondStorage.exec(
        'UPDATE requests SET state = ? WHERE id = ?',
        JSON.stringify(checkpoint),
        secondId,
      );
      let secondState;
      const exhaustedBy = Date.now() + 4_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 100));
        secondState = await (await call(`/v1/requests/${secondId}`)).json();
      } while (
        secondState.status !== 'attention_required' &&
        Date.now() < exhaustedBy
      );
      assert.equal(secondState.status, 'attention_required');
      assert.equal(secondState.transactionHash, droppedHash);
      assert.equal(secondState.observation.outcome, 'pending');
      assert.equal(
        (await call(`/v1/requests/${secondId}/reconcile`, { method: 'POST' }))
          .status,
        429,
      );
      const cooled = JSON.parse(
        (
          await secondStorage.exec(
            'SELECT state FROM requests WHERE id = ?',
            secondId,
          )
        )[0].state,
      );
      cooled.updatedAt -= 61_000;
      await secondStorage.exec(
        'UPDATE requests SET state = ? WHERE id = ?',
        JSON.stringify(cooled),
        secondId,
      );
      assert.equal(
        (await call(`/v1/requests/${secondId}/reconcile`, { method: 'POST' }))
          .status,
        202,
      );
      assert.equal(
        (
          await call(`/v1/requests/${secondId}/transactions`, {
            method: 'POST',
            body: { transactionHash: hash },
          })
        ).status,
        409,
      );
      rpc = rpcFixture(second, secondId, observer.module.issuanceEvent);
      indexed = true;
      const correction = await call(`/v1/requests/${secondId}/transactions`, {
        method: 'POST',
        body: { transactionHash: hash },
      });
      assert.equal(correction.status, 202, await correction.clone().text());
      const corrected = await correction.json();
      assert.equal(corrected.status, 'confirmed');
      assert.equal(corrected.transactionHash, hash);
      assert.deepEqual(corrected.priorTransactionHashes, [droppedHash]);
      assert.equal(
        (await call(`/v1/requests/${secondId}/cancel`, { method: 'POST' }))
          .status,
        409,
      );

      // A complete but incorrect RPC observation can be repaired later. Rechecking
      // that same hash must be explicit, rate limited and durable across restart.
      const third = domain.module.parseIssuanceRequest({
        ...request,
        requestId: `0x${'92'.repeat(32)}`,
        nonce: '2',
      });
      const thirdId = domain.module.getIssuanceRequestDigest(third);
      const thirdSignature = await account.signTypedData(
        domain.module.getIssuanceRequestTypedData(third),
      );
      const rejectedHash = `0x${'77'.repeat(32)}`;
      rpc = rpcFixture(third, thirdId, observer.module.issuanceEvent);
      rpc.values.eth_getTransactionReceipt.transactionHash = rejectedHash;
      rpc.values.eth_getTransactionByHash.hash = rejectedHash;
      rpc.values.eth_getTransactionReceipt.logs[0].transactionHash =
        rejectedHash;
      const correctedLogs = rpc.values.eth_getTransactionReceipt.logs;
      rpc.values.eth_getTransactionReceipt.logs = [];
      assert.equal(
        (
          await call('/v1/requests', {
            method: 'POST',
            body: { request: third, holderSignature: thirdSignature },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(`/v1/requests/${thirdId}/transactions`, {
            method: 'POST',
            body: { transactionHash: rejectedHash },
          })
        ).status,
        202,
      );
      let thirdState;
      const rejectedBy = Date.now() + 4_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 100));
        thirdState = await (await call(`/v1/requests/${thirdId}`)).json();
      } while (thirdState.status !== 'rejected' && Date.now() < rejectedBy);
      assert.equal(thirdState.status, 'rejected');
      assert.equal(thirdState.observation.reason, 'issuance_mismatch');
      assert.equal(thirdState.transactionHash, rejectedHash);
      rpc.values.eth_getTransactionReceipt.logs = correctedLogs;
      const readsBeforeReconcile = observedMethods.length;
      const sameHash = await call(`/v1/requests/${thirdId}/transactions`, {
        method: 'POST',
        body: { transactionHash: rejectedHash },
      });
      assert.equal(sameHash.status, 202);
      assert.equal((await sameHash.json()).status, 'rejected');
      assert.equal(observedMethods.length, readsBeforeReconcile);
      assert.equal(
        (
          await call(`/v1/requests/${thirdId}/reconcile`, {
            method: 'POST',
            subject: 'other-holder',
          })
        ).status,
        404,
      );
      assert.equal(
        (await call(`/v1/requests/${thirdId}/reconcile`, { method: 'POST' }))
          .status,
        429,
      );
      const thirdStorage = await mf.unsafeGetDurableObjectStorage(
        'issuance-test',
        'IssuanceTenantCoordinator',
        { name: tenantName },
      );
      const rejectedCheckpoint = JSON.parse(
        (
          await thirdStorage.exec(
            'SELECT state FROM requests WHERE id = ?',
            thirdId,
          )
        )[0].state,
      );
      rejectedCheckpoint.updatedAt -= 61_000;
      await thirdStorage.exec(
        'UPDATE requests SET state = ? WHERE id = ?',
        JSON.stringify(rejectedCheckpoint),
        thirdId,
      );
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
      const resumed = await call(`/v1/requests/${thirdId}/reconcile`, {
        method: 'POST',
      });
      assert.equal(resumed.status, 202, await resumed.clone().text());
      const resumedState = await resumed.json();
      assert.equal(resumedState.status, 'submitted');
      assert.equal(resumedState.transactionHash, rejectedHash);
      assert.equal(resumedState.attempts, 0);
      const reobservedBy = Date.now() + 4_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 100));
        thirdState = await (await call(`/v1/requests/${thirdId}`)).json();
      } while (thirdState.status !== 'confirmed' && Date.now() < reobservedBy);
      assert.equal(thirdState.status, 'confirmed');
      assert.equal(thirdState.transactionHash, rejectedHash);
      assert.deepEqual(thirdState.priorTransactionHashes, []);
      const restoredStorage = await mf.unsafeGetDurableObjectStorage(
        'issuance-test',
        'IssuanceTenantCoordinator',
        { name: tenantName },
      );
      const reobservedEvents = await restoredStorage.exec(
        'SELECT sequence, status FROM events WHERE request_id = ? ORDER BY sequence',
        thirdId,
      );
      assert.ok(reobservedEvents.some((event) => event.status === 'rejected'));
      assert.equal(reobservedEvents.at(-1).status, 'confirmed');
      assert.ok(
        observedMethods.every((method) => !method.startsWith('eth_send')),
      );
    } finally {
      await mf?.dispose();
      await domain.cleanup();
      await observer.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
