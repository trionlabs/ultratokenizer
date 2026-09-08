import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  bundleModule,
  chainConfig,
  requestFixture,
  rpcFixture,
  hash,
} from './helpers.mjs';

const observer = await bundleModule('../src/chain-observer.ts');
const domain = await bundleModule('../../../packages/domain/src/index.ts');
after(async () => {
  await observer.cleanup();
  await domain.cleanup();
});
const { observeIssuance, issuanceEvent } = observer.module;
const request = domain.module.parseIssuanceRequest(requestFixture);
const digest = domain.module.getIssuanceRequestDigest(request);

void test('confirms only a canonical matching event from the pinned gate bytecode', async () => {
  const rpc = rpcFixture(request, digest, issuanceEvent);
  const result = await observeIssuance(request, hash, chainConfig, rpc.fetcher);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.blockNumber, '16');
  assert.equal(result.logIndex, '0');
  assert.ok(rpc.calls.every((call) => !call.method.startsWith('eth_send')));
});

void test('missing receipts, insufficient finality and reorganized blocks remain uncertain', async () => {
  for (const mutate of [
    (rpc) => {
      rpc.eth_getTransactionReceipt = null;
    },
    (rpc) => {
      rpc.eth_blockNumber = '0x10';
    },
    (rpc) => {
      rpc.eth_getBlockByNumber.hash = `0x${'ee'.repeat(32)}`;
    },
    (rpc) => {
      rpc.eth_getTransactionReceipt.logs[0].removed = true;
    },
    (rpc) => {
      rpc.eth_chainId = '0x1';
    },
  ]) {
    const rpc = rpcFixture(request, digest, issuanceEvent, mutate);
    assert.equal(
      (await observeIssuance(request, hash, chainConfig, rpc.fetcher)).outcome,
      'pending',
    );
  }
});

void test('a relayer may call internally when the exact pinned gate emits the matching event', async () => {
  const rpc = rpcFixture(request, digest, issuanceEvent, (values) => {
    values.eth_getTransactionByHash.to = request.token;
    values.eth_getTransactionReceipt.to = request.token;
  });
  assert.equal(
    (await observeIssuance(request, hash, chainConfig, rpc.fetcher)).outcome,
    'confirmed',
  );
});

void test('wrong contracts, bytecode, successful transactions without issuance, and duplicates reject', async () => {
  for (const mutate of [
    (rpc) => {
      rpc.eth_getTransactionByHash.to = request.token;
    },
    (rpc) => {
      rpc.eth_getCode = '0x60016001';
    },
    (rpc) => {
      rpc.eth_getTransactionReceipt.logs = [];
    },
    (rpc) => {
      rpc.eth_getTransactionReceipt.logs.push(
        rpc.eth_getTransactionReceipt.logs[0],
      );
    },
    (rpc) => {
      rpc.eth_getTransactionReceipt.status = '0x0';
    },
  ]) {
    const rpc = rpcFixture(request, digest, issuanceEvent, mutate);
    assert.equal(
      (await observeIssuance(request, hash, chainConfig, rpc.fetcher)).outcome,
      'rejected',
    );
  }
});

void test('changed recipient, quantity, policy and claim cannot reuse a transaction receipt', async () => {
  const original = rpcFixture(request, digest, issuanceEvent);
  for (const changed of [
    { ...request, amount: '2' },
    { ...request, recipient: request.token },
    { ...request, policyVersion: '2' },
    { ...request, claimUsageId: `0x${'ff'.repeat(32)}` },
  ]) {
    assert.equal(
      (await observeIssuance(changed, hash, chainConfig, original.fetcher))
        .outcome,
      'rejected',
    );
  }
});

void test('unavailable, oversized and malformed provider replies never create confirmed or failed issuance', async () => {
  for (const fetcher of [
    async () => {
      throw new Error('secret provider detail');
    },
    async () => new Response('unavailable', { status: 503 }),
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.invalid/' },
      }),
    async () => new Response('x'.repeat(524_289)),
    async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { message: 'provider details' },
      }),
    async () => Response.json({ jsonrpc: '2.0', id: 2, result: '0x128' }),
  ]) {
    assert.deepEqual(
      await observeIssuance(request, hash, chainConfig, fetcher),
      { outcome: 'pending', reason: 'rpc_unavailable' },
    );
  }
});

void test('missing deployment configuration fails closed before any RPC', async () => {
  await assert.rejects(
    observeIssuance(request, hash, { ...chainConfig, codeHash: '' }, () => {
      throw new Error('Must not call.');
    }),
    { message: 'not_configured' },
  );
});
