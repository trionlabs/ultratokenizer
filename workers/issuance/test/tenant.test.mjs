import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleModule, chainConfig, requestFixture, hash } from './helpers.mjs';

const RETENTION = 7 * 24 * 60 * 60 * 1000;

// Exercise the real coordinator and durable SQLite through a test-only RPC
// gateway. Authentication and production tenant routing have separate tests.
async function runtime(
  outboundService = () => {
    throw new Error('No RPC expected');
  },
) {
  const dir = await mkdtemp(join(tmpdir(), 'ultratokenizer-tenant-'));
  const domain = await bundleModule('../../../packages/domain/src/index.ts');
  const code = await build({
    stdin: {
      contents: `import { IssuanceTenantCoordinator, IssuanceCoordinator } from './src/coordinator.ts';
export { IssuanceTenantCoordinator, IssuanceCoordinator };
export default { async fetch(request, env) {
  const { action, args } = await request.json();
  const stub = env.TENANTS.getByName('tenant');
  try {
    const result = await stub[action](...args);
    try { return Response.json(result); }
    finally { result?.[Symbol.dispose]?.(); }
  }
  catch (error) { return Response.json({ error: error.code ?? 'unavailable' }, { status: error.status ?? 503 }); }
  finally { stub[Symbol.dispose]?.(); }
} };`,
      resolveDir: new URL('..', import.meta.url).pathname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:workers'],
    logLevel: 'silent',
  });
  const options = {
    workers: [
      {
        name: 'tenant-test',
        modules: true,
        script: code.outputFiles[0].text,
        compatibilityDate: '2026-09-08',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          TENANTS: { className: 'IssuanceTenantCoordinator', useSQLite: true },
        },
        bindings: {
          CHAIN_ID: chainConfig.chainId,
          GATE_ADDRESS: chainConfig.gate,
          GATE_CODE_HASH: chainConfig.codeHash,
          RPC_URL: chainConfig.rpcUrl,
          MIN_CONFIRMATIONS: '2',
        },
        outboundService: async (request) => {
          assert.equal(request.url, chainConfig.rpcUrl);
          return outboundService(request);
        },
      },
    ],
    cf: false,
    telemetry: { enabled: false },
    log: new Log(LogLevel.ERROR),
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: dir,
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
  return {
    async call(action, ...args) {
      const response = await mf.dispatchFetch(
        'https://tenant.synthetic.invalid/',
        {
          method: 'POST',
          body: JSON.stringify({ action, args }),
        },
      );
      return new Response(await response.text(), { status: response.status });
    },
    async storage() {
      return mf.unsafeGetDurableObjectStorage(
        'tenant-test',
        'IssuanceTenantCoordinator',
        { name: 'tenant' },
      );
    },
    request(index) {
      return domain.module.parseIssuanceRequest({
        ...requestFixture,
        requestId: `0x${index.toString(16).padStart(64, '0')}`,
        nonce: String(index),
        validUntil: String(Math.floor(Date.now() / 1000) + 3600),
      });
    },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      await mf.ready;
    },
    async diskRows(query) {
      await mf.dispose();
      const files = (await readdir(dir, { recursive: true })).filter((file) =>
        file.endsWith('.sqlite'),
      );
      for (const file of files) {
        const database = new DatabaseSync(join(dir, file), { readOnly: true });
        try {
          if (
            database
              .prepare("SELECT name FROM sqlite_master WHERE name = 'requests'")
              .get()
          )
            return database
              .prepare(query)
              .all()
              .map((row) => ({ ...row }));
        } finally {
          database.close();
        }
      }
      assert.fail('Tenant SQLite database was not found');
    },
    async close() {
      await mf.dispose();
      await domain.cleanup();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function rows(storage) {
  return (await storage.exec('SELECT state FROM requests')).map((row) =>
    JSON.parse(row.state),
  );
}
async function checkpoint(storage, state) {
  await storage.exec(
    'UPDATE requests SET state = ? WHERE id = ?',
    JSON.stringify(state),
    state.id,
  );
}
async function eventually(check, maximum = 6_000) {
  const until = Date.now() + maximum;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.fail('Expected durable state before deadline');
}

void test(
  'tenant quotas serialize admission, release open slots once, and clean retained records after restart',
  { timeout: 45_000 },
  async () => {
    const r = await runtime();
    try {
      const requests = Array.from({ length: 40 }, (_, index) =>
        r.request(index + 1),
      );
      const admission = await Promise.all(
        requests.map((request, index) =>
          r.call('create', `owner-${index}`, request),
        ),
      );
      assert.equal(
        admission.filter((response) => response.status === 200).length,
        32,
      );
      assert.equal(
        admission.filter((response) => response.status === 429).length,
        8,
      );
      let storage = await r.storage();
      let retained = await rows(storage);
      assert.equal(retained.length, 32);
      const first = retained[0];
      assert.equal(
        (await r.call('inspect', 'foreign-owner', first.id)).status,
        404,
      );
      const retry = await r.call('create', first.ownerId, first.request);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).revision, 1);
      assert.equal((await rows(storage)).length, 32);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          r.call('cancel', first.ownerId, first.id),
        ),
      );
      await storage.exec(
        "CREATE TRIGGER fail_admission BEFORE INSERT ON events WHEN NEW.status = 'awaiting_submission' BEGIN SELECT RAISE(ABORT, 'synthetic admission failure'); END",
      );
      assert.equal(
        (await r.call('create', 'fresh', r.request(100))).status,
        503,
      );
      assert.equal((await rows(storage)).length, 32);
      await storage.exec('DROP TRIGGER fail_admission');
      assert.equal(
        (await r.call('create', 'fresh', r.request(100))).status,
        200,
      );
      assert.equal(
        (await r.call('create', 'extra', r.request(101))).status,
        429,
      );
      retained = await rows(storage);
      assert.equal(retained.length, 33);
      assert.equal(
        retained.filter((state) => state.status === 'tracking_cancelled')
          .length,
        1,
      );
      // Build retained capacity through real terminal transitions, not a counter seed.
      await Promise.all(
        retained.map((state) => r.call('cancel', state.ownerId, state.id)),
      );
      for (let base = 200; base < 295; base += 32) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(32, 295 - base) }, (_, offset) =>
            r.call(
              'create',
              `holder-${base + offset}`,
              r.request(base + offset),
            ),
          ),
        );
        for (const [offset, response] of batch.entries()) {
          assert.equal(response.status, 200, await response.clone().text());
          const state = await response.json();
          assert.equal(
            (await r.call('cancel', `holder-${base + offset}`, state.id))
              .status,
            200,
          );
        }
      }
      retained = await rows(storage);
      assert.equal(retained.length, 128);
      const eventCount = (
        await storage.exec('SELECT COUNT(*) AS count FROM events')
      )[0].count;
      assert.equal(eventCount, 256);
      console.info(
        JSON.stringify({
          measurement: 'synthetic_tenant_at_retained_cap',
          requests: retained.length,
          events: eventCount,
          stateJsonBytes: (
            await storage.exec(
              'SELECT SUM(length(CAST(state AS BLOB))) AS bytes FROM requests',
            )
          )[0].bytes,
        }),
      );
      assert.equal(
        retained.filter((state) => state.status !== 'tracking_cancelled')
          .length,
        0,
      );
      assert.equal(
        (await r.call('create', 'holder', r.request(500))).status,
        429,
      );
      // Exact TTL is absolute createdAt, including terminals. A read must not renew it.
      const expiry = Date.now() + 2_500;
      for (const state of retained)
        await checkpoint(storage, { ...state, createdAt: expiry - RETENTION });
      assert.equal(
        (await r.call('inspect', first.ownerId, first.id)).status,
        200,
      );
      await r.restart();
      storage = await r.storage();
      // No request call is needed to trigger cleanup after restart.
      await eventually(async () => (await rows(storage)).length === 0);
      assert.equal(
        (await storage.exec('SELECT COUNT(*) AS count FROM events'))[0].count,
        0,
      );
      assert.equal(
        (await r.call('inspect', first.ownerId, first.id)).status,
        404,
      );
      assert.equal(
        (await r.call('create', 'holder', r.request(501))).status,
        200,
      );
    } finally {
      await r.close();
    }
  },
);

void test(
  'subject quotas prevent open and retained monopolies without blocking recovery or another subject',
  { timeout: 30_000 },
  async () => {
    const r = await runtime();
    try {
      const burst = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          r.call('create', 'holder', r.request(index + 1)),
        ),
      );
      assert.equal(
        burst.filter((response) => response.status === 200).length,
        8,
      );
      assert.equal(
        burst.filter((response) => response.status === 429).length,
        4,
      );
      assert.equal(
        (await r.call('create', 'other-holder', r.request(50))).status,
        200,
      );
      await r.restart();
      let storage = await r.storage();
      const first = (await rows(storage)).find(
        (state) => state.ownerId === 'holder',
      );
      const retry = await r.call('create', 'holder', first.request);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).revision, 1);
      assert.equal(
        (await r.call('create', 'holder', r.request(100))).status,
        429,
      );
      // Concurrent cancellation retries release only one subject open slot.
      const cancellations = await Promise.all(
        Array.from({ length: 8 }, () => r.call('cancel', 'holder', first.id)),
      );
      assert.ok(cancellations.every((response) => response.status === 200));
      const replacements = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          r.call('create', 'holder', r.request(100 + index)),
        ),
      );
      assert.equal(
        replacements.filter((response) => response.status === 200).length,
        1,
      );
      assert.equal(
        replacements.filter((response) => response.status === 429).length,
        7,
      );
      let subjectRows = (await rows(storage)).filter(
        (state) => state.ownerId === 'holder',
      );
      assert.equal(subjectRows.length, 9);
      for (const state of subjectRows)
        assert.equal((await r.call('cancel', 'holder', state.id)).status, 200);

      // Cancellation frees open capacity, but cannot bypass retained capacity.
      for (let index = 0; index < 23; index++) {
        const created = await r.call(
          'create',
          'holder',
          r.request(200 + index),
        );
        assert.equal(created.status, 200);
        const state = await created.json();
        assert.equal((await r.call('cancel', 'holder', state.id)).status, 200);
      }
      subjectRows = (await rows(storage)).filter(
        (state) => state.ownerId === 'holder',
      );
      assert.equal(subjectRows.length, 32);
      assert.ok(
        subjectRows.every((state) => state.status === 'tracking_cancelled'),
      );
      assert.equal(
        (await r.call('create', 'holder', r.request(300))).status,
        429,
      );
      assert.equal(
        (await r.call('create', 'holder', first.request)).status,
        200,
      );
      assert.equal(
        (await r.call('create', 'other-holder', r.request(301))).status,
        200,
      );

      // Absolute retention restores that subject's capacity without clearing others.
      const expiry = Date.now() + 1_500;
      for (const state of subjectRows)
        await checkpoint(storage, { ...state, createdAt: expiry - RETENTION });
      assert.equal((await r.call('inspect', 'holder', first.id)).status, 200);
      await r.restart();
      storage = await r.storage();
      await eventually(async () => (await rows(storage)).length === 2);
      assert.ok(
        (await rows(storage)).every(
          (state) => state.ownerId === 'other-holder',
        ),
      );
      assert.equal((await r.call('inspect', 'holder', first.id)).status, 404);
      assert.equal(
        (await r.call('create', 'holder', r.request(300))).status,
        200,
      );
    } finally {
      await r.close();
    }
  },
);

void test(
  'tenant leases bound concurrent checks and recover exhausted work without a twenty-fifth attempt',
  { timeout: 30_000 },
  async () => {
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let blocked = 0;
    let calls = 0;
    const r = await runtime(async (request) => {
      const input = await request.json();
      calls++;
      assert.ok(!input.method.startsWith('eth_send'));
      if (input.method === 'eth_chainId') {
        blocked++;
        await barrier;
      }
      return Response.json({
        jsonrpc: '2.0',
        id: input.id,
        result: input.method === 'eth_chainId' ? '0x128' : null,
      });
    });
    try {
      const states = [];
      for (let index = 1; index <= 5; index++) {
        const created = await r.call('create', 'holder', r.request(index));
        assert.equal(created.status, 200);
        const state = await created.json();
        states.push(state);
        assert.equal(
          (await r.call('submit', 'holder', state.id, hash)).status,
          200,
        );
      }
      let storage = await r.storage();
      const expiry = Date.now() + 2_000;
      for (const state of await rows(storage)) {
        const firstBatch = state.id !== states[4].id;
        await checkpoint(storage, {
          ...state,
          nextCheckAt: Date.now() + (firstBatch ? 0 : 2_500),
          createdAt: firstBatch ? expiry - RETENTION : state.createdAt,
        });
      }
      await eventually(async () => {
        // Polling exercises the guarantee that reads cannot postpone a due alarm.
        await r.call('inspect', 'holder', states[0].id);
        return blocked === 4;
      });
      let saved = await rows(storage);
      assert.equal(saved.filter((state) => state.leaseId !== null).length, 4);
      const waiting = saved.find((state) => state.leaseId === null);
      assert.ok(waiting);
      const before = calls;
      assert.equal(
        (await r.call('submit', 'holder', waiting.id, `0x${'fe'.repeat(32)}`))
          .status,
        429,
      );
      assert.equal(calls, before);
      // Logical retention expiry must not erase the durable lease while its
      // observer is still running and admit another four external checks.
      const retiring = saved.filter((state) => state.leaseId !== null);
      // Age was checkpointed before leasing; changing createdAt during a lease
      // would correctly fence its completion as a different tracking lifetime.
      await eventually(async () => Date.now() >= expiry);
      assert.equal((await r.call('inspect', 'holder', waiting.id)).status, 200);
      assert.equal((await rows(storage)).length, 5);
      assert.equal(
        (await rows(storage)).filter((state) => state.leaseId !== null).length,
        4,
      );
      assert.equal(
        (await r.call('inspect', 'holder', retiring[0].id)).status,
        404,
      );
      assert.equal(
        (await r.call('create', 'holder', retiring[0].request)).status,
        429,
      );
      assert.equal(
        (await r.call('submit', 'holder', waiting.id, `0x${'fe'.repeat(32)}`))
          .status,
        429,
      );
      assert.equal(calls, before);
      release();
      await eventually(async () =>
        (await rows(storage)).every(
          (state) => state.attempts >= 1 && state.leaseId === null,
        ),
      );
      await eventually(async () => (await rows(storage)).length === 1);
      saved = await rows(storage);
      // Model an interrupted last attempt. Restart may recover its lease, but must
      // not acquire another observation after the durable counter has reached 24.
      for (const state of saved)
        await checkpoint(storage, {
          ...state,
          status: 'checking',
          attempts: 24,
          leaseId: `abandoned-${state.id}`,
          leaseUntil: Date.now() + 1_500,
          nextCheckAt: Date.now() + 1_500,
        });
      await r.call('inspect', 'holder', waiting.id);
      await r.restart();
      storage = await r.storage();
      const prior = calls;
      await eventually(async () =>
        (await rows(storage)).every(
          (state) => state.status === 'attention_required',
        ),
      );
      assert.equal(calls, prior);
      assert.ok(
        (await rows(storage)).every(
          (state) => state.attempts === 24 && state.leaseId === null,
        ),
      );
    } finally {
      release();
      await r.close();
    }
  },
);

void test(
  'expired tracking cannot be resurrected by a delayed observer after re-registration',
  { timeout: 15_000 },
  async () => {
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const r = await runtime(async (request) => {
      const input = await request.json();
      calls++;
      if (input.method === 'eth_chainId') await barrier;
      return Response.json({
        jsonrpc: '2.0',
        id: input.id,
        result: input.method === 'eth_chainId' ? '0x128' : null,
      });
    });
    try {
      const request = r.request(1);
      const first = await (await r.call('create', 'holder', request)).json();
      const second = await (
        await r.call('create', 'holder', r.request(2))
      ).json();
      const storage = await r.storage();
      const original = (await rows(storage)).find(
        (state) => state.id === first.id,
      );
      const expiry = Date.now() + 2_500;
      await checkpoint(storage, { ...original, createdAt: expiry - RETENTION });
      assert.equal(
        (await r.call('submit', 'holder', first.id, hash)).status,
        200,
      );
      await eventually(async () => calls === 1);
      await eventually(async () => Date.now() >= expiry);
      // Simulate overdue/crashed work whose lease has also expired; its late
      // result must still be fenced after cleanup and a new registration.
      const leased = (await rows(storage)).find(
        (state) => state.id === first.id,
      );
      await checkpoint(storage, { ...leased, leaseUntil: Date.now() - 1 });
      assert.equal((await r.call('inspect', 'holder', second.id)).status, 200);
      assert.equal(
        (await rows(storage)).some((state) => state.id === first.id),
        false,
      );
      const recreated = await (
        await r.call('create', 'holder', request)
      ).json();
      assert.equal(recreated.revision, 1);
      assert.ok(recreated.createdAt >= expiry);
      release();
      await eventually(async () => calls === 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const latest = await (await r.call('inspect', 'holder', first.id)).json();
      assert.equal(latest.status, 'awaiting_submission');
      assert.equal(latest.transactionHash, null);
      assert.equal(latest.createdAt, recreated.createdAt);
      assert.equal(latest.revision, 1);
      assert.equal(
        (
          await storage.exec(
            'SELECT COUNT(*) AS count FROM events WHERE request_id = ?',
            first.id,
          )
        )[0].count,
        1,
      );
    } finally {
      release();
      await r.close();
    }
  },
);

void test(
  'legacy singleton schema fails closed and preserves its existing rows',
  { timeout: 15_000 },
  async () => {
    const r = await runtime();
    try {
      assert.equal(
        (await r.call('create', 'holder', r.request(1))).status,
        200,
      );
      const storage = await r.storage();
      await storage.exec('DROP TABLE requests');
      await storage.exec('DROP TABLE events');
      await storage.exec(
        'CREATE TABLE requests (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)',
      );
      await storage.exec(
        'CREATE TABLE events (sequence INTEGER PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL)',
      );
      await storage.exec(
        'INSERT INTO requests VALUES (1, 7, ?)',
        '{"preserve":"legacy"}',
      );
      await r.restart();
      assert.equal(
        (await r.call('create', 'holder', r.request(2))).status,
        503,
      );
      assert.deepEqual(await r.diskRows('SELECT * FROM requests'), [
        { singleton: 1, revision: 7, state: '{"preserve":"legacy"}' },
      ]);
      assert.deepEqual(
        (await r.diskRows('PRAGMA table_info(requests)')).map(
          (row) => row.name,
        ),
        ['singleton', 'revision', 'state'],
      );
    } finally {
      await r.close();
    }
  },
);
