import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuerPermitDigest,
  ISSUED_EVENT_ABI,
  parseIssuanceRequest,
} from '../../domain/src/index.js';
import { ISSUANCE_GATE_ABI, toIssueArgs } from '../../issuance/src/abi.js';
import {
  BUNDLE_FORMAT,
  parseIssuanceBundle,
} from '../../issuance/src/schema.js';
import {
  createInstitutionChainBridge,
  InstitutionChainError,
  openInstitutionLedger,
  type InstitutionChainPins,
} from '../src/index.js';

const word = (pair: string): Hex => `0x${pair.repeat(32)}`;
const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
const holder: Address = '0x1111111111111111111111111111111111111111';
const token: Address = '0x2222222222222222222222222222222222222222';
const gate: Address = '0x3333333333333333333333333333333333333333';
const relayer: Address = '0x4444444444444444444444444444444444444444';
const issuerId = word('22');
const sourceId = word('11');
const transactionHash = word('41');
const targetHash = word('42');
const deploymentHash = word('43');
const programVKey = word('44');
const runtime: Hex = '0x60006000';
const readableMethods = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
]);
type RpcCall = { id: number; method: string; params: unknown[] };
type Reservation = [
  Address,
  Address,
  bigint,
  bigint,
  bigint,
  boolean,
  Hex,
  Hex,
  boolean,
];
type WireRecord = Record<string, unknown>;
const hasCode = (code: InstitutionChainError['code']) => (error: unknown) =>
  error instanceof InstitutionChainError && error.code === code;

/** A transport/history fixture, not EVM execution or proof verification. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ut-chain-bridge-test-'));
  const ledger = openInstitutionLedger({
    path: join(directory, 'ledger.sqlite'),
  });
  t.after(() => {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const right = ledger.registerRight({
    sourceId,
    recordReference: 'private-bridge-test-record',
    holder,
    milligrams: '1000',
  });
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  const request = parseIssuanceRequest({
    schemaVersion: '1',
    action: 'ISSUE',
    requestId: word('31'),
    chainId: '31337',
    gate,
    token,
    recipient: holder,
    amount: '1000',
    unit: 'XAU_MILLIGRAM',
    issuerId,
    reservationId: word('32'),
    claimCommitment: word('33'),
    claimUsageId: right.claimUsageId,
    policyVersion: '1',
    rightsVersion: '1',
    nonce: '9',
    validUntil: '2000000000',
  });
  const allocation = ledger.reserve({ rightId: right.rightId, request });
  const digest = getIssuanceRequestDigest(request);
  const permit = {
    requestDigest: digest,
    issuerId,
    keyVersion: '1',
    nonce: '12',
    validUntil: request.validUntil,
  };
  const publicValues = encodeAbiParameters(
    [
      { type: 'uint32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint64' },
    ],
    [
      2,
      digest,
      word('55'),
      sourceId,
      request.claimUsageId,
      request.claimCommitment,
      BigInt(request.validUntil),
    ],
  );
  // Only structural bytes are needed: the bridge authenticates trusted RPC
  // accounting observations, not signatures or SP1 proofs in this fixture.
  const signature: Hex = `0x${'66'.repeat(65)}`;
  const bundle = parseIssuanceBundle({
    format: BUNDLE_FORMAT,
    request,
    permit,
    issuerSignature: signature,
    publicValues,
    proofBytes: '0x01020304',
    programVKey,
  });
  const event = {
    issuerId,
    reservationId: request.reservationId,
    token,
    recipient: holder,
    amount: 1000n,
    policyVersion: 1n,
    rightsVersion: 1n,
    permitDigest: getIssuerPermitDigest(request, permit),
    publicValuesHash: keccak256(publicValues),
    programVKey,
  };
  function eventData() {
    return encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        event.issuerId,
        event.reservationId,
        event.token,
        event.recipient,
        event.amount,
        event.policyVersion,
        event.rightsVersion,
        event.permitDigest,
        event.publicValuesHash,
        event.programVKey,
      ],
    );
  }
  const log: WireRecord = {
    address: gate,
    topics: encodeEventTopics({
      abi: ISSUED_EVENT_ABI,
      eventName: 'Issued',
      args: {
        requestDigest: digest,
        requestId: request.requestId,
        claimUsageId: request.claimUsageId,
      },
    }),
    data: eventData(),
    blockHash: targetHash,
    blockNumber: '0x64',
    transactionHash,
    transactionIndex: '0x3',
    logIndex: '0x0',
    removed: false,
  };
  const transaction: WireRecord = {
    hash: transactionHash,
    blockHash: targetHash,
    blockNumber: '0x64',
    transactionIndex: '0x3',
    from: relayer,
    to: gate,
    value: '0x0',
    nonce: '0x4d',
    gas: '0x100000',
    gasPrice: '0x1',
    type: '0x0',
    input: encodeFunctionData({
      abi: ISSUANCE_GATE_ABI,
      functionName: 'issue',
      args: toIssueArgs(bundle, signature),
    }),
    r: word('77'),
    s: word('78'),
    v: '0x1b',
  };
  const receipt: WireRecord = {
    transactionHash,
    blockHash: targetHash,
    blockNumber: '0x64',
    transactionIndex: '0x3',
    from: relayer,
    to: gate,
    contractAddress: null,
    cumulativeGasUsed: '0x100',
    gasUsed: '0x100',
    effectiveGasPrice: '0x1',
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x0',
    logs: [log],
  };
  const state = {
    chainId: '0x7a69',
    head: 101n,
    targetHash,
    deploymentHash,
    code: runtime,
    timestamp: BigInt(request.validUntil) - 1n,
    reservation: [
      holder,
      token,
      1000n,
      1000n,
      BigInt(request.validUntil),
      false,
      digest,
      request.claimUsageId,
      false,
    ] as Reservation,
    requestUsed: true,
    claimUsed: true,
    requestIdUsed: true,
    holderNonceUsed: true,
    permitNonceUsed: true,
    programVKey,
    transaction: transaction as WireRecord | null,
    receipt: receipt as WireRecord | null,
    failure: null as null | {
      method: string;
      mode: 'rpc' | 'disconnect' | 'invalid-json' | 'oversize';
    },
    onCall: (_call: RpcCall, _count: number) => {},
  };
  const calls: RpcCall[] = [];
  const failures: unknown[] = [];
  function result(call: RpcCall): unknown {
    switch (call.method) {
      case 'eth_chainId':
        return state.chainId;
      case 'eth_blockNumber':
        return hex(state.head);
      case 'eth_getBlockByNumber': {
        assert.match(String(call.params[0]), /^0x[0-9a-f]+$/);
        assert.equal(call.params[1], false);
        const number = BigInt(String(call.params[0]));
        return {
          number: hex(number),
          hash: number === 10n ? state.deploymentHash : state.targetHash,
          parentHash: word('79'),
          timestamp: hex(state.timestamp),
          transactions: [],
          gasLimit: '0x1000000',
          gasUsed: '0x100',
          size: '0x100',
          difficulty: '0x0',
          totalDifficulty: '0x0',
          miner: zeroAddress,
          nonce: '0x0000000000000000',
          extraData: '0x',
          logsBloom: `0x${'00'.repeat(256)}`,
          receiptsRoot: word('80'),
          stateRoot: word('81'),
          transactionsRoot: word('82'),
          sha3Uncles: word('83'),
          uncles: [],
        };
      }
      case 'eth_getCode':
        assert.equal(String(call.params[0]).toLowerCase(), gate.toLowerCase());
        assert.match(String(call.params[1]), /^0x[0-9a-f]+$/);
        return state.code;
      case 'eth_getTransactionByHash':
        assert.equal(call.params[0], transactionHash);
        return state.transaction;
      case 'eth_getTransactionReceipt':
        assert.equal(call.params[0], transactionHash);
        return state.receipt;
      case 'eth_call': {
        const input = call.params[0] as { to: string; data: Hex };
        assert.equal(input.to.toLowerCase(), gate.toLowerCase());
        assert.match(String(call.params[1]), /^0x[0-9a-f]+$/);
        const decoded = decodeFunctionData({
          abi: ISSUANCE_GATE_ABI,
          data: input.data,
        });
        switch (decoded.functionName) {
          case 'reservations':
            assert.deepEqual(decoded.args, [issuerId, request.reservationId]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'reservations',
              result: state.reservation,
            });
          case 'usedRequests':
            assert.deepEqual(decoded.args, [digest]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedRequests',
              result: state.requestUsed,
            });
          case 'usedClaims':
            assert.deepEqual(decoded.args, [request.claimUsageId]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedClaims',
              result: state.claimUsed,
            });
          case 'usedRequestIds':
            assert.deepEqual(decoded.args, [request.requestId]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedRequestIds',
              result: state.requestIdUsed,
            });
          case 'usedHolderNonces':
            assert.deepEqual(decoded.args, [holder, 9n]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedHolderNonces',
              result: state.holderNonceUsed,
            });
          case 'usedPermitNonces':
            assert.deepEqual(decoded.args, [issuerId, 1n, 12n]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedPermitNonces',
              result: state.permitNonceUsed,
            });
          case 'policies':
            assert.deepEqual(decoded.args, [issuerId, 1n]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'policies',
              result: [1n, sourceId, 1n, word('84'), true],
            });
          case 'programs':
            assert.deepEqual(decoded.args, [1n]);
            return encodeFunctionResult({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'programs',
              result: [relayer, word('85'), state.programVKey, 2, true],
            });
          default:
            throw new Error(
              'Unexpected contract operation in read-only bridge fixture.',
            );
        }
      }
      default:
        throw new Error(
          'Unexpected JSON-RPC method in read-only bridge fixture.',
        );
    }
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      let body = '';
      for await (const part of incoming) body += String(part);
      const call = JSON.parse(body) as RpcCall;
      assert.ok(!Array.isArray(call), 'RPC batching is disabled');
      assert.ok(
        readableMethods.has(call.method),
        'Only read methods are allowed',
      );
      calls.push(call);
      state.onCall(
        call,
        calls.filter((item) => item.method === call.method).length,
      );
      outgoing.setHeader('content-type', 'application/json');
      if (state.failure?.method === call.method) {
        switch (state.failure.mode) {
          case 'disconnect':
            outgoing.destroy(new Error('private-provider-error-marker'));
            return;
          case 'invalid-json':
            outgoing.end('{invalid private-provider-error-marker');
            return;
          case 'oversize':
            outgoing.end(' '.repeat(512 * 1024 + 1));
            return;
          case 'rpc':
            outgoing.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: call.id,
                error: {
                  code: -32000,
                  message: 'private-provider-error-marker',
                },
              }),
            );
            return;
        }
      }
      outgoing.end(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, result: result(call) }),
      );
    } catch (error) {
      failures.push(error);
      outgoing.statusCode = 500;
      outgoing.end('Fixture assertion failed.');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(failures, []);
    assert.ok(calls.every((call) => readableMethods.has(call.method)));
    assert.ok(!JSON.stringify(calls).includes('private-bridge-test-record'));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const pins: InstitutionChainPins = {
    format: 'ultratokenizer.institution-chain.v1',
    purpose: 'test',
    chainId: '31337',
    rpcUrl: `http://127.0.0.1:${address.port}`,
    gate,
    gateCodeHash: keccak256(runtime),
    programVKey,
    deploymentBlockNumber: '10',
    deploymentBlockHash: deploymentHash,
    confirmations: 2,
  };
  const bridge = createInstitutionChainBridge({ ledger, pins });
  function unused(revoked = true) {
    state.reservation[3] = 0n;
    state.reservation[5] = revoked;
    state.reservation[8] = true;
    state.requestUsed = false;
    state.claimUsed = false;
    state.requestIdUsed = false;
    state.holderNonceUsed = false;
    state.permitNonceUsed = false;
  }
  function pending() {
    assert.deepEqual(ledger.getAllocation(digest), allocation);
    assert.equal(ledger.getRight(right.rightId).state, 'pending');
    assert.deepEqual(ledger.getPool({ issuerId, token }), {
      issuerId,
      token,
      cap: '1000',
      pending: '1000',
      outstanding: '0',
    });
  }
  return {
    bridge,
    ledger,
    pins,
    request,
    right,
    digest,
    state,
    calls,
    transaction,
    receipt,
    log,
    event,
    eventData,
    bundle,
    signature,
    unused,
    pending,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

await test('trusted RPC issuance settles SQLite exactly once despite different transaction and Gate nonces or later revocation', async (t) => {
  const f = await fixture(t);
  f.state.reservation[5] = true;
  const settled = await f.bridge.settleIssued(f.digest, transactionHash);
  assert.equal(settled.state, 'issued');
  assert.deepEqual(settled.observation, {
    kind: 'issued',
    requestDigest: f.digest,
    chainId: '31337',
    gate,
    reservationId: f.request.reservationId,
    claimUsageId: f.request.claimUsageId,
    blockHash: targetHash,
    blockNumber: '100',
    transactionHash,
  });
  assert.equal(f.ledger.getRight(f.right.rightId).state, 'issued');
  assert.deepEqual(f.ledger.getPool({ issuerId, token }), {
    issuerId,
    token,
    cap: '1000',
    pending: '0',
    outstanding: '1000',
  });
  const reads = f.calls.length;
  f.state.head = 150n;
  f.state.failure = { method: 'eth_blockNumber', mode: 'rpc' };
  assert.deepEqual(
    await f.bridge.settleIssued(f.digest, transactionHash),
    settled,
  );
  assert.equal(
    f.calls.length,
    reads,
    'A terminal retry preserves its original observation',
  );
  await assert.rejects(
    f.bridge.settleIssued(f.digest, word('99')),
    hasCode('terminal_conflict'),
  );
  await assert.rejects(
    f.bridge.settleUnused(f.digest),
    hasCode('terminal_conflict'),
  );
});

await test('a confirmed revoked unused reservation releases SQLite and retries without changing the terminal anchor', async (t) => {
  const f = await fixture(t);
  f.unused();
  const settled = await f.bridge.settleUnused(f.digest);
  assert.equal(settled.state, 'released');
  assert.deepEqual(settled.observation, {
    kind: 'unused',
    requestDigest: f.digest,
    chainId: '31337',
    gate,
    reservationId: f.request.reservationId,
    claimUsageId: f.request.claimUsageId,
    blockHash: targetHash,
    blockNumber: '100',
    reason: 'revoked-unused',
    reservationReleased: true,
    reservationUsed: '0',
    requestUsed: false,
    claimUsed: false,
  });
  assert.equal(f.ledger.getRight(f.right.rightId).state, 'available');
  assert.equal(f.ledger.getPool({ issuerId, token }).pending, '0');
  assert.equal(f.ledger.getPool({ issuerId, token }).outstanding, '0');
  const reads = f.calls.length;
  f.state.head = 150n;
  assert.deepEqual(await f.bridge.settleUnused(f.digest), settled);
  assert.equal(f.calls.length, reads);
  await assert.rejects(
    f.bridge.settleIssued(f.digest, transactionHash),
    hasCode('terminal_conflict'),
  );
});

await test('unused expiry is inclusive and uses reservation expiry, including a longer reservation than the request', async (t) => {
  for (const delta of [-1n, 0n, 1n])
    await t.test(`expiry ${delta}`, async (t) => {
      const f = await fixture(t);
      f.unused(false);
      f.state.reservation[4] += 30n;
      f.state.timestamp = f.state.reservation[4] + delta;
      if (delta < 0n) {
        await assert.rejects(
          f.bridge.settleUnused(f.digest),
          hasCode('mismatch'),
        );
        f.pending();
      } else {
        const settled = await f.bridge.settleUnused(f.digest);
        assert.equal(settled.observation?.kind, 'unused');
        assert.ok(settled.observation?.kind === 'unused');
        assert.equal(settled.observation.reason, 'expired-unused');
      }
    });
});

const issuanceTampering: ReadonlyArray<
  readonly [string, (f: Fixture) => void]
> = [
  [
    'wrong receipt hash',
    (f) => {
      f.receipt.transactionHash = word('99');
    },
  ],
  [
    'wrong transaction hash',
    (f) => {
      f.transaction.hash = word('99');
    },
  ],
  [
    'wrong transaction block hash',
    (f) => {
      f.transaction.blockHash = word('99');
    },
  ],
  [
    'wrong transaction block number',
    (f) => {
      f.transaction.blockNumber = '0x63';
    },
  ],
  [
    'wrong transaction index',
    (f) => {
      f.transaction.transactionIndex = '0x4';
    },
  ],
  [
    'missing transaction indexes',
    (f) => {
      f.transaction.transactionIndex = null;
      f.receipt.transactionIndex = null;
      f.log.transactionIndex = null;
    },
  ],
  [
    'missing transaction nonce',
    (f) => {
      f.transaction.nonce = null;
    },
  ],
  [
    'wrong receipt sender',
    (f) => {
      f.receipt.from = holder;
    },
  ],
  [
    'wrong transaction destination',
    (f) => {
      f.transaction.to = token;
    },
  ],
  [
    'wrong receipt destination',
    (f) => {
      f.receipt.to = token;
    },
  ],
  [
    'nonzero call value',
    (f) => {
      f.transaction.value = '0x1';
    },
  ],
  [
    'reverted matching call',
    (f) => {
      f.receipt.status = '0x0';
    },
  ],
  [
    'missing issuance log',
    (f) => {
      f.receipt.logs = [];
    },
  ],
  [
    'duplicate issuance log',
    (f) => {
      f.receipt.logs = [f.log, { ...f.log, logIndex: '0x1' }];
    },
  ],
  [
    'wrong log Gate',
    (f) => {
      f.log.address = token;
    },
  ],
  [
    'removed log',
    (f) => {
      f.log.removed = true;
    },
  ],
  [
    'wrong log transaction hash',
    (f) => {
      f.log.transactionHash = word('99');
    },
  ],
  [
    'wrong log block hash',
    (f) => {
      f.log.blockHash = word('99');
    },
  ],
  [
    'wrong log block number',
    (f) => {
      f.log.blockNumber = '0x63';
    },
  ],
  [
    'wrong log transaction index',
    (f) => {
      f.log.transactionIndex = '0x4';
    },
  ],
  [
    'missing log index',
    (f) => {
      f.log.logIndex = null;
    },
  ],
  [
    'wrong event amount',
    (f) => {
      f.event.amount = 999n;
      f.log.data = f.eventData();
    },
  ],
  [
    'wrong event recipient',
    (f) => {
      f.event.recipient = relayer;
      f.log.data = f.eventData();
    },
  ],
  [
    'wrong event permit digest',
    (f) => {
      f.event.permitDigest = word('99');
      f.log.data = f.eventData();
    },
  ],
  [
    'wrong event public values hash',
    (f) => {
      f.event.publicValuesHash = word('99');
      f.log.data = f.eventData();
    },
  ],
  [
    'wrong event program key',
    (f) => {
      f.event.programVKey = word('99');
      f.log.data = f.eventData();
    },
  ],
  [
    'wrong decoded request',
    (f) => {
      f.transaction.input = encodeFunctionData({
        abi: ISSUANCE_GATE_ABI,
        functionName: 'issue',
        args: toIssueArgs(
          {
            ...f.bundle,
            request: { ...f.request, nonce: '10' },
          },
          f.signature,
        ),
      });
    },
  ],
  [
    'wrong decoded permit',
    (f) => {
      f.transaction.input = encodeFunctionData({
        abi: ISSUANCE_GATE_ABI,
        functionName: 'issue',
        args: toIssueArgs(
          {
            ...f.bundle,
            permit: { ...f.bundle.permit, requestDigest: word('99') },
          },
          f.signature,
        ),
      });
    },
  ],
  [
    'noncanonical trailing calldata',
    (f) => {
      f.transaction.input = `${String(f.transaction.input)}00`;
    },
  ],
  [
    'missing reservation',
    (f) => {
      f.state.reservation[0] = zeroAddress;
    },
  ],
  [
    'wrong reservation amount',
    (f) => {
      f.state.reservation[2] = 999n;
    },
  ],
  [
    'reservation shorter than request',
    (f) => {
      f.state.reservation[4] -= 1n;
    },
  ],
  [
    'wrong reservation digest',
    (f) => {
      f.state.reservation[6] = word('99');
    },
  ],
  [
    'unused reservation',
    (f) => {
      f.state.reservation[3] = 0n;
    },
  ],
  [
    'impossible released issued reservation',
    (f) => {
      f.state.reservation[8] = true;
    },
  ],
  [
    'missing request consumption',
    (f) => {
      f.state.requestUsed = false;
    },
  ],
  [
    'missing claim consumption',
    (f) => {
      f.state.claimUsed = false;
    },
  ],
  [
    'missing request ID consumption',
    (f) => {
      f.state.requestIdUsed = false;
    },
  ],
  [
    'missing holder nonce consumption',
    (f) => {
      f.state.holderNonceUsed = false;
    },
  ],
  [
    'missing permit nonce consumption',
    (f) => {
      f.state.permitNonceUsed = false;
    },
  ],
];

await test('issuance tampering or incomplete accounting always retains the complete pending allocation', async (t) => {
  for (const [name, mutate] of issuanceTampering)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      mutate(f);
      await assert.rejects(
        f.bridge.settleIssued(f.digest, transactionHash),
        InstitutionChainError,
      );
      f.pending();
    });
});

const unusedTampering: ReadonlyArray<readonly [string, (f: Fixture) => void]> =
  [
    [
      'missing reservation',
      (f) => {
        f.state.reservation[0] = zeroAddress;
      },
    ],
    [
      'wrong reservation holder',
      (f) => {
        f.state.reservation[0] = relayer;
      },
    ],
    [
      'wrong reservation token',
      (f) => {
        f.state.reservation[1] = gate;
      },
    ],
    [
      'wrong reservation amount',
      (f) => {
        f.state.reservation[2] = 999n;
      },
    ],
    [
      'wrong reservation digest',
      (f) => {
        f.state.reservation[6] = word('99');
      },
    ],
    [
      'wrong reservation claim',
      (f) => {
        f.state.reservation[7] = word('99');
      },
    ],
    [
      'expiry without on-chain release',
      (f) => {
        f.state.timestamp = f.state.reservation[4];
        f.state.reservation[8] = false;
      },
    ],
    [
      'consumed reservation',
      (f) => {
        f.state.reservation[3] = 1000n;
      },
    ],
    [
      'consumed request',
      (f) => {
        f.state.requestUsed = true;
      },
    ],
    [
      'consumed claim',
      (f) => {
        f.state.claimUsed = true;
      },
    ],
    [
      'released without revocation or expiry',
      (f) => {
        f.state.reservation[5] = false;
      },
    ],
  ];

await test('unused settlement needs exact released and never-consumed reservation state', async (t) => {
  for (const [name, mutate] of unusedTampering)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.unused();
      mutate(f);
      await assert.rejects(
        f.bridge.settleUnused(f.digest),
        InstitutionChainError,
      );
      f.pending();
    });
});

await test('both settlement paths retain pending on inconsistent chain, deployment, code or confirmations', async (t) => {
  const mutations: ReadonlyArray<readonly [string, (f: Fixture) => void]> = [
    [
      'wrong chain',
      (f) => {
        f.state.chainId = '0x128';
      },
    ],
    [
      'wrong deployment anchor',
      (f) => {
        f.state.deploymentHash = word('99');
      },
    ],
    [
      'wrong runtime',
      (f) => {
        f.state.code = '0x60016000';
      },
    ],
    [
      'missing runtime',
      (f) => {
        f.state.code = '0x';
      },
    ],
    [
      'target anchor changes during state reads',
      (f) => {
        f.state.onCall = (call) => {
          if (call.method === 'eth_call') f.state.targetHash = word('99');
        };
      },
    ],
    [
      'deployment anchor changes during state reads',
      (f) => {
        f.state.onCall = (call) => {
          if (call.method === 'eth_call') f.state.deploymentHash = word('99');
        };
      },
    ],
    [
      'chain changes during state reads',
      (f) => {
        f.state.onCall = (call) => {
          if (call.method === 'eth_call') f.state.chainId = '0x128';
        };
      },
    ],
    [
      'head regresses during state reads',
      (f) => {
        f.state.onCall = (call) => {
          if (call.method === 'eth_call') f.state.head = 99n;
        };
      },
    ],
  ];
  for (const mode of ['issued', 'unused'] as const)
    for (const [name, mutate] of mutations)
      await t.test(`${mode}: ${name}`, async (t) => {
        const f = await fixture(t);
        if (mode === 'unused') f.unused();
        mutate(f);
        await assert.rejects(
          mode === 'issued'
            ? f.bridge.settleIssued(f.digest, transactionHash)
            : f.bridge.settleUnused(f.digest),
          InstitutionChainError,
        );
        f.pending();
      });
});

await test('missing transactions and malformed calldata retain pending without leaking provider details', async (t) => {
  const mutations: ReadonlyArray<readonly [string, (f: Fixture) => void]> = [
    [
      'missing transaction',
      (f) => {
        f.state.transaction = null;
      },
    ],
    [
      'missing receipt',
      (f) => {
        f.state.receipt = null;
      },
    ],
    [
      'malformed calldata',
      (f) => {
        f.transaction.input = '0xdeadbeef';
      },
    ],
    [
      'non-issue calldata',
      (f) => {
        f.transaction.input = encodeFunctionData({
          abi: ISSUANCE_GATE_ABI,
          functionName: 'usedRequests',
          args: [f.digest],
        });
      },
    ],
    [
      'oversized calldata',
      (f) => {
        f.transaction.input = `0x${'00'.repeat(164000)}`;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      mutate(f);
      await assert.rejects(
        f.bridge.settleIssued(f.digest, transactionHash),
        InstitutionChainError,
      );
      f.pending();
    });
});

await test('JSON-RPC, transport and malformed-response errors stay sanitized and retain pending in both paths', async (t) => {
  for (const operation of ['issued', 'unused'] as const)
    for (const mode of [
      'rpc',
      'disconnect',
      'invalid-json',
      'oversize',
    ] as const)
      await t.test(`${operation}: ${mode}`, async (t) => {
        const f = await fixture(t);
        if (operation === 'unused') f.unused();
        f.state.failure = { method: 'eth_call', mode };
        await assert.rejects(
          operation === 'issued'
            ? f.bridge.settleIssued(f.digest, transactionHash)
            : f.bridge.settleUnused(f.digest),
          (error: unknown) => {
            assert.ok(error instanceof InstitutionChainError);
            assert.equal(error.code, 'unresolved');
            assert.ok(!String(error).includes('private-provider-error-marker'));
            assert.equal(error.cause, undefined);
            return true;
          },
        );
        f.pending();
      });
});

await test('invalid pins and identifiers fail without RPC calls or ledger mutation', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { purpose: 'production' },
    { chainId: '295' },
    { confirmations: 0 },
    { confirmations: 1.5 },
    { deploymentBlockNumber: '01' },
    { gate: zeroAddress },
    { gateCodeHash: word('00') },
    { programVKey: word('00') },
    { deploymentBlockHash: word('00') },
    { unexpected: 'field' },
    { rpcUrl: 'http://untrusted.invalid' },
    { rpcUrl: `${f.pins.rpcUrl}#fragment` },
    { rpcUrl: 'http://user:secret@127.0.0.1' },
  ])
    assert.throws(
      () =>
        createInstitutionChainBridge({
          ledger: f.ledger,
          pins: { ...f.pins, ...patch } as InstitutionChainPins,
        }),
      hasCode('invalid_input'),
    );
  await assert.rejects(
    f.bridge.settleIssued(f.digest, '0x12'),
    hasCode('invalid_input'),
  );
  await assert.rejects(
    f.bridge.settleUnused(word('99')),
    hasCode('invalid_input'),
  );
  assert.equal(f.calls.length, 0);
  f.pending();
});

await test('eight concurrent reconciliations settle one allocation without multiplying backing counters', async (t) => {
  for (const mode of ['issued', 'unused'] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      if (mode === 'unused') f.unused();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          mode === 'issued'
            ? f.bridge.settleIssued(f.digest, transactionHash)
            : f.bridge.settleUnused(f.digest),
        ),
      );
      for (const result of results) assert.deepEqual(result, results[0]);
      assert.equal(f.ledger.getPool({ issuerId, token }).pending, '0');
      assert.equal(
        f.ledger.getPool({ issuerId, token }).outstanding,
        mode === 'issued' ? '1000' : '0',
      );
    });
});

await test('a transient provider failure leaves reconciliation retryable against the same allocation', async (t) => {
  const f = await fixture(t);
  f.state.failure = { method: 'eth_call', mode: 'rpc' };
  await assert.rejects(
    f.bridge.settleIssued(f.digest, transactionHash),
    hasCode('unresolved'),
  );
  f.pending();
  f.state.failure = null;
  assert.equal(
    (await f.bridge.settleIssued(f.digest, transactionHash)).state,
    'issued',
  );
  assert.equal(f.ledger.getPool({ issuerId, token }).outstanding, '1000');
});
