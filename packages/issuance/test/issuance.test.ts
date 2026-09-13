import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createAtsBackendFixture } from './fixtures/ats.js';
import {
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  getIssuerPermitTypedData,
} from '../../domain/src/index.js';
import {
  POLICY_FORMAT,
  RECEIPT_FORMAT,
  getExpectedIssuedEvent,
} from '../../audit/src/index.js';
import {
  BUNDLE_FORMAT,
  DEPLOYMENT_FORMAT,
  DEPLOYMENT_V2_FORMAT,
  MAX_BUNDLE_BYTES,
  MAX_DEPLOYMENT_BYTES,
  getTokenBackend,
  parseIssuanceBundle,
  parseDeploymentConfig,
  assertBundleDeployment,
  toIssueArgs,
  ISSUANCE_GATE_ABI,
  HTS_TOKEN_ABI,
  createIssuanceClient,
  createIssuerClient,
  parseClaimProofExport,
  parsePreparedIssuanceRequest,
  IssuanceClientError,
  resolveEnsRecipient,
  parseTokenTransactionIntent,
} from '../src/index.js';

function parseRpcCall(body: unknown) {
  if (typeof body !== 'string')
    throw new Error('Expected a JSON-RPC string body');
  return JSON.parse(body);
}

const word = (pair: string) => `0x${pair.repeat(32)}` as Hex;
const holder = privateKeyToAccount(generatePrivateKey());
const issuer = privateKeyToAccount(generatePrivateKey());
const fixture = JSON.parse(
  await readFile(
    new URL(
      '../../../../proofs/claim-evidence/fixtures/request.synthetic.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const request = { ...fixture, recipient: holder.address };
const digest = getIssuanceRequestDigest(request);
const permit = {
  requestDigest: digest,
  issuerId: request.issuerId,
  keyVersion: '1',
  nonce: '0',
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
    word('bb'),
    word('a1'),
    request.claimUsageId,
    request.claimCommitment,
    BigInt(request.validUntil),
  ],
);
const bundle = {
  format: BUNDLE_FORMAT,
  request,
  permit,
  issuerSignature: await issuer.signTypedData(
    getIssuerPermitTypedData(request, permit),
  ),
  publicValues,
  proofBytes: '0x01020304',
  programVKey: word('77'),
};
const policy = {
  format: POLICY_FORMAT,
  chainId: request.chainId,
  gate: request.gate,
  token: request.token,
  issuerId: request.issuerId,
  issuerAddress: issuer.address,
  issuerKeyVersion: '1',
  policyVersion: request.policyVersion,
  rightsVersion: request.rightsVersion,
  programVKey: bundle.programVKey,
  profileVersion: '2',
  sourceId: word('a1'),
  sourceSignerFingerprint: word('bb'),
  proofSystem: 'sp1-groth16',
  outerVersion: 'v6.1.0',
  verifierAddress: '0x4444444444444444444444444444444444444444',
  verifierCodeHash: word('66'),
};
const deployment = {
  format: DEPLOYMENT_FORMAT,
  purpose: 'test',
  rpcUrl: 'http://127.0.0.1:12345',
  gateCodeHash: word('88'),
  confirmations: 2,
  auditPolicy: policy,
};

await test('a parsed public bundle is bound intent, not a cryptographic success', () => {
  const parsed = parseIssuanceBundle(JSON.stringify(bundle));
  assert.equal(parsed.request.amount, '10000');
  assert.equal(parsed.proofBytes, '0x01020304');
  assert.ok(Object.isFrozen(parsed));
  assert.ok(!Object.hasOwn(parsed, 'verified'));
  assertBundleDeployment(parsed, parseDeploymentConfig(deployment));
});

await test('rejects altered amount, recipient, expiry, old predicate and unbound permit', () => {
  const oldProfile = `0x${'1'.padStart(64, '0')}${publicValues.slice(66)}`;
  for (const changed of [
    { ...bundle, request: { ...request, amount: '9999' } },
    { ...bundle, request: { ...request, amount: '10001' } },
    { ...bundle, request: { ...request, recipient: issuer.address } },
    { ...bundle, permit: { ...permit, requestDigest: word('00') } },
    {
      ...bundle,
      permit: {
        ...permit,
        validUntil: String(BigInt(request.validUntil) + 1n),
      },
    },
    { ...bundle, publicValues: oldProfile },
    { ...bundle, proofBytes: '0x' },
    { ...bundle, issuerSignature: '0x01' },
    { ...bundle, document: 'private-marker' },
    { ...bundle, trusted: true },
  ])
    assert.throws(() => parseIssuanceBundle(changed), IssuanceClientError);
});

await test('independent deployment pins and source purpose cannot be supplied by a claim', () => {
  for (const changed of [
    { ...deployment, purpose: 'production' },
    { ...deployment, auditPolicy: { ...policy, chainId: '295' } },
    { ...deployment, auditPolicy: { ...policy, profileVersion: '1' } },
    { ...deployment, auditPolicy: { ...policy, outerVersion: 'v5.0.0' } },
    { ...deployment, gateCodeHash: word('00') },
    { ...deployment, rpcUrl: 'http://outside.invalid' },
    { ...deployment, confirmations: 0 },
    { ...deployment, rpcUrl: 'https://user:secret@outside.invalid' },
  ])
    assert.throws(() => parseDeploymentConfig(changed), IssuanceClientError);
  assert.throws(
    () => parseIssuanceBundle({ ...bundle, deployment }),
    IssuanceClientError,
  );
  const different = parseDeploymentConfig({
    ...deployment,
    auditPolicy: { ...policy, programVKey: word('99') },
  });
  assert.throws(
    () => assertBundleDeployment(parseIssuanceBundle(bundle), different),
    IssuanceClientError,
  );
});

await test('deployment versions explicitly select the token backend and remain reparseable', () => {
  const legacy = parseDeploymentConfig(deployment);
  assert.equal(getTokenBackend(legacy), 'hts');
  assert.ok(!Object.hasOwn(legacy, 'backend'));
  assert.deepEqual(parseDeploymentConfig(legacy), legacy);
  const selected = parseDeploymentConfig({
    ...deployment,
    format: DEPLOYMENT_V2_FORMAT,
    backend: { kind: 'hts' },
  });
  assert.equal(getTokenBackend(selected), 'hts');
  assert.equal(selected.format, DEPLOYMENT_V2_FORMAT);
  assert.ok(Object.isFrozen(selected));
  if (selected.format === DEPLOYMENT_V2_FORMAT)
    assert.ok(Object.isFrozen(selected.backend));
  assert.deepEqual(parseDeploymentConfig(selected), selected);
});

await test('a backend cannot be guessed, injected into legacy configuration or silently downgraded', () => {
  for (const candidate of [
    { ...deployment, backend: { kind: 'ats' } },
    { ...deployment, format: DEPLOYMENT_V2_FORMAT },
    { ...deployment, format: DEPLOYMENT_V2_FORMAT, backend: { kind: 'erc20' } },
    {
      ...deployment,
      format: DEPLOYMENT_V2_FORMAT,
      backend: { kind: 'hts', associate: false },
    },
    { ...deployment, format: DEPLOYMENT_V2_FORMAT, backend: { kind: 'ats' } },
    { ...deployment, format: DEPLOYMENT_V2_FORMAT, backend: null },
    { ...deployment, format: 'ultratokenizer.deployment.v3' },
  ])
    assert.throws(() => parseDeploymentConfig(candidate), IssuanceClientError);
  let reads = 0;
  const accessor = { ...deployment };
  Object.defineProperty(accessor, 'format', {
    get() {
      reads++;
      return DEPLOYMENT_V2_FORMAT;
    },
  });
  assert.throws(() => parseDeploymentConfig(accessor), IssuanceClientError);
  assert.equal(reads, 0);
});

await test('ATS configuration stays independent and association rejects before any wallet or RPC call', async (t) => {
  const configured = parseDeploymentConfig({
    ...deployment,
    format: DEPLOYMENT_V2_FORMAT,
    backend: createAtsBackendFixture(),
  });
  assert.equal(getTokenBackend(configured), 'ats');
  assert.deepEqual(parseDeploymentConfig(configured), configured);
  if (
    configured.format !== DEPLOYMENT_V2_FORMAT ||
    configured.backend.kind !== 'ats'
  )
    throw new Error('Expected parsed ATS configuration');
  assert.ok(Object.isFrozen(configured.backend));
  assert.ok(Object.isFrozen(configured.backend.facets));
  assert.ok(Object.isFrozen(configured.backend.facets.CoreFacet));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('No RPC is needed for an unsupported operation');
  });
  const provider: EIP1193Provider = {
    on() {
      calls++;
      throw new Error('No wallet listener is needed');
    },
    removeListener() {
      calls++;
      throw new Error('No wallet listener is needed');
    },
    async request() {
      calls++;
      throw new Error('No wallet prompt is permitted');
    },
  };
  const client = createIssuanceClient({ provider, deployment: configured });
  await assert.rejects(
    client.prepareTokenTransaction({ kind: 'association' }),
    (error: unknown) =>
      error instanceof IssuanceClientError &&
      error.code === 'unsupported_operation',
  );
  assert.equal(calls, 0);
  assert.throws(
    () => parseIssuanceBundle({ ...bundle, backend: configured.backend }),
    IssuanceClientError,
  );
});

await test('calldata uses the actual Gate tuple ABI and preserves exact quantities and independent signatures', async () => {
  const parsed = parseIssuanceBundle(bundle);
  const signature = await holder.signTypedData(
    getIssuanceRequestTypedData(parsed.request),
  );
  const data = encodeFunctionData({
    abi: ISSUANCE_GATE_ABI,
    functionName: 'issue',
    args: toIssueArgs(parsed, signature),
  });
  const decoded = decodeFunctionData({ abi: ISSUANCE_GATE_ABI, data });
  assert.equal(decoded.functionName, 'issue');
  if (
    !['issue', 'openReservation', 'usedPermitNonces'].includes(
      decoded.functionName,
    )
  )
    throw new Error('Wrong ABI');
  assert.equal(decoded.args[0].amount, 10000n);
  assert.equal(decoded.args[0].chainId, 296n);
  assert.equal(decoded.args[0].claimUsageId, request.claimUsageId);
  assert.equal(decoded.args[1], signature);
  assert.equal(decoded.args[2].requestDigest, digest);
  assert.equal(decoded.args[3], bundle.issuerSignature);
});

await test('wrong RPC chain fails before signature or submission', async (t) => {
  let signs = 0;
  const provider = {
    async request({ method }: { method: string }) {
      if (method === 'eth_chainId') return '0x128';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts')
        return [holder.address];
      signs++;
      throw new Error('No signing or sending expected');
    },
  } as EIP1193Provider;
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      const call = parseRpcCall(init?.body);
      assert.equal(call.method, 'eth_chainId');
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, result: '0x127' }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const client = createIssuanceClient({ provider, deployment });
  await assert.rejects(
    client.sign(bundle),
    (error: unknown) =>
      error instanceof IssuanceClientError &&
      error.code === 'rpc_chain_mismatch',
  );
  assert.equal(signs, 0);
});

await test('empty or changed deployed code fails before trusting any proof', async (t) => {
  let writes = 0;
  const provider = {
    async request({ method }: { method: string }) {
      if (method === 'eth_chainId') return '0x128';
      writes++;
      throw new Error('No wallet operation expected');
    },
  } as EIP1193Provider;
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      const call = parseRpcCall(init?.body);
      const result = call.method === 'eth_chainId' ? '0x128' : '0x';
      assert.ok(['eth_chainId', 'eth_getCode'].includes(call.method));
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, result }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const client = createIssuanceClient({ provider, deployment });
  await assert.rejects(
    client.submit(
      bundle,
      await holder.signTypedData(getIssuanceRequestTypedData(request)),
    ),
    (error: unknown) =>
      error instanceof IssuanceClientError &&
      error.code === 'deployment_mismatch',
  );
  assert.equal(writes, 0);
});

await test('invalid ENS inputs fail without resolving a default Ethereum recipient', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('No lookup expected');
  });
  await assert.rejects(
    resolveEnsRecipient({
      name: 'valid.eth',
      chainId: '2147483648',
      ethereumRpcUrl: 'https://rpc.invalid',
    }),
  );
  await assert.rejects(
    resolveEnsRecipient({
      name: 'valid.eth',
      chainId: '296',
      ethereumRpcUrl: 'http://outside.invalid',
    }),
  );
  assert.equal(calls, 0);
});

// Test-only JSON-RPC model. Returned proof success is a transport fixture, never cryptographic evidence.
async function rpcFixture(t: TestContext, version: 'v1' | 'v2' = 'v1') {
  const gateCode = '0x6001';
  const verifierCode = '0x6002';
  const adapterCode = '0x6003';
  const adapter = '0x5555555555555555555555555555555555555555';
  const rpcDeployment = {
    ...deployment,
    ...(version === 'v2'
      ? { format: DEPLOYMENT_V2_FORMAT, backend: { kind: 'hts' } }
      : {}),
    confirmations: 1,
    gateCodeHash: keccak256(gateCode),
    auditPolicy: { ...policy, verifierCodeHash: keccak256(verifierCode) },
  };
  const holderSignature = await holder.signTypedData(
    getIssuanceRequestTypedData(request),
  );
  const hash = word('10');
  const blockHash = word('20');
  const expectedLog = getExpectedIssuedEvent(
    JSON.stringify({
      ...bundle,
      format: RECEIPT_FORMAT,
      requestDigest: digest,
      holderSignature,
      transaction: { chainId: request.chainId, hash },
    }),
  );
  const state = {
    account: holder.address,
    walletChain: '0x128',
    sends: 0,
    signs: 0,
    onSimulation: () => {},
    onSign: () => {},
    sendFailure: false,
    sendError: null as unknown,
    sendResult: hash as unknown,
    onSend: async () => {},
    signError: null as unknown,
    onWalletRequest: (_method: string) => {},
    onRpcRequest: (_method: string) => {},
    capacity: BigInt(request.amount),
    reservationExists: true,
    reservationRevoked: false,
    issuerRevoked: false,
    used: false,
    requestIdUsed: false,
    holderNonceUsed: false,
    cap: BigInt(request.amount),
    pending: BigInt(request.amount),
    receiptFrom: holder.address,
    reservationLog: false,
    timestamp: '0x713fb300',
    sentData: '' as Hex | '',
    signIssuer: false,
    wrongIssuerSignature: false,
    reservedClaim: request.claimUsageId,
    proofError: null as null | { code: number; message: string; data?: string },
    proofReads: 0,
    sourceRevoked: false,
    programRevoked: false,
    paused: false,
    signatureValid: true,
    receiptHash: hash,
    receiptTo: request.token,
    canonicalHash: blockHash,
    head: '0x64',
    receiptStatus: '0x1',
    canonicalUnavailable: false,
    removedLog: false,
    transferLog: false,
    noLogs: false,
    duplicateTransferLog: false,
    logRecipient: issuer.address,
    logAmount: 125n,
    pendingNonce: '0x7' as unknown,
    txNonce: '0x7',
    txTo: request.gate,
    txValue: '0x0',
    sentNonce: undefined as string | undefined,
    associated: true,
    onTransactionRead: () => {},
    onAssociationRead: () => {},
    txData: encodeFunctionData({
      abi: ISSUANCE_GATE_ABI,
      functionName: 'issue',
      args: toIssueArgs(parseIssuanceBundle(bundle), holderSignature),
    }),
  };
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      state.onWalletRequest(method);
      if (method === 'eth_chainId') return state.walletChain;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts')
        return [state.account];
      if (method === 'eth_signTypedData_v4') {
        state.signs++;
        if (state.signError) throw state.signError;
        const typedData =
          params && typeof params[1] === 'string'
            ? JSON.parse(params[1])
            : null;
        const signature = state.signIssuer
          ? await (state.wrongIssuerSignature ? holder : issuer).signTypedData(
              typedData,
            )
          : holderSignature;
        state.onSign();
        return signature;
      }
      if (
        method === 'eth_sendTransaction' ||
        method === 'wallet_sendTransaction'
      ) {
        state.sends++;
        await state.onSend();
        state.sentData = (params?.[0] as { data: Hex } | undefined)?.data ?? '';
        state.sentNonce = (
          params?.[0] as { nonce?: string } | undefined
        )?.nonce;
        if (state.sendFailure)
          throw new Error('Wallet transport disconnected after send');
        if (state.sendError) throw state.sendError;
        return state.sendResult;
      }
      throw new Error(`Unexpected wallet method ${method}`);
    },
  } as EIP1193Provider;
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      const call = parseRpcCall(init?.body);
      state.onRpcRequest(call.method);
      let result: unknown;
      let error: unknown;
      if (call.method === 'eth_chainId') result = '0x128';
      else if (call.method === 'eth_getTransactionCount')
        result = state.pendingNonce;
      else if (call.method === 'eth_getCode') {
        const address = call.params[0].toLowerCase();
        result =
          address === request.gate.toLowerCase()
            ? gateCode
            : address === policy.verifierAddress.toLowerCase()
              ? verifierCode
              : address === adapter.toLowerCase()
                ? adapterCode
                : '0x';
      } else if (call.method === 'eth_getBlockByNumber') {
        if (state.canonicalUnavailable)
          throw new Error('Canonical block unavailable');
        result = {
          number: '0x64',
          hash: state.canonicalHash,
          timestamp: state.timestamp,
          transactions: [],
        };
      } else if (call.method === 'eth_blockNumber') result = state.head;
      else if (call.method === 'eth_call') {
        const to = call.params[0].to?.toLowerCase();
        if (to === request.gate.toLowerCase()) {
          const decoded = decodeFunctionData({
            abi: ISSUANCE_GATE_ABI,
            data: call.params[0].data,
          });
          if (
            !['issue', 'openReservation', 'usedPermitNonces'].includes(
              decoded.functionName,
            )
          )
            assert.equal(
              call.params[1],
              '0x64',
              'registry reads share one block',
            );
          switch (decoded.functionName) {
            case 'issuerKeys':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'issuerKeys',
                result: [
                  issuer.address,
                  BigInt(request.validUntil),
                  state.issuerRevoked,
                ],
              });
              break;
            case 'policies':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'policies',
                result: [1n, word('a1'), 1n, word('01'), false],
              });
              break;
            case 'programs':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'programs',
                result: [
                  policy.verifierAddress as Hex,
                  keccak256(verifierCode),
                  bundle.programVKey,
                  2,
                  state.programRevoked,
                ],
              });
              break;
            case 'sourceKeys':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'sourceKeys',
                result: [word('bb'), state.sourceRevoked],
              });
              break;
            case 'rights':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'rights',
                result: [
                  request.token,
                  adapter,
                  keccak256(adapterCode),
                  word('02'),
                  false,
                ],
              });
              break;
            case 'paused':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'paused',
                result: state.paused,
              });
              break;
            case 'backingPools':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'backingPools',
                result: [state.cap, state.pending, 0n],
              });
              break;
            case 'reservations':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'reservations',
                result: [
                  state.reservationExists ? holder.address : zeroAddress,
                  request.token,
                  state.capacity,
                  0n,
                  BigInt(request.validUntil),
                  state.reservationRevoked,
                  digest,
                  state.reservedClaim,
                  false,
                ],
              });
              break;
            case 'openReservation':
              state.onSimulation();
              result = '0x';
              break;
            case 'usedRequests':
            case 'usedClaims':
            case 'usedPermitNonces':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: decoded.functionName,
                result: state.used,
              });
              break;
            case 'usedRequestIds':
            case 'usedHolderNonces':
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: decoded.functionName,
                result:
                  decoded.functionName === 'usedRequestIds'
                    ? state.requestIdUsed
                    : state.holderNonceUsed,
              });
              break;
            case 'issue':
              state.onSimulation();
              result = encodeFunctionResult({
                abi: ISSUANCE_GATE_ABI,
                functionName: 'issue',
                result: digest,
              });
              break;
            default:
              throw new Error('Unexpected Gate read');
          }
        } else if (to === policy.verifierAddress.toLowerCase()) {
          state.proofReads++;
          assert.equal(
            call.params[1],
            '0x64',
            'proof and registry share one block',
          );
          error = state.proofError;
          result = '0x';
        } else if (to === request.token.toLowerCase()) {
          const decoded = decodeFunctionData({
            abi: HTS_TOKEN_ABI,
            data: call.params[0].data,
          });
          if (decoded.functionName === 'decimals')
            result = encodeFunctionResult({
              abi: HTS_TOKEN_ABI,
              functionName: 'decimals',
              result: 3,
            });
          else if (decoded.functionName === 'balanceOf')
            result = encodeFunctionResult({
              abi: HTS_TOKEN_ABI,
              functionName: 'balanceOf',
              result: 125n,
            });
          else if (decoded.functionName === 'associate') {
            state.onSimulation();
            result = encodeFunctionResult({
              abi: HTS_TOKEN_ABI,
              functionName: 'associate',
              result: 22n,
            });
          } else if (decoded.functionName === 'isAssociated') {
            assert.equal(
              call.params[0].from.toLowerCase(),
              holder.address.toLowerCase(),
            );
            assert.equal(call.params[1], '0x64');
            result = encodeFunctionResult({
              abi: HTS_TOKEN_ABI,
              functionName: 'isAssociated',
              result: state.associated,
            });
            state.onAssociationRead();
          } else if (decoded.functionName === 'transfer') {
            state.onSimulation();
            result = encodeFunctionResult({
              abi: HTS_TOKEN_ABI,
              functionName: 'transfer',
              result: true,
            });
          } else throw new Error('Unexpected token read');
        } else result = state.signatureValid ? '0x01' : '0x00'; // Deployless signature-verifier transport fixture.
      } else if (call.method === 'eth_getTransactionReceipt') {
        result = {
          transactionHash: state.receiptHash,
          blockHash,
          blockNumber: '0x64',
          transactionIndex: '0x0',
          from: state.receiptFrom,
          to: state.receiptTo,
          contractAddress: null,
          cumulativeGasUsed: '0x100',
          gasUsed: '0x100',
          effectiveGasPrice: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          status: state.receiptStatus,
          type: '0x0',
          logs: [
            {
              ...(state.transferLog
                ? {
                    address: request.token,
                    topics: encodeEventTopics({
                      abi: HTS_TOKEN_ABI,
                      eventName: 'Transfer',
                      args: { from: holder.address, to: state.logRecipient },
                    }),
                    data: encodeAbiParameters(
                      [{ type: 'uint256' }],
                      [state.logAmount],
                    ),
                  }
                : state.reservationLog
                  ? {
                      address: request.gate,
                      topics: encodeEventTopics({
                        abi: ISSUANCE_GATE_ABI,
                        eventName: 'ReservationOpened',
                        args: {
                          issuerId: request.issuerId,
                          reservationId: request.reservationId,
                        },
                      }),
                      data: encodeAbiParameters(
                        [
                          { type: 'address' },
                          { type: 'address' },
                          { type: 'uint256' },
                          { type: 'uint64' },
                          { type: 'uint64' },
                          { type: 'bytes32' },
                          { type: 'bytes32' },
                        ],
                        [
                          holder.address,
                          request.token,
                          BigInt(request.amount),
                          BigInt(request.validUntil),
                          1n,
                          digest,
                          request.claimUsageId,
                        ],
                      ),
                    }
                  : expectedLog),
              blockHash,
              blockNumber: '0x64',
              transactionHash: state.receiptHash,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: state.removedLog,
            },
          ],
        };
        const tokenReceipt = result as { logs: unknown[] };
        if (state.noLogs) tokenReceipt.logs = [];
        if (state.duplicateTransferLog)
          tokenReceipt.logs.push(...tokenReceipt.logs);
      } else if (call.method === 'eth_getTransactionByHash') {
        result = {
          hash,
          blockHash,
          blockNumber: '0x64',
          transactionIndex: '0x0',
          from: state.receiptFrom,
          to: state.txTo,
          input: state.txData,
          value: state.txValue,
          nonce: state.txNonce,
          gas: '0x100000',
          gasPrice: '0x1',
          type: '0x0',
          v: '0x1b',
          r: word('01'),
          s: word('02'),
        };
        state.onTransactionRead();
      } else throw new Error(`Unexpected RPC method ${call.method}`);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: call.id,
          ...(error ? { error } : { result }),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  );
  return {
    state,
    client: createIssuanceClient({ provider, deployment: rpcDeployment }),
    issuerClient: createIssuerClient({ provider, deployment: rpcDeployment }),
    holderSignature,
    hash,
  };
}
const hasCode = (code: IssuanceClientError['code']) => (error: unknown) =>
  error instanceof IssuanceClientError && error.code === code;

await test('viem wallet dispatch boundary separates its final chain check from a broadcast', async (t) => {
  for (const action of ['issuance', 'token'] as const)
    for (const failure of ['chain', 'outage'] as const)
      await t.test(`${action}: ${failure}`, async (subtest) => {
        const { state, client, holderSignature } = await rpcFixture(subtest);
        const intent = await client.prepareTokenTransaction({
          kind: 'association',
        });
        let simulated = false;
        let finalChainReads = 0;
        state.onSimulation = () => {
          simulated = true;
        };
        state.onWalletRequest = (method) => {
          if (
            simulated &&
            method === 'eth_chainId' &&
            ++finalChainReads === 2
          ) {
            if (failure === 'chain') state.walletChain = '0x127';
            else
              throw new Error(
                'Wallet chain RPC failed before eth_sendTransaction',
              );
          }
        };
        await assert.rejects(
          action === 'issuance'
            ? client.submit(bundle, holderSignature)
            : client.sendTokenTransaction(intent),
          hasCode(
            failure === 'chain'
              ? 'wrong_chain'
              : action === 'issuance'
                ? 'issuance_preflight_unavailable'
                : 'token_preflight_unavailable',
          ),
        );
        assert.equal(finalChainReads, 2);
        assert.equal(state.sends, 0);
      });
});

await test('nested provider rejection is normalized for actual wallet send and sign prompts', async (t) => {
  for (const action of ['issuance', 'token', 'sign'] as const)
    await t.test(action, async (subtest) => {
      const { state, client, holderSignature } = await rpcFixture(subtest);
      const intent = await client.prepareTokenTransaction({
        kind: 'association',
      });
      const rejection = {
        code: -32603,
        message: 'Internal JSON-RPC error',
        data: {
          originalError: { code: 4001, message: 'User rejected the request' },
        },
      };
      state.sendError = rejection;
      state.signError = rejection;
      await assert.rejects(
        action === 'issuance'
          ? client.submit(bundle, holderSignature)
          : action === 'token'
            ? client.sendTokenTransaction(intent)
            : client.sign(bundle),
        hasCode(action === 'sign' ? 'wallet_rejected' : 'transaction_declined'),
      );
      assert.equal(state.sends, action === 'sign' ? 0 : 1);
      assert.equal(state.signs, action === 'sign' ? 1 : 0);
    });
});

await test('a provider rejection after simulated acceptance retains the original nonce for reconciliation', async (t) => {
  const { state, client, hash } = await rpcFixture(t);
  const intent = await client.prepareTokenTransaction({
    kind: 'transfer',
    recipient: issuer.address,
    milligrams: '125',
  });
  state.onSend = async () => {
    state.pendingNonce = '0x8';
    state.transferLog = true;
  };
  state.sendError = {
    code: 4001,
    message: 'Incorrect rejection after acceptance',
  };
  await assert.rejects(
    client.sendTokenTransaction(intent),
    hasCode('transaction_declined'),
  );
  assert.equal(state.sends, 1);
  assert.equal(state.sentNonce, '0x7');
  state.txTo = request.token;
  state.txData = state.sentData as Hex;
  await client.waitTokenTransaction(hash, intent);
  await assert.rejects(
    client.sendTokenTransaction(intent),
    hasCode('stale_token_intent'),
  );
  assert.equal(state.sends, 1);
});

await test('connection reads current wallet access without querying the ATS deployment', async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    throw new Error('Connection must not query the deployment');
  });
  const methods: string[] = [];
  const provider = {
    async request({ method }: { method: string }) {
      methods.push(method);
      if (method === 'eth_requestAccounts') return [issuer.address];
      if (method === 'eth_accounts') return [holder.address];
      if (method === 'eth_chainId') return '0x128';
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  } as EIP1193Provider;
  const client = createIssuanceClient({
    provider,
    deployment: {
      ...deployment,
      format: DEPLOYMENT_V2_FORMAT,
      backend: createAtsBackendFixture(),
    },
  });
  assert.deepEqual(await client.connect(), {
    address: holder.address,
    chainId: '296',
  });
  assert.deepEqual(methods, [
    'eth_requestAccounts',
    'eth_accounts',
    'eth_chainId',
  ]);
  assert.equal(reads, 0);
  await assert.rejects(
    client.validate(bundle),
    hasCode('issuance_preflight_unavailable'),
  );
  assert.ok(reads > 0, 'Proof validation must still authenticate deployment');
});

await test('connection rejects the wrong network or revoked wallet access', async (t) => {
  for (const scenario of ['wrong_chain', 'wrong_account'] as const) {
    await t.test(scenario, async () => {
      const methods: string[] = [];
      const provider = {
        async request({ method }: { method: string }) {
          methods.push(method);
          if (method === 'eth_requestAccounts') return [holder.address];
          if (method === 'eth_accounts')
            return scenario === 'wrong_account' ? [] : [holder.address];
          if (method === 'eth_chainId')
            return scenario === 'wrong_chain' ? '0x1' : '0x128';
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      } as EIP1193Provider;
      const client = createIssuanceClient({ provider, deployment });
      await assert.rejects(client.connect(), hasCode(scenario));
      assert.deepEqual(methods, [
        'eth_requestAccounts',
        'eth_accounts',
        'eth_chainId',
      ]);
    });
  }
});

await test('holder preflight APIs sanitize read outages before any transaction or signature request', async (t) => {
  for (const action of ['validate', 'sign', 'simulate'] as const) {
    await t.test(action, async (subtest) => {
      const { state, client, holderSignature } = await rpcFixture(subtest);
      state.onRpcRequest = () => {
        throw new Error('Private provider diagnostic');
      };
      await assert.rejects(
        action === 'simulate'
          ? client.simulate(bundle, holderSignature)
          : client[action](bundle),
        hasCode('issuance_preflight_unavailable'),
      );
      assert.equal(state.sends, 0);
      assert.equal(state.signs, 0);
    });
  }
});

await test('provider transaction failures never trigger a second broadcast or a false rejection', async (t) => {
  for (const scenario of [
    'method-fallback',
    'input-fallback',
    'chain-after-send',
    'message-only',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      const intent = await client.prepareTokenTransaction({
        kind: 'association',
      });
      state.sendError =
        scenario === 'message-only'
          ? new Error('4001 user rejected')
          : {
              code:
                scenario === 'method-fallback'
                  ? -32601
                  : scenario === 'input-fallback'
                    ? -32000
                    : 4901,
              message: 'Provider transaction response unavailable',
            };
      await assert.rejects(
        client.sendTokenTransaction(intent),
        hasCode('transaction_uncertain'),
      );
      assert.equal(
        state.sends,
        1,
        'viem must not send another transaction through a fallback method',
      );
      assert.equal(
        intent.nonce,
        '7',
        'the caller retains the original intent for reconciliation',
      );
    });
});

await test(
  'concurrent operations do not borrow an in-flight broadcast state',
  { timeout: 5000 },
  async (t) => {
    const { state, client, hash } = await rpcFixture(t);
    const intent = await client.prepareTokenTransaction({
      kind: 'association',
    });
    let entered!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.onSend = async () => {
      entered();
      await response;
    };
    const first = client.sendTokenTransaction(intent);
    try {
      await dispatched;
      let simulated = false;
      let finalReads = 0;
      state.onSimulation = () => {
        simulated = true;
      };
      state.onWalletRequest = (method) => {
        if (simulated && method === 'eth_chainId' && ++finalReads === 2)
          throw new Error('Second operation failed before dispatch');
      };
      await assert.rejects(
        client.sendTokenTransaction(intent),
        hasCode('token_preflight_unavailable'),
      );
      assert.equal(state.sends, 1);
    } finally {
      release();
    }
    assert.equal(await first, hash);
  },
);

await test('malformed returned transaction hashes stay uncertain after one real provider dispatch', async (t) => {
  for (const result of [null, {}, '', '0x12', word('00')])
    await t.test(JSON.stringify(result), async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      const intent = await client.prepareTokenTransaction({
        kind: 'association',
      });
      state.sendResult = result;
      await assert.rejects(
        client.sendTokenTransaction(intent),
        hasCode('transaction_uncertain'),
      );
      assert.equal(state.sends, 1);
    });
});

await test('read and prepare outages have no submission ambiguity', async (t) => {
  for (const action of ['balance', 'prepare'] as const)
    await t.test(action, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      assert.equal(await client.balance(), 125n);
      state.onRpcRequest = (method) => {
        if (
          method ===
          (action === 'balance' ? 'eth_call' : 'eth_getTransactionCount')
        )
          throw new Error('Read endpoint unavailable');
      };
      await assert.rejects(
        action === 'balance'
          ? client.balance()
          : client.prepareTokenTransaction({ kind: 'association' }),
        hasCode(
          action === 'balance'
            ? 'token_read_unavailable'
            : 'token_preflight_unavailable',
        ),
      );
      assert.equal(state.sends, 0);
    });
});

await test('pending nonces must be complete canonical safe JSON-RPC quantities', async (t) => {
  for (const bad of [
    '0x07',
    '0x7junk',
    '0x',
    '0x-1',
    '0x20000000000000',
    null,
    ['0x7'],
  ])
    for (const phase of ['prepare', 'send'] as const)
      await t.test(`${phase}: ${JSON.stringify(bad)}`, async (subtest) => {
        const { state, client } = await rpcFixture(subtest);
        const intent = await client.prepareTokenTransaction({
          kind: 'association',
        });
        state.pendingNonce = bad;
        await assert.rejects(
          phase === 'prepare'
            ? client.prepareTokenTransaction({ kind: 'association' })
            : client.sendTokenTransaction(intent),
          hasCode('token_preflight_unavailable'),
        );
        assert.equal(state.sends, 0);
      });
});

await test('zero and maximum safe pending nonces remain exact when sent', async (t) => {
  for (const nonce of ['0x0', '0x1fffffffffffff'])
    await t.test(nonce, async (subtest) => {
      const { state, client, hash } = await rpcFixture(subtest);
      state.pendingNonce = nonce;
      const intent = await client.prepareTokenTransaction({
        kind: 'association',
      });
      assert.equal(intent.nonce, String(BigInt(nonce)));
      assert.equal(await client.sendTokenTransaction(intent), hash);
      assert.equal(state.sentNonce, nonce);
    });
});

await test('invalid recovery hashes are rejected before any RPC or wallet request', async (t) => {
  const { state, client, holderSignature } = await rpcFixture(t);
  let calls = 0;
  state.onRpcRequest = state.onWalletRequest = () => {
    calls++;
    throw new Error('Recovery input must be validated first');
  };
  for (const value of [null, {}, '', '0x12', word('00')]) {
    await assert.rejects(
      client.wait(bundle, holderSignature, value as Hex),
      hasCode('invalid_transaction_hash'),
    );
    await assert.rejects(
      client.waitTokenTransaction(value as Hex),
      hasCode('invalid_transaction_hash'),
    );
  }
  assert.equal(calls, 0);
});

await test('explicit v2 HTS retains association and divisible ERC20 transfer', async (t) => {
  const { state, client, hash } = await rpcFixture(t, 'v2');
  const association = await client.prepareTokenTransaction({
    kind: 'association',
  });
  assert.equal(await client.sendTokenTransaction(association), hash);
  const transfer = await client.prepareTokenTransaction({
    kind: 'transfer',
    recipient: issuer.address,
    milligrams: '125',
  });
  assert.equal(await client.sendTokenTransaction(transfer), hash);
  assert.equal(state.sends, 2);
});

await test('account changes during every send simulation stop submission', async (t) => {
  for (const action of ['associate', 'transfer', 'submit'] as const)
    await t.test(action, async (subtest) => {
      const { state, client, holderSignature } = await rpcFixture(subtest);
      const intent =
        action === 'submit'
          ? undefined
          : await client.prepareTokenTransaction(
              action === 'associate'
                ? { kind: 'association' }
                : {
                    kind: 'transfer',
                    recipient: issuer.address,
                    milligrams: '1',
                  },
            );
      state.onSimulation = () => {
        state.account = issuer.address;
      };
      const attempt = intent
        ? client.sendTokenTransaction(intent)
        : client.submit(bundle, holderSignature);
      await assert.rejects(attempt, hasCode('wrong_account'));
      assert.equal(state.sends, 0);
    });
});

await test('account and chain changes during the signing prompt invalidate the returned authorization', async (t) => {
  for (const changed of ['account', 'chain'] as const)
    await t.test(changed, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      state.onSign = () => {
        if (changed === 'account') state.account = issuer.address;
        else state.walletChain = '0x127';
      };
      await assert.rejects(
        client.sign(bundle),
        hasCode(changed === 'account' ? 'wrong_account' : 'wrong_chain'),
      );
      assert.equal(state.signs, 1);
      assert.equal(state.sends, 0);
    });
});

await test('wrong reservation capacity or claim is rejected before requesting a signature', async (t) => {
  for (const changed of ['capacity', 'claim'] as const)
    await t.test(changed, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      if (changed === 'capacity') state.capacity--;
      else state.reservedClaim = word('12');
      await assert.rejects(client.sign(bundle), hasCode('deployment_mismatch'));
      assert.equal(state.signs, 0);
    });
});

await test('an internal verifier RPC error is unresolved, while an explicit revert rejects the proof', async (t) => {
  for (const rejected of [false, true])
    await t.test(String(rejected), async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      state.proofError = rejected
        ? { code: 3, message: 'execution reverted', data: '0xdeadbeef' }
        : { code: -32603, message: 'backend temporarily unavailable' };
      await assert.rejects(
        client.validate(bundle),
        hasCode(rejected ? 'invalid_proof' : 'issuance_preflight_unavailable'),
      );
    });
});

await test('issuance preflight outages never report a possible wallet broadcast', async (t) => {
  for (const scenario of ['proof', 'block', 'simulation'] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client, holderSignature } = await rpcFixture(subtest);
      if (scenario === 'proof')
        state.proofError = {
          code: -32603,
          message: 'Verifier RPC unavailable',
        };
      if (scenario === 'block') state.canonicalUnavailable = true;
      if (scenario === 'simulation')
        state.onSimulation = () => {
          throw new Error('Simulation transport unavailable');
        };
      await assert.rejects(
        client.submit(bundle, holderSignature),
        hasCode('issuance_preflight_unavailable'),
      );
      assert.equal(state.sends, 0);
    });
});

await test('issuance submission returns an actual hash and isolates post-send uncertainty', async (t) => {
  const { state, client, holderSignature, hash } = await rpcFixture(t);
  assert.equal(await client.submit(bundle, holderSignature), hash);
  assert.equal(state.sends, 1);
  state.sendFailure = true;
  await assert.rejects(
    client.submit(bundle, holderSignature),
    hasCode('transaction_uncertain'),
  );
  assert.equal(state.sends, 2);
});

await test('a wallet send transport failure preserves uncertainty', async (t) => {
  const { state, client } = await rpcFixture(t);
  const intent = await client.prepareTokenTransaction({ kind: 'association' });
  state.sendFailure = true;
  await assert.rejects(
    client.sendTokenTransaction(intent),
    hasCode('transaction_uncertain'),
  );
  assert.ok(state.sends >= 1);
});

await test('token receipt reconciliation rejects substitution, reorgs, wrong targets and unresolved RPC reads', async (t) => {
  for (const scenario of [
    'replacement',
    'reorg',
    'wrong-target',
    'outage',
    'confirmations',
    'revert',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client, hash } = await rpcFixture(subtest);
      if (scenario === 'replacement') state.receiptHash = word('11');
      if (scenario === 'reorg') state.canonicalHash = word('21');
      if (scenario === 'wrong-target') state.receiptTo = issuer.address;
      if (scenario === 'outage') state.canonicalUnavailable = true;
      if (scenario === 'confirmations') state.head = '0x63';
      if (scenario === 'revert') state.receiptStatus = '0x0';
      await assert.rejects(
        client.waitTokenTransaction(hash),
        hasCode(
          scenario === 'wrong-target'
            ? 'issuance_mismatch'
            : scenario === 'revert'
              ? 'transaction_reverted'
              : 'transaction_uncertain',
        ),
      );
    });
});

await test('issuance receipt export binds the actual call bytes and canonical log, independent of current wallet', async (t) => {
  const { state, client, hash, holderSignature } = await rpcFixture(t);
  state.receiptTo = request.gate;
  state.account = issuer.address;
  state.walletChain = '0x127';
  const receipt = await client.wait(bundle, holderSignature, hash);
  assert.equal(receipt.transaction?.hash, hash);
  const original = state.txData;
  state.txData = '0x12345678';
  await assert.rejects(
    client.wait(bundle, holderSignature, hash),
    hasCode('issuance_mismatch'),
  );
  state.txData = original;
  state.removedLog = true;
  await assert.rejects(
    client.wait(bundle, holderSignature, hash),
    hasCode('issuance_mismatch'),
  );
});

const proofExport = {
  status: 'verified_groth16_export',
  proofMode: 'groth16',
  zeroKnowledge: true,
  issuerAuthorityChecked: false,
  outerCircuitVersion: 'v6.1.0',
  request,
  publicValues,
  programVKey: bundle.programVKey,
  proofBytes: `0x4388a21c${'00'.repeat(352)}`,
};

await test('raw issuance imports reject shadowed outer and nested keys with sanitized errors', async (t) => {
  const marker = 'private-import-marker';
  const backend = createAtsBackendFixture();
  const atsDeployment = {
    ...deployment,
    format: DEPLOYMENT_V2_FORMAT,
    backend,
  };
  for (const [name, parse, input, outerKey, nestedKey] of [
    ['bundle', parseIssuanceBundle, bundle, 'format', 'request'],
    ['proof export', parseClaimProofExport, proofExport, 'status', 'request'],
    ['deployment', parseDeploymentConfig, deployment, 'purpose', 'auditPolicy'],
    [
      'ATS deployment',
      parseDeploymentConfig,
      atsDeployment,
      'purpose',
      'auditPolicy',
    ],
  ] as const) {
    const json = JSON.stringify(input);
    const nestedField = nestedKey === 'request' ? 'amount' : 'profileVersion';
    const escapedField =
      nestedKey === 'request' ? 'amo\\u0075nt' : 'profile\\u0056ersion';
    const cases = [
      [
        'outer duplicate',
        `{${JSON.stringify(outerKey)}:${JSON.stringify(marker)},${json.slice(1)}`,
      ],
      [
        'nested duplicate',
        json.replace(
          `"${nestedKey}":{`,
          `"${nestedKey}":{"${nestedField}":"${marker}",`,
        ),
      ],
      [
        'escaped nested duplicate',
        json.replace(
          `"${nestedKey}":{`,
          `"${nestedKey}":{"${escapedField}":"${marker}",`,
        ),
      ],
    ];
    if (name === 'bundle')
      cases.push([
        'permit duplicate',
        json.replace('"permit":{', `"permit":{"nonce":"${marker}",`),
      ]);
    if (name === 'ATS deployment')
      cases.push([
        'backend duplicate',
        json.replace('"adapter":{', `"adapter":{"code\\u0048ash":"${marker}",`),
      ]);
    for (const [scenario, raw] of cases)
      await t.test(`${name}: ${scenario}`, () => {
        assert.throws(
          () => parse(raw),
          (error: unknown) => {
            assert.ok(error instanceof IssuanceClientError);
            const code = name.includes('deployment')
              ? 'invalid_deployment'
              : 'invalid_bundle';
            assert.equal(error.code, code);
            assert.equal(error.message, new IssuanceClientError(code).message);
            assert.equal(error.message.includes(marker), false);
            return true;
          },
        );
      });
  }
});

await test('raw issuance imports preserve valid escaping and exact byte limits', () => {
  for (const [parse, input, limit, code] of [
    [parseIssuanceBundle, bundle, MAX_BUNDLE_BYTES, 'invalid_bundle'],
    [parseClaimProofExport, proofExport, MAX_BUNDLE_BYTES, 'invalid_bundle'],
    [
      parseDeploymentConfig,
      deployment,
      MAX_DEPLOYMENT_BYTES,
      'invalid_deployment',
    ],
  ] as const) {
    const json = JSON.stringify(input);
    assert.deepEqual(
      parse(json.replace('"gate"', '"ga\\u0074e"')),
      parse(input),
    );
    const padded =
      json + ' '.repeat(limit - new TextEncoder().encode(json).byteLength);
    assert.deepEqual(parse(padded), parse(input));
    assert.throws(() => parse(padded + ' '), hasCode(code));
    assert.throws(
      () => parse('{"private-import-marker":'),
      (error: unknown) => {
        assert.ok(error instanceof IssuanceClientError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes('private-import-marker'), false);
        return true;
      },
    );
  }
});

// Transport fixtures deliberately contain no valid SP1 proof. Acceptance remains a separate live test.
await test('proof exports reject altered request binding, extra data, wrong proof mode and noncanonical length', () => {
  assert.equal(
    parseClaimProofExport(proofExport).request.amount,
    request.amount,
  );
  for (const change of [
    { request: { ...request, amount: '1' } },
    { issuerAuthorityChecked: true },
    { status: 'verified_core' },
    { zeroKnowledge: false },
    { proofMode: 'core' },
    { document: 'private-marker' },
    { proofBytes: '0x01020304' },
    { outerCircuitVersion: 'v5.0.0' },
  ])
    assert.throws(
      () => parseClaimProofExport({ ...proofExport, ...change }),
      IssuanceClientError,
    );
});

async function issuerFixture(t: TestContext, opened = true) {
  const fixture = await rpcFixture(t);
  const { state } = fixture;
  state.account = issuer.address;
  state.receiptFrom = issuer.address;
  state.receiptTo = request.gate;
  state.reservationLog = true;
  state.signIssuer = true;
  state.reservationExists = opened;
  state.pending = opened ? BigInt(request.amount) : 0n;
  state.txData = encodeFunctionData({
    abi: ISSUANCE_GATE_ABI,
    functionName: 'openReservation',
    args: [
      request.issuerId,
      1n,
      request.reservationId,
      holder.address,
      request.token,
      BigInt(request.amount),
      BigInt(request.validUntil),
      digest,
      request.claimUsageId,
    ],
  });
  return fixture;
}

await test('institution checks the actual proof before opening exact reservation calldata', async (t) => {
  const { state, issuerClient, hash } = await issuerFixture(t, false);
  assert.equal(await issuerClient.openReservation(proofExport), hash);
  assert.equal(state.sentData, state.txData);
  assert.equal(state.sends, 1);
  assert.equal(state.signs, 0);
});

await test('institution wallet dispatch and signature errors use the shared boundary', async (t) => {
  for (const scenario of [
    'chain',
    'outage',
    'rejection',
    'sign-rejection',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const signing = scenario === 'sign-rejection';
      const { state, issuerClient, hash } = await issuerFixture(
        subtest,
        signing,
      );
      let simulated = false;
      let finalReads = 0;
      state.onSimulation = () => {
        simulated = true;
      };
      state.onWalletRequest = (method) => {
        if (simulated && method === 'eth_chainId' && ++finalReads === 2) {
          if (scenario === 'chain') state.walletChain = '0x127';
          if (scenario === 'outage')
            throw new Error('Institution wallet chain RPC unavailable');
        }
      };
      const rejection = {
        code: -32602,
        data: { originalError: { code: 4001 } },
      };
      if (scenario === 'rejection') state.sendError = rejection;
      if (signing) state.signError = rejection;
      await assert.rejects(
        signing
          ? issuerClient.signPermit(proofExport, hash, {
              nonce: '123',
              validForSeconds: 300,
            })
          : issuerClient.openReservation(proofExport),
        hasCode(
          scenario === 'chain'
            ? 'wrong_chain'
            : scenario === 'outage'
              ? 'issuance_preflight_unavailable'
              : signing
                ? 'wallet_rejected'
                : 'transaction_declined',
        ),
      );
      assert.equal(state.sends, scenario === 'rejection' ? 1 : 0);
      assert.equal(state.signs, signing ? 1 : 0);
    });
});

await test('institution rejects capacity, replay, wrong wallet, changed signer and proof failures before opening', async (t) => {
  for (const scenario of [
    'cap',
    'used',
    'exists',
    'wallet',
    'revoke',
    'proof',
    'rpc',
    'switch',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, issuerClient } = await issuerFixture(subtest, false);
      if (scenario === 'cap') state.cap--;
      if (scenario === 'used') state.used = true;
      if (scenario === 'exists') state.reservationExists = true;
      if (scenario === 'wallet') state.account = holder.address;
      if (scenario === 'revoke') state.issuerRevoked = true;
      if (scenario === 'proof')
        state.proofError = { code: 3, message: 'execution reverted' };
      if (scenario === 'rpc')
        state.proofError = { code: -32603, message: 'backend unavailable' };
      if (scenario === 'switch')
        state.onSimulation = () => {
          state.account = holder.address;
        };
      const expected = {
        cap: 'capacity_exceeded',
        used: 'already_used',
        exists: 'reservation_mismatch',
        wallet: 'wrong_account',
        revoke: 'deployment_mismatch',
        proof: 'invalid_proof',
        rpc: 'issuance_preflight_unavailable',
        switch: 'wrong_account',
      } as const;
      await assert.rejects(
        issuerClient.openReservation(proofExport),
        hasCode(expected[scenario]),
      );
      assert.equal(state.sends, 0);
    });
});

await test('institution permit uses a real signature only after canonical exact reservation inclusion', async (t) => {
  const { state, issuerClient, hash } = await issuerFixture(t);
  const observation = await issuerClient.waitReservation(proofExport, hash);
  assert.equal(observation.kind, 'reservation-opened');
  assert.equal(observation.requestDigest, digest);
  const issuedBundle = await issuerClient.signPermit(proofExport, hash, {
    nonce: '123',
    validForSeconds: 300,
  });
  assert.equal(
    issuedBundle.permit.validUntil,
    String(BigInt(state.timestamp) + 300n),
  );
  assert.equal(issuedBundle.permit.nonce, '123');
  assert.equal(
    issuedBundle.issuerSignature,
    await issuer.signTypedData(
      getIssuerPermitTypedData(request, issuedBundle.permit),
    ),
  );
  assert.equal(state.signs, 1);
  assert.equal(state.sends, 0);
});

await test('institution reservation reconciliation rejects wrong log, calldata, sender and canonical chain', async (t) => {
  for (const scenario of [
    'log',
    'calldata',
    'sender',
    'reorg',
    'used-capacity',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, issuerClient, hash } = await issuerFixture(subtest);
      if (scenario === 'log') state.removedLog = true;
      if (scenario === 'calldata') state.txData = '0x12345678';
      if (scenario === 'sender') state.receiptFrom = holder.address;
      if (scenario === 'reorg') state.canonicalHash = word('99');
      if (scenario === 'used-capacity') state.capacity--;
      await assert.rejects(
        issuerClient.signPermit(proofExport, hash, {
          nonce: '123',
          validForSeconds: 300,
        }),
        hasCode(
          scenario === 'reorg'
            ? 'transaction_uncertain'
            : 'reservation_mismatch',
        ),
      );
      assert.equal(state.signs, 0);
    });
});

await test('issuer authorization rechecks key, reservation, account and expiry after the wallet prompt', async (t) => {
  for (const scenario of [
    'key',
    'reservation',
    'account',
    'expiry',
    'signature',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, issuerClient, hash } = await issuerFixture(subtest);
      state.wrongIssuerSignature = scenario === 'signature';
      state.onSign = () => {
        if (scenario === 'key') state.issuerRevoked = true;
        if (scenario === 'reservation') state.reservationRevoked = true;
        if (scenario === 'account') state.account = holder.address;
        if (scenario === 'expiry')
          state.timestamp = `0x${(BigInt(state.timestamp) + 300n).toString(16)}`;
      };
      const expected = {
        key: 'deployment_mismatch',
        reservation: 'reservation_mismatch',
        account: 'wrong_account',
        expiry: 'expired',
        signature: 'invalid_signature',
      } as const;
      await assert.rejects(
        issuerClient.signPermit(proofExport, hash, {
          nonce: '123',
          validForSeconds: 300,
        }),
        hasCode(expected[scenario]),
      );
      assert.equal(state.signs, 1);
      assert.equal(state.sends, 0);
    });
});

await test('an unused proof digest and claim cannot reserve or sign with a consumed request ID or holder nonce', async (t) => {
  for (const field of ['requestIdUsed', 'holderNonceUsed'] as const)
    for (const action of ['open', 'sign'] as const)
      await t.test(`${field}/${action}`, async (subtest) => {
        const { state, issuerClient, hash } = await issuerFixture(
          subtest,
          action === 'sign',
        );
        state[field] = true;
        assert.equal(state.used, false);
        const result =
          action === 'open'
            ? issuerClient.openReservation(proofExport)
            : issuerClient.signPermit(proofExport, hash, {
                nonce: '123',
                validForSeconds: 300,
              });
        await assert.rejects(result, hasCode('already_used'));
        assert.equal(state.sends, 0);
        assert.equal(state.signs, 0);
      });
});

await test('prepared token intent pins the wallet nonce and confirms the exact transfer', async (t) => {
  const { state, client, hash } = await rpcFixture(t);
  const intent = await client.prepareTokenTransaction(
    { kind: 'transfer', recipient: issuer.address, milligrams: '125' },
    holder.address,
  );
  assert.ok(Object.isFrozen(intent));
  assert.equal(intent.account, holder.address);
  assert.equal(intent.nonce, '7');
  assert.deepEqual(
    parseTokenTransactionIntent(JSON.parse(JSON.stringify(intent))),
    intent,
  );
  assert.equal(state.sends, 0);
  assert.equal(await client.sendTokenTransaction(intent), hash);
  assert.equal(state.sentNonce, '0x7');
  state.txTo = request.token;
  state.txData = state.sentData as Hex;
  state.transferLog = true;
  // Confirmation is historical; the currently selected wallet is irrelevant.
  state.account = issuer.address;
  state.walletChain = '0x129';
  await client.waitTokenTransaction(hash, intent);
});

await test('token intent rejects wrong or old calls and missing or inconsistent transfer events', async (t) => {
  for (const scenario of [
    'approve',
    'wrong-recipient',
    'wrong-quantity',
    'wrong-sender',
    'old-nonce',
    'nonzero-value',
    'missing-log',
    'wrong-log-recipient',
    'wrong-log-amount',
    'duplicate-log',
    'removed-log',
    'late-reorg',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client, hash } = await rpcFixture(subtest);
      const intent = await client.prepareTokenTransaction({
        kind: 'transfer',
        recipient: issuer.address,
        milligrams: '125',
      });
      state.txTo = request.token;
      state.txData = encodeFunctionData({
        abi: HTS_TOKEN_ABI,
        functionName: 'transfer',
        args: [issuer.address, 125n],
      });
      state.transferLog = true;
      if (scenario === 'approve')
        state.txData = ('0x095ea7b3' + '00'.repeat(64)) as Hex;
      if (scenario === 'wrong-recipient')
        state.txData = encodeFunctionData({
          abi: HTS_TOKEN_ABI,
          functionName: 'transfer',
          args: [holder.address, 125n],
        });
      if (scenario === 'wrong-quantity')
        state.txData = encodeFunctionData({
          abi: HTS_TOKEN_ABI,
          functionName: 'transfer',
          args: [issuer.address, 124n],
        });
      if (scenario === 'wrong-sender') state.receiptFrom = issuer.address;
      if (scenario === 'old-nonce') state.txNonce = '0x6';
      if (scenario === 'nonzero-value') state.txValue = '0x1';
      if (scenario === 'missing-log') state.noLogs = true;
      if (scenario === 'wrong-log-recipient')
        state.logRecipient = holder.address;
      if (scenario === 'wrong-log-amount') state.logAmount = 124n;
      if (scenario === 'duplicate-log') state.duplicateTransferLog = true;
      if (scenario === 'removed-log') state.removedLog = true;
      if (scenario === 'late-reorg')
        state.onTransactionRead = () => {
          state.canonicalHash = word('21');
        };
      await assert.rejects(
        client.waitTokenTransaction(hash, intent),
        hasCode(
          scenario === 'late-reorg'
            ? 'transaction_uncertain'
            : 'token_mismatch',
        ),
      );
    });
});

await test('HTS association checks the original caller state at the confirmed block', async (t) => {
  for (const scenario of [
    'associated',
    'not-associated',
    'late-reorg',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client, hash } = await rpcFixture(subtest);
      const intent = await client.prepareTokenTransaction(
        { kind: 'association' },
        holder.address,
      );
      assert.equal(await client.sendTokenTransaction(intent), hash);
      assert.equal(state.sentNonce, '0x7');
      state.txTo = request.token;
      state.txData = state.sentData as Hex;
      state.account = issuer.address;
      if (scenario === 'not-associated') state.associated = false;
      if (scenario === 'late-reorg')
        state.onAssociationRead = () => {
          state.canonicalHash = word('21');
        };
      if (scenario === 'associated')
        await client.waitTokenTransaction(hash, intent);
      else
        await assert.rejects(
          client.waitTokenTransaction(hash, intent),
          hasCode(
            scenario === 'late-reorg'
              ? 'transaction_uncertain'
              : 'association_failed',
          ),
        );
    });
});

await test('changed nonce or wallet and malformed intent cannot reach token submission', async (t) => {
  const { state, client } = await rpcFixture(t);
  const intent = await client.prepareTokenTransaction(
    { kind: 'transfer', recipient: issuer.address, milligrams: '125' },
    holder.address,
  );
  state.pendingNonce = '0x8';
  await assert.rejects(
    client.sendTokenTransaction(intent),
    hasCode('stale_token_intent'),
  );
  state.pendingNonce = '0x7';
  state.account = issuer.address;
  await assert.rejects(
    client.sendTokenTransaction(intent),
    hasCode('wrong_account'),
  );
  state.account = holder.address;
  let invoked = false;
  const accessor = { ...intent };
  Object.defineProperty(accessor, 'nonce', {
    get() {
      invoked = true;
      return '7';
    },
    enumerable: true,
  });
  for (const bad of [
    { ...intent, nonce: ['7'] },
    { ...intent, nonce: '07' },
    { ...intent, chainId: '297' },
    { ...intent, token: issuer.address },
    { ...intent, extra: true },
    accessor,
  ])
    await assert.rejects(
      client.sendTokenTransaction(
        bad as unknown as Parameters<typeof client.sendTokenTransaction>[0],
      ),
      IssuanceClientError,
    );
  assert.equal(invoked, false);
  assert.equal(state.sends, 0);
});

await test('nonce changes during simulation and preflight RPC loss never request a wallet transaction', async (t) => {
  for (const scenario of ['nonce', 'rpc'] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      const intent = await client.prepareTokenTransaction({
        kind: 'transfer',
        recipient: issuer.address,
        milligrams: '125',
      });
      state.onSimulation = () => {
        if (scenario === 'nonce') state.pendingNonce = '0x8';
        else throw new Error('RPC failed before wallet submission');
      };
      await assert.rejects(
        client.sendTokenTransaction(intent),
        hasCode(
          scenario === 'nonce'
            ? 'stale_token_intent'
            : 'token_preflight_unavailable',
        ),
      );
      assert.equal(state.sends, 0);
    });
});

const preparedRequest = {
  request,
  sourceId: policy.sourceId,
  signerFingerprint: policy.sourceSignerFingerprint,
  policyTermsHash: word('01'),
  rightsTermsHash: word('02'),
};

await test('prepared request authenticates authority and exact holder intent without inventing a proof or transaction', async (t) => {
  const { state, client, holderSignature } = await rpcFixture(t);
  state.reservationExists = false;
  state.pending = 0n;
  state.proofError = { code: 3, message: 'No proof exists yet' };
  const parsed = await client.prepareRequest(preparedRequest);
  assert.deepEqual(parsed, { prepared: preparedRequest, gatePaused: false });
  assert.ok(Object.isFrozen(parsed));
  assert.equal(await client.signRequest(parsed.prepared), holderSignature);
  assert.equal(state.proofReads, 0);
  assert.equal(state.sends, 0);
  assert.equal(state.signs, 1);
  assert.throws(
    () => parsePreparedIssuanceRequest({ ...preparedRequest, verified: true }),
    IssuanceClientError,
  );
  assert.throws(
    () =>
      parsePreparedIssuanceRequest({
        ...preparedRequest,
        request: { ...request, amount: '0' },
      }),
    IssuanceClientError,
  );
});

await test('pre-proof preparation rejects mismatched scope and terms before any holder signature', async (t) => {
  for (const [index, candidate] of [
    { ...preparedRequest, request: { ...request, gate: issuer.address } },
    { ...preparedRequest, sourceId: word('ab') },
    { ...preparedRequest, signerFingerprint: word('ab') },
    { ...preparedRequest, policyTermsHash: word('ab') },
    { ...preparedRequest, rightsTermsHash: word('ab') },
  ].entries())
    await t.test(`binding ${index + 1}`, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      state.reservationExists = false;
      state.pending = 0n;
      await assert.rejects(
        client.signRequest(candidate),
        hasCode('deployment_mismatch'),
      );
      assert.equal(state.signs, 0);
      assert.equal(state.sends, 0);
      assert.equal(state.proofReads, 0);
    });
});

await test('pre-proof requests cannot bypass source/program admission, replay or caps', async (t) => {
  for (const flag of [
    'sourceRevoked',
    'programRevoked',
    'issuerRevoked',
    'used',
    'requestIdUsed',
    'holderNonceUsed',
    'cap',
    'reservationExists',
  ] as const)
    await t.test(flag, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      state.reservationExists = false;
      state.pending = 0n;
      if (flag === 'cap') state.cap = 0n;
      else state[flag] = true;
      await assert.rejects(
        client.signRequest(preparedRequest),
        IssuanceClientError,
      );
      assert.equal(state.signs, 0);
      assert.equal(state.sends, 0);
    });
});

await test('a changed wallet or request signature is rejected after the pre-proof prompt', async (t) => {
  for (const change of ['wallet', 'signature'] as const)
    await t.test(change, async (subtest) => {
      const { state, client } = await rpcFixture(subtest);
      state.reservationExists = false;
      state.pending = 0n;
      state.signatureValid = false;
      if (change === 'wallet')
        state.onSign = () => {
          state.account = issuer.address;
        };
      const candidate =
        change === 'signature'
          ? {
              ...preparedRequest,
              request: {
                ...request,
                nonce: String(BigInt(request.nonce) + 1n),
              },
            }
          : preparedRequest;
      await assert.rejects(
        client.signRequest(candidate),
        hasCode(change === 'wallet' ? 'wrong_account' : 'invalid_signature'),
      );
      assert.equal(state.sends, 0);
    });
});

await test('prepared bundle acceptance reuses one signature and still verifies the actual proof and permit', async (t) => {
  const { state, client, holderSignature } = await rpcFixture(t);
  assert.deepEqual(
    await client.acceptPreparedBundle(bundle, preparedRequest, holderSignature),
    parseIssuanceBundle(bundle),
  );
  assert.equal(state.signs, 0);
  assert.equal(state.sends, 0);
  assert.ok(state.proofReads > 0);
  await assert.rejects(
    client.acceptPreparedBundle(
      bundle,
      {
        ...preparedRequest,
        request: { ...request, nonce: String(BigInt(request.nonce) + 1n) },
      },
      holderSignature,
    ),
    hasCode('issuance_mismatch'),
  );
  state.proofError = { code: 3, message: 'execution reverted', data: '0x1234' };
  await assert.rejects(
    client.acceptPreparedBundle(bundle, preparedRequest, holderSignature),
    hasCode('invalid_proof'),
  );
});

await test('prepared reservation verifies holder approval and reserves before proof without minting', async (t) => {
  const { state, issuerClient, holderSignature, hash } = await issuerFixture(
    t,
    false,
  );
  state.proofError = { code: 3, message: 'No proof exists yet' };
  assert.equal(
    await issuerClient.openPreparedReservation(
      preparedRequest,
      holderSignature,
    ),
    hash,
  );
  assert.equal(state.sentData, state.txData);
  assert.equal(
    decodeFunctionData({ abi: ISSUANCE_GATE_ABI, data: state.sentData })
      .functionName,
    'openReservation',
  );
  assert.equal(state.proofReads, 0);
  assert.equal(state.signs, 0);
  assert.equal(state.sends, 1);
  state.reservationExists = true;
  state.pending = BigInt(request.amount);
  assert.equal(
    (await issuerClient.waitPreparedReservation(preparedRequest, hash))
      .requestDigest,
    digest,
  );
  await assert.rejects(
    issuerClient.openPreparedReservation(preparedRequest, holderSignature),
    hasCode('reservation_mismatch'),
  );
  assert.equal(state.sends, 1);
});

await test('pre-proof issuer reservation rejects an absent or foreign holder signature and source', async (t) => {
  for (const scenario of ['malformed', 'foreign', 'source'] as const)
    await t.test(scenario, async (subtest) => {
      const { state, issuerClient, holderSignature } = await issuerFixture(
        subtest,
        false,
      );
      state.signatureValid = false;
      const signature =
        scenario === 'malformed'
          ? '0x01'
          : scenario === 'foreign'
            ? await issuer.signTypedData(getIssuanceRequestTypedData(request))
            : holderSignature;
      const candidate =
        scenario === 'source'
          ? { ...preparedRequest, sourceId: word('ab') }
          : preparedRequest;
      await assert.rejects(
        issuerClient.openPreparedReservation(candidate, signature),
        IssuanceClientError,
      );
      assert.equal(state.sends, 0);
      assert.equal(state.signs, 0);
      assert.equal(state.proofReads, 0);
    });
});

await test('paused issuance permits request approval and reservation, never proof acceptance or mint', async (t) => {
  const { state, client, issuerClient, holderSignature, hash } =
    await issuerFixture(t, false);
  state.paused = true;
  state.account = holder.address;
  state.signIssuer = false;
  const preparation = await client.prepareRequest(preparedRequest);
  assert.equal(preparation.gatePaused, true);
  assert.equal(await client.signRequest(preparation.prepared), holderSignature);
  assert.equal(state.proofReads, 0);
  state.account = issuer.address;
  assert.equal(
    await issuerClient.openPreparedReservation(
      preparedRequest,
      holderSignature,
    ),
    hash,
  );
  state.reservationExists = true;
  state.pending = BigInt(request.amount);
  assert.equal(
    (await issuerClient.waitPreparedReservation(preparedRequest, hash))
      .requestDigest,
    digest,
  );
  state.account = holder.address;
  await assert.rejects(
    client.acceptPreparedBundle(bundle, preparedRequest, holderSignature),
    hasCode('deployment_mismatch'),
  );
  await assert.rejects(
    client.simulate(bundle, holderSignature),
    hasCode('deployment_mismatch'),
  );
  await assert.rejects(
    client.submit(bundle, holderSignature),
    hasCode('deployment_mismatch'),
  );
  assert.equal(state.sends, 1);
  assert.equal(state.proofReads, 0);
});

await test('public job approval restores an exact reserved or unreserved request without prompting or proving', async (t) => {
  for (const reserved of [true, false])
    await t.test(String(reserved), async (subtest) => {
      const { state, client, holderSignature } = await rpcFixture(subtest);
      state.paused = true;
      state.reservationExists = reserved;
      state.pending = reserved ? BigInt(request.amount) : 0n;
      const restored = await client.restorePreparedRequest(
        preparedRequest,
        holderSignature,
      );
      assert.deepEqual(restored, {
        prepared: preparedRequest,
        signature: holderSignature,
        gatePaused: true,
      });
      assert.equal(state.signs, 0);
      assert.equal(state.sends, 0);
      assert.equal(state.proofReads, 0);
    });
});

await test('restored approval rejects changed requests, wallets, signatures and other reservations', async (t) => {
  for (const scenario of [
    'digest',
    'wallet',
    'signature',
    'claim',
    'revoked',
    'consumed',
    'accounting',
  ] as const)
    await t.test(scenario, async (subtest) => {
      const { state, client, holderSignature } = await rpcFixture(subtest);
      state.signatureValid = false;
      if (scenario === 'wallet') state.account = issuer.address;
      if (scenario === 'claim') state.reservedClaim = word('ab');
      if (scenario === 'revoked') state.reservationRevoked = true;
      if (scenario === 'consumed') state.used = true;
      if (scenario === 'accounting') state.pending = 0n;
      const candidate =
        scenario === 'digest'
          ? {
              ...preparedRequest,
              request: {
                ...request,
                nonce: String(BigInt(request.nonce) + 1n),
              },
            }
          : preparedRequest;
      const signature =
        scenario === 'signature'
          ? await issuer.signTypedData(getIssuanceRequestTypedData(request))
          : holderSignature;
      await assert.rejects(
        client.restorePreparedRequest(candidate, signature),
        IssuanceClientError,
      );
      assert.equal(state.signs, 0);
      assert.equal(state.sends, 0);
      assert.equal(state.proofReads, 0);
    });
});
