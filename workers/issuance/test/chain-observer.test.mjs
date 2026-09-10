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

void test('a transaction body may arrive after its receipt and recover under the same hash', async () => {
  const rpc = rpcFixture(request, digest, issuanceEvent);
  const transaction = rpc.values.eth_getTransactionByHash;
  rpc.values.eth_getTransactionByHash = null;
  assert.deepEqual(
    await observeIssuance(request, hash, chainConfig, rpc.fetcher),
    { outcome: 'pending', reason: 'not_indexed' },
  );
  rpc.values.eth_getTransactionByHash = transaction;
  assert.equal(
    (await observeIssuance(request, hash, chainConfig, rpc.fetcher)).outcome,
    'confirmed',
  );
});

void test('incomplete transaction and runtime replies cannot terminally reject a submitted hash', async () => {
  for (const mutate of [
    (rpc) => {
      rpc.eth_getTransactionByHash = {};
    },
    (rpc) => {
      delete rpc.eth_getTransactionByHash.to;
    },
    (rpc) => {
      delete rpc.eth_getTransactionByHash.blockNumber;
    },
    (rpc) => {
      rpc.eth_getTransactionByHash.to = 'not-an-address';
    },
    (rpc) => {
      rpc.eth_getCode = null;
    },
    (rpc) => {
      rpc.eth_getCode = '0x123';
    },
  ]) {
    const rpc = rpcFixture(request, digest, issuanceEvent, mutate);
    assert.deepEqual(
      await observeIssuance(request, hash, chainConfig, rpc.fetcher),
      { outcome: 'pending', reason: 'rpc_unavailable' },
    );
  }
});

void test('late reorganization or chain change overrides every provisional terminal outcome', async () => {
  for (const provisional of [
    'confirmed',
    'wrong-code',
    'wrong-target',
    'reverted',
    'missing-event',
  ]) {
    for (const change of ['reorg', 'chain']) {
      const rpc = rpcFixture(request, digest, issuanceEvent, (values) => {
        if (provisional === 'wrong-code') values.eth_getCode = '0x60016001';
        if (provisional === 'wrong-target')
          values.eth_getTransactionByHash.to = request.token;
        if (provisional === 'reverted')
          values.eth_getTransactionReceipt.status = '0x0';
        if (provisional === 'missing-event')
          values.eth_getTransactionReceipt.logs = [];
      });
      let transitioned = false;
      const fetcher = async (url, init) => {
        const response = await rpc.fetcher(url, init);
        if (JSON.parse(init.body).method === 'eth_getCode' && !transitioned) {
          // Other concurrent replies have captured their old branch. Change the
          // view before the last evidence reply reaches the observer.
          transitioned = true;
          if (change === 'reorg')
            rpc.values.eth_getBlockByNumber.hash = `0x${'ee'.repeat(32)}`;
          else rpc.values.eth_chainId = '0x1';
        }
        return response;
      };
      assert.deepEqual(
        await observeIssuance(request, hash, chainConfig, fetcher),
        {
          outcome: 'pending',
          reason: change === 'reorg' ? 'not_final' : 'rpc_unavailable',
        },
        `${provisional} during ${change}`,
      );
      assert.ok(
        rpc.calls.filter((call) => call.method === 'eth_getBlockByNumber')
          .length >= 2,
      );
      assert.ok(
        rpc.calls.filter((call) => call.method === 'eth_chainId').length >= 2,
      );
    }
  }
});

void test('final canonical evidence that disappears remains pending', async () => {
  const rpc = rpcFixture(request, digest, issuanceEvent);
  let blockReads = 0;
  const fetcher = async (url, init) => {
    if (
      JSON.parse(init.body).method === 'eth_getBlockByNumber' &&
      ++blockReads === 2
    )
      rpc.values.eth_getBlockByNumber = null;
    return rpc.fetcher(url, init);
  };
  assert.deepEqual(await observeIssuance(request, hash, chainConfig, fetcher), {
    outcome: 'pending',
    reason: 'not_final',
  });
});

void test('incomplete receipt logs stay recoverable under the same transaction hash', async () => {
  for (const mutate of [
    (logs) => {
      logs[0] = null;
    },
    (logs) => {
      delete logs[0].address;
    },
    (logs) => {
      delete logs[0].topics;
    },
    (logs) => {
      logs[0].topics = null;
    },
    (logs) => {
      logs[0].topics = [];
    },
    (logs) => {
      logs[0].topics.pop();
    },
    (logs) => {
      delete logs[0].data;
    },
    (logs) => {
      logs[0].data = logs[0].data.slice(0, -2);
    },
    (logs) => {
      delete logs[0].transactionHash;
    },
    (logs) => {
      delete logs[0].blockHash;
    },
    (logs) => {
      delete logs[0].blockNumber;
    },
    (logs) => {
      delete logs[0].logIndex;
    },
    (logs) => {
      delete logs[0].removed;
    },
  ]) {
    const rpc = rpcFixture(request, digest, issuanceEvent);
    const complete = structuredClone(rpc.values.eth_getTransactionReceipt.logs);
    mutate(rpc.values.eth_getTransactionReceipt.logs);
    assert.deepEqual(
      await observeIssuance(request, hash, chainConfig, rpc.fetcher),
      { outcome: 'pending', reason: 'rpc_unavailable' },
    );
    rpc.values.eth_getTransactionReceipt.logs = complete;
    assert.equal(
      (await observeIssuance(request, hash, chainConfig, rpc.fetcher)).outcome,
      'confirmed',
    );
  }
});

void test('complete unrelated logs remain ignorable and decoded conflicting issuance still rejects', async () => {
  const rpc = rpcFixture(request, digest, issuanceEvent);
  const issuance = structuredClone(
    rpc.values.eth_getTransactionReceipt.logs[0],
  );
  const unrelated = {
    ...issuance,
    topics: [`0x${'99'.repeat(32)}`],
    data: '0x',
  };
  rpc.values.eth_getTransactionReceipt.logs = [unrelated];
  assert.deepEqual(
    await observeIssuance(request, hash, chainConfig, rpc.fetcher),
    { outcome: 'rejected', reason: 'issuance_mismatch' },
  );
  rpc.values.eth_getTransactionReceipt.logs = [unrelated, issuance];
  assert.equal(
    (await observeIssuance(request, hash, chainConfig, rpc.fetcher)).outcome,
    'confirmed',
  );
  // Preserve the exact requested digest but contradict the decoded amount word.
  issuance.data =
    issuance.data.slice(0, 2 + 4 * 64) +
    (BigInt(request.amount) + 1n).toString(16).padStart(64, '0') +
    issuance.data.slice(2 + 5 * 64);
  assert.deepEqual(
    await observeIssuance(request, hash, chainConfig, rpc.fetcher),
    { outcome: 'rejected', reason: 'issuance_mismatch' },
  );
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

void test('bounded relayer receipts remain observable beyond 256 total logs', async () => {
  for (const count of [256, 257]) {
    const rpc = rpcFixture(request, digest, issuanceEvent);
    const receipt = rpc.values.eth_getTransactionReceipt;
    const issuance = receipt.logs[0];
    receipt.to = request.token;
    rpc.values.eth_getTransactionByHash.to = request.token;
    receipt.logs = Array.from({ length: count - 1 }, (_, index) => ({
      ...issuance,
      address: request.token,
      topics: [`0x${'99'.repeat(32)}`],
      data: '0x',
      logIndex: `0x${index.toString(16)}`,
    }));
    issuance.logIndex = `0x${(count - 1).toString(16)}`;
    receipt.logs.push(issuance);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 512 * 1024);
    const result = await observeIssuance(
      request,
      hash,
      chainConfig,
      rpc.fetcher,
    );
    assert.equal(result.outcome, 'confirmed', `${count} logs`);
    assert.equal(result.logIndex, String(count - 1));
    assert.ok(rpc.calls.every((call) => !call.method.startsWith('eth_send')));
  }
});

void test('large unrelated log data cannot bypass the receipt response byte limit', async () => {
  const rpc = rpcFixture(request, digest, issuanceEvent);
  const receipt = rpc.values.eth_getTransactionReceipt;
  receipt.logs.unshift({
    ...receipt.logs[0],
    address: request.token,
    data: `0x${'ff'.repeat(512 * 1024)}`,
  });
  assert.deepEqual(
    await observeIssuance(request, hash, chainConfig, rpc.fetcher),
    { outcome: 'pending', reason: 'rpc_unavailable' },
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
