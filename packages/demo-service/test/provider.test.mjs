import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getIssuanceRequestDigest,
  getIssuerPermitTypedData,
  parseIssuanceRequest,
} from '../../../dist/domain/src/index.js';
import {
  ISSUANCE_GATE_ABI,
  IssuanceClientError,
} from '../../issuance/dist/index.js';
import { credential, issuerProvider } from '../src/issuer-provider.mjs';
import { RuntimeAdapter, reservationFailure } from '../src/runtime.mjs';

const testKey = `0x${'11'.repeat(32)}`;
const issuer = privateKeyToAccount(testKey);
const sample = JSON.parse(
  await readFile(
    new URL('../../domain/fixtures/request.synthetic.json', import.meta.url),
    'utf8',
  ),
);
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'ut-demo-issuer-'));
  await writeFile(join(folder, 'test.env'), `TEST_ISSUER_KEY=${testKey}\n`, {
    mode: 0o600,
  });
  t.after(() => rm(folder, { recursive: true, force: true }));
  const request = parseIssuanceRequest({ ...sample, amount: '1000' });
  const job = { request, requestDigest: getIssuanceRequestDigest(request) };
  let sends = 0;
  const runtime = {
    root: folder,
    config: {
      issuerCredential: { path: 'test.env', variable: 'TEST_ISSUER_KEY' },
      maxReservationFeeTinybar: '1000',
    },
    policy: {
      issuerAddress: issuer.address,
      gate: request.gate,
      issuerKeyVersion: '1',
    },
    assertOperationsEnabled: async () => {},
    reader: {
      getChainId: async () => 296,
      getTransactionCount: async () => 9,
      estimateGas: async () => 100000n,
      getGasPrice: async () => 1n,
      sendRawTransaction: async ({ serializedTransaction }) => {
        sends += 1;
        assert.equal(
          await recoverTransactionAddress({ serializedTransaction }),
          issuer.address,
        );
        const decoded = parseTransaction(serializedTransaction);
        assert.equal(decoded.chainId, 296);
        assert.equal(decoded.nonce, 9);
        return keccak256(serializedTransaction);
      },
    },
  };
  const data = encodeFunctionData({
    abi: ISSUANCE_GATE_ABI,
    functionName: 'openReservation',
    args: [
      request.issuerId,
      1n,
      request.reservationId,
      request.recipient,
      request.token,
      1000n,
      BigInt(request.validUntil),
      job.requestDigest,
      request.claimUsageId,
    ],
  });
  const call = {
    method: 'eth_sendTransaction',
    params: [{ from: issuer.address, to: request.gate, data, value: '0x0' }],
  };
  return { folder, runtime, job, call, sends: () => sends };
}
await test('issuer signs and dispatches only the exact reservation, recording intent first', async (t) => {
  const f = await fixture(t);
  const provider = issuerProvider(f.runtime, f.job, f.folder);
  const sent = await provider.request(f.call);
  const signed = JSON.parse(
    await readFile(join(f.folder, 'reservation-send.signed.json'), 'utf8'),
  );
  assert.equal(sent, signed.expectedHash);
  assert.equal(f.sends(), 1);
  const intent = JSON.parse(
    await readFile(join(f.folder, 'reservation-send.intent.json'), 'utf8'),
  );
  assert.equal(intent.requestDigest, f.job.requestDigest);
  await assert.rejects(provider.request(f.call), {
    code: 'reservation_uncertain',
  });
  await assert.rejects(
    issuerProvider(f.runtime, f.job, f.folder).request(f.call),
    { code: 'reservation_uncertain' },
  );
  assert.equal(f.sends(), 1);
});
await test('foreign calldata, chain mismatch and excessive gas costs never dispatch', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    issuerProvider(f.runtime, f.job, f.folder).request({
      ...f.call,
      params: [{ ...f.call.params[0], data: '0x00' }],
    }),
    { code: 'issuer_unavailable' },
  );
  f.runtime.reader.getChainId = async () => 1;
  await assert.rejects(
    issuerProvider(f.runtime, f.job, f.folder).request(f.call),
    { code: 'deployment_unavailable' },
  );
  f.runtime.reader.getChainId = async () => 296;
  f.runtime.reader.getGasPrice = async () => 10n ** 18n;
  await assert.rejects(
    issuerProvider(f.runtime, f.job, f.folder).request(f.call),
    { code: 'issuer_unavailable' },
  );
  assert.equal(f.sends(), 0);
});
await test('issuer permit signature cryptographically binds the existing request and nonce', async (t) => {
  const f = await fixture(t);
  const permit = {
    requestDigest: f.job.requestDigest,
    issuerId: f.job.request.issuerId,
    keyVersion: '1',
    nonce: '123',
    validUntil: f.job.request.validUntil,
  };
  const typed = getIssuerPermitTypedData(f.job.request, permit);
  const serialized = JSON.stringify(typed, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value,
  );
  const signature = await issuerProvider(f.runtime, f.job, f.folder, {
    permitNonce: '123',
  }).request({
    method: 'eth_signTypedData_v4',
    params: [issuer.address, serialized],
  });
  assert.equal(
    await recoverTypedDataAddress({ ...typed, signature }),
    issuer.address,
  );
  assert.ok(hashTypedData(typed));
  assert.equal(f.sends(), 0);
  await assert.rejects(
    issuerProvider(f.runtime, f.job, f.folder, { permitNonce: '124' }).request({
      method: 'eth_signTypedData_v4',
      params: [issuer.address, serialized],
    }),
    { code: 'issuer_unavailable' },
  );
});
await test('terms are marked checked only against matching canonical Gate data', async () => {
  const r = new RuntimeAdapter('', {});
  const termsHash = `0x${'44'.repeat(32)}`;
  r.issuer = {};
  r.terms = { policy: { hash: termsHash }, rights: { hash: termsHash } };
  r.policy = {
    gate: sample.gate,
    issuerId: sample.issuerId,
    policyVersion: '2',
    rightsVersion: '1',
    sourceId: termsHash,
    token: sample.token,
  };
  r.deployment = { gateCodeHash: keccak256('0x6000') };
  r.readiness = async () => ({ canStart: true });
  r.reader = {
    getChainId: async () => 296,
    getBlock: async () => ({ number: 10n, hash: termsHash }),
    getCode: async () => '0x6000',
    readContract: async ({ functionName }) =>
      functionName === 'policies'
        ? [1n, termsHash, 2n, termsHash, false]
        : [sample.token, 1n, 0n, termsHash, false],
  };
  assert.equal((await r.configuration()).terms.checked, true);
  r.reader.getCode = async () => '0x6001';
  const bad = await r.configuration();
  assert.equal(bad.terms.checked, false);
  assert.equal(bad.readiness.canStart, false);
});

// A full backing pool is a read-only rejection: openPreparedReservation raises
// it from its preflight, before signing or broadcasting. Latching the issuer's
// nonce stream on it would make one oversized document stop reservations for
// every later document until the process restarts.
await test('a full backing pool does not latch the reservation lane', () => {
  const adapter = new RuntimeAdapter('/nowhere', {});
  assert.equal(adapter.reservationUncertain, false);
  assert.equal(
    reservationFailure(new IssuanceClientError('capacity_exceeded')),
    'capacity_exceeded',
  );
});

await test('any other reservation failure latches the nonce stream', () => {
  for (const error of [
    new IssuanceClientError('transaction_uncertain'),
    new Error('socket hang up'),
    undefined,
  ])
    assert.equal(reservationFailure(error), 'reservation_uncertain');
});

// The credential path comes from configuration, so it must not be able to walk
// out of the service root and read an arbitrary file as an issuer key.
await test('the issuer credential path cannot escape the service root', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'ut-demo-confined-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'test.env'), `TEST_ISSUER_KEY=${testKey}\n`, {
    mode: 0o600,
  });
  const outside = join(folder, 'outside.env');
  await writeFile(outside, `TEST_ISSUER_KEY=${testKey}\n`, { mode: 0o600 });
  const inner = join(folder, 'root');
  await mkdir(inner, { recursive: true });
  await writeFile(join(inner, 'test.env'), `TEST_ISSUER_KEY=${testKey}\n`, {
    mode: 0o600,
  });

  assert.equal(
    await credential(inner, { path: 'test.env', variable: 'TEST_ISSUER_KEY' }),
    testKey,
  );
  for (const path of ['../outside.env', outside, './../outside.env'])
    await assert.rejects(
      credential(inner, { path, variable: 'TEST_ISSUER_KEY' }),
      `escaped the root with ${path}`,
    );
});
