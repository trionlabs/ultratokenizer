import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, keccak256 } from 'viem';
import { loadModule } from './helpers.mjs';

const {
  readTrustSnapshot,
  createAuthorityClient,
  authorityCall,
  GOVERNOR_ABI,
} = await loadModule('../src/lib/application/institution-client.ts');
const { ISSUANCE_GATE_ABI } = await loadModule(
  '../../../packages/issuance/src/index.ts',
);
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const abi = [...GOVERNOR_ABI, ...ISSUANCE_GATE_ABI];

async function harness(t) {
  const fixture = await createFixture();
  const policy = fixture.policy;
  const governor = fixture.bundle.request.recipient;
  const blockHash = `0x${'ab'.repeat(32)}`;
  const adapter = '0x5555555555555555555555555555555555555555';
  const terms = `0x${'99'.repeat(32)}`;
  const state = {
    account: governor,
    nonce: '0x7',
    hash: fixture.transactionHash,
    code: '0x60006000',
    chain: '0x128',
    sendError: undefined,
    sent: undefined,
    sends: 0,
    transactionData: undefined,
    canonical: blockHash,
    rejectSimulation: false,
    timestamp: '0x713fb300',
  };
  const values = {
    governor,
    paused: true,
    issuerKeys: [
      policy.issuerAddress,
      BigInt(fixture.bundle.request.validUntil),
      false,
    ],
    policies: [1n, policy.sourceId, 1n, terms, false],
    rights: [policy.token, adapter, keccak256('0x60026000'), terms, false],
    backingPools: [1000n, 100n, 200n],
    programs: [
      policy.verifierAddress,
      policy.verifierCodeHash,
      policy.programVKey,
      2,
      false,
    ],
    sourceKeys: [policy.sourceSignerFingerprint, false],
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const call = JSON.parse(options.body);
    calls.push(call);
    let result;
    let error;
    if (call.method === 'eth_chainId') result = state.chain;
    else if (call.method === 'eth_getTransactionCount') result = state.nonce;
    else if (call.method === 'eth_getCode') {
      const address = call.params[0].toLowerCase();
      result =
        address === policy.gate.toLowerCase()
          ? state.code
          : address === adapter.toLowerCase()
            ? '0x60026000'
            : '0x60016000';
    } else if (call.method === 'eth_getBlockByNumber')
      result = {
        number: '0x64',
        hash: state.canonical,
        timestamp: state.timestamp,
        transactions: [],
      };
    else if (call.method === 'eth_blockNumber') result = '0x64';
    else if (call.method === 'eth_call') {
      const decoded = decodeFunctionData({ abi, data: call.params[0].data });
      if (decoded.functionName in values)
        result = encodeFunctionResult({
          abi,
          functionName: decoded.functionName,
          result: values[decoded.functionName],
        });
      else if (state.rejectSimulation)
        error = { code: 3, message: 'execution reverted', data: '0x' };
      else result = '0x';
    } else if (call.method === 'eth_getTransactionReceipt')
      result = {
        transactionHash: state.hash,
        blockHash,
        blockNumber: '0x64',
        from: governor,
        to: policy.gate,
        status: '0x1',
        logs: [],
        transactionIndex: '0x0',
        type: '0x2',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
      };
    else if (call.method === 'eth_getTransactionByHash')
      result = {
        hash: state.hash,
        blockHash,
        blockNumber: '0x64',
        from: governor,
        to: policy.gate,
        value: '0x0',
        nonce: '0x7',
        input: state.transactionData ?? state.sent?.data,
        transactionIndex: '0x0',
        type: '0x2',
        gas: '0x5208',
        chainId: '0x128',
      };
    else throw new Error(`Unexpected RPC ${call.method}`);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: call.id,
        ...(error ? { error } : { result }),
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return state.chain;
      if (method === 'eth_accounts') return [state.account];
      if (method === 'eth_sendTransaction') {
        state.sends++;
        state.sent = params[0];
        if (state.sendError) throw state.sendError;
        return state.hash;
      }
      throw new Error(`Unexpected wallet ${method}`);
    },
  };
  return {
    fixture,
    state,
    values,
    calls,
    client: createAuthorityClient({ deployment: fixture.deployment, provider }),
  };
}

test('current trust reads share a canonical block and report pause separately from pin matches', async (t) => {
  const { fixture, calls, values } = await harness(t);
  const snapshot = await readTrustSnapshot(fixture.deployment);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.active, false);
  assert.deepEqual(snapshot.matches, {
    issuer: true,
    program: true,
    source: true,
    rights: true,
  });
  assert.equal(snapshot.pool.outstanding, '200');
  assert.equal(snapshot.pool.available, '700');
  for (const call of calls.filter(
    (call) => call.method === 'eth_call' || call.method === 'eth_getCode',
  ))
    assert.equal(call.params[1], '0x64');
  values.paused = false;
  assert.equal((await readTrustSnapshot(fixture.deployment)).active, true);
  values.backingPools = [1000n, 800n, 200n];
  const full = await readTrustSnapshot(fixture.deployment);
  assert.equal(full.active, true);
  assert.equal(full.pool.available, '0');
  values.programs[2] = `0x${'ee'.repeat(32)}`;
  const changed = await readTrustSnapshot(fixture.deployment);
  assert.equal(changed.active, false);
  assert.equal(changed.matches.program, false);
});

test('wrong RPC chain and runtime fail closed before claiming matching records', async (t) => {
  const { fixture, state } = await harness(t);
  state.chain = '0x1';
  await assert.rejects(readTrustSnapshot(fixture.deployment), {
    code: 'rpc_chain_mismatch',
  });
  state.chain = '0x128';
  state.code = '0x60036000';
  await assert.rejects(readTrustSnapshot(fixture.deployment), {
    code: 'deployment_mismatch',
  });
});

test('authority actions cannot select an arbitrary issuer and amounts remain integer milligrams', async (t) => {
  const { fixture } = await harness(t);
  const admitted = authorityCall(fixture.deployment, {
    kind: 'admit-issuer',
    validUntil: '2000000000',
  });
  assert.deepEqual(admitted.args, [
    fixture.policy.issuerId,
    1n,
    fixture.policy.issuerAddress,
    2000000000n,
  ]);
  assert.equal(
    authorityCall(fixture.deployment, { kind: 'cap', milligrams: '0' }).args[2],
    0n,
  );
  for (const milligrams of [
    '-1',
    '1.5',
    '1e3',
    ' 1',
    '01',
    '9223372036854775808',
  ])
    assert.throws(() =>
      authorityCall(fixture.deployment, { kind: 'cap', milligrams }),
    );
  assert.throws(() =>
    authorityCall(fixture.deployment, {
      kind: 'admit-issuer',
      validUntil: '18446744073709551616',
    }),
  );
});

test('wrong governor account and rejected simulation never request a wallet transaction', async (t) => {
  const { fixture, state, client } = await harness(t);
  state.account = fixture.policy.issuerAddress;
  await assert.rejects(client.prepare({ kind: 'pause', paused: false }), {
    code: 'wrong_account',
  });
  state.account = fixture.bundle.request.recipient;
  state.rejectSimulation = true;
  await assert.rejects(client.prepare({ kind: 'pause', paused: false }), {
    code: 'issuance_preflight_unavailable',
  });
  assert.equal(state.sends, 0);
});

test('authority intent pins nonce and exact calldata through real wallet dispatch and reconciliation', async (t) => {
  const { client, state } = await harness(t);
  const intent = await client.prepare({ kind: 'cap', milligrams: '2000' });
  state.nonce = '0x8';
  await assert.rejects(client.send(intent), { code: 'stale_token_intent' });
  assert.equal(state.sends, 0);
  state.nonce = '0x7';
  const hash = await client.send(intent);
  assert.equal(state.sends, 1);
  assert.equal(state.sent.nonce, '0x7');
  assert.equal(
    decodeFunctionData({ abi, data: state.sent.data }).functionName,
    'setBackingCap',
  );
  assert.deepEqual(await client.wait(intent, hash), {
    transactionHash: hash,
    blockNumber: '100',
    status: 'success',
  });
  state.transactionData = '0x12345678';
  await assert.rejects(client.wait(intent, hash), {
    code: 'issuance_mismatch',
  });
  assert.equal(state.sends, 1);
});

test('a lost wallet response is unresolved and is never automatically sent twice', async (t) => {
  const { client, state } = await harness(t);
  const intent = await client.prepare({ kind: 'pause', paused: true });
  state.sendError = new Error('Wallet disconnected after broadcast');
  await assert.rejects(client.send(intent), { code: 'transaction_uncertain' });
  assert.equal(state.sends, 1);
});

test('issuer expiry must be future at preparation and immediately before wallet dispatch', async (t) => {
  const { client, state } = await harness(t);
  const now = BigInt(state.timestamp);
  for (const validUntil of [now - 1n, now])
    await assert.rejects(
      client.prepare({ kind: 'admit-issuer', validUntil: String(validUntil) }),
      { code: 'expired' },
    );
  const intent = await client.prepare({
    kind: 'admit-issuer',
    validUntil: String(now + 1n),
  });
  state.timestamp = `0x${(now + 1n).toString(16)}`;
  await assert.rejects(client.send(intent), { code: 'expired' });
  assert.equal(state.sends, 0);
});
