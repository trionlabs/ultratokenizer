import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  encodeAbiParameters,
  decodeEventLog,
  keccak256,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import requestFixture from '../../domain/fixtures/request.synthetic.json' with { type: 'json' };
import {
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  getIssuerPermitTypedData,
} from '../../domain/src/index.js';
import {
  auditIssuanceReceipt,
  parseIssuanceReceipt,
  parseAuditPolicy,
  decodeClaimOutput,
  getExpectedIssuedEvent,
  ISSUED_EVENT_ABI,
  RECEIPT_FORMAT,
  POLICY_FORMAT,
  MAX_RECEIPT_BYTES,
  MAX_PROOF_BYTES,
  MAX_POLICY_BYTES,
  AuditInputError,
  type AuditReport,
  type AuditPolicy,
  type ProofVerificationAdapter,
} from '../src/index.js';

const holder = privateKeyToAccount(generatePrivateKey());
const issuer = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());
const bytes32 = (pair: string) => `0x${pair.repeat(32)}` as Hex;
const policy: AuditPolicy = {
  format: POLICY_FORMAT,
  chainId: '296',
  gate: requestFixture.gate as Hex,
  token: requestFixture.token as Hex,
  issuerId: requestFixture.issuerId as Hex,
  issuerAddress: issuer.address,
  issuerKeyVersion: '7',
  policyVersion: '1',
  rightsVersion: '1',
  programVKey: bytes32('66'),
  profileVersion: '1',
  sourceId: bytes32('77'),
  sourceSignerFingerprint: bytes32('88'),
  proofSystem: 'sp1-groth16',
  outerVersion: 'v6.1.0',
  verifierAddress: '0x4444444444444444444444444444444444444444',
  verifierCodeHash: bytes32('99'),
};
const request = { ...requestFixture, recipient: holder.address };
const digest = getIssuanceRequestDigest(request);
const permit = {
  requestDigest: digest,
  issuerId: request.issuerId,
  keyVersion: '7',
  nonce: '3',
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
    1,
    digest,
    policy.sourceSignerFingerprint,
    policy.sourceId,
    request.claimUsageId as Hex,
    request.claimCommitment as Hex,
    BigInt(request.validUntil),
  ],
);
const receipt = {
  format: RECEIPT_FORMAT,
  request,
  requestDigest: digest,
  holderSignature: await holder.signTypedData(
    getIssuanceRequestTypedData(request),
  ),
  permit,
  issuerSignature: await issuer.signTypedData(
    getIssuerPermitTypedData(request, permit),
  ),
  publicValues,
  proofBytes: '0x01020304',
  programVKey: policy.programVKey,
  transaction: { chainId: request.chainId, hash: bytes32('aa') },
};
const text = JSON.stringify(receipt);
const status = (report: AuditReport, id: string) =>
  report.checks.find((check) => check.id === id)?.status;

await test('genuine EOA signatures and bindings verify while offline assurance remains incomplete', async () => {
  const report = await auditIssuanceReceipt(text, policy);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.complete, false);
  for (const id of [
    'request_digest',
    'caller_policy',
    'contract_amount',
    'holder_eoa_signature',
    'permit_binding',
    'issuer_eoa_signature',
    'public_values_binding',
    'expiry_order',
  ])
    assert.equal(status(report, id), 'verified', id);
  for (const id of [
    'proof_cryptography',
    'transaction_inclusion',
    'historical_registry',
    'historical_reservation',
    'historical_supply',
    'historical_token_configuration',
    'replay_accounting',
    'execution_time',
    'current_revocation',
    'account_code',
  ]) {
    assert.equal(status(report, id), 'unverified', id);
    assert.ok(report.missingEvidence.includes(id));
  }
  assert.ok(Object.isFrozen(parseIssuanceReceipt(text).request));
  assert.ok(Object.isFrozen(parseAuditPolicy(JSON.stringify(policy))));
  assert.equal(decodeClaimOutput(publicValues).requestDigest, digest);
});

await test('tampering with canonical request fields invalidates signatures and digest binding', async () => {
  for (const [field, value] of [
    ['amount', '1001'],
    ['chainId', '295'],
    ['gate', attacker.address],
    ['recipient', attacker.address],
    ['claimCommitment', bytes32('bb')],
    ['claimUsageId', bytes32('cc')],
    ['nonce', '55'],
  ]) {
    const report = await auditIssuanceReceipt(
      JSON.stringify({ ...receipt, request: { ...request, [field]: value } }),
      policy,
    );
    assert.equal(report.status, 'invalid', field);
    assert.equal(status(report, 'request_digest'), 'failed', field);
    assert.equal(status(report, 'holder_eoa_signature'), 'failed', field);
  }
});

await test('separate issuer pins reject forged signatures and embedded trust keys', async () => {
  const forged = {
    ...receipt,
    issuerSignature: await attacker.signTypedData(
      getIssuerPermitTypedData(request, permit),
    ),
  };
  assert.equal(
    status(
      await auditIssuanceReceipt(JSON.stringify(forged), policy),
      'issuer_eoa_signature',
    ),
    'failed',
  );
  for (const field of [
    'issuerAddress',
    'issuerPublicKey',
    'trustPolicy',
    'registry',
    'privateBalance',
    'document',
    'witness',
  ]) {
    assert.throws(
      () =>
        parseIssuanceReceipt(
          JSON.stringify({ ...forged, [field]: attacker.address }),
        ),
      AuditInputError,
    );
  }
  const wrongVersion = await auditIssuanceReceipt(text, {
    ...policy,
    issuerKeyVersion: '8',
  });
  assert.equal(status(wrongVersion, 'caller_policy'), 'failed');
  for (const field of ['nonce', 'validUntil']) {
    const report = await auditIssuanceReceipt(
      JSON.stringify({ ...receipt, permit: { ...permit, [field]: '1' } }),
      policy,
    );
    assert.equal(status(report, 'issuer_eoa_signature'), 'failed', field);
  }
});

await test('all external program/source pins and exact claim words are checked', async () => {
  for (const field of ['programVKey', 'sourceId', 'sourceSignerFingerprint']) {
    const report = await auditIssuanceReceipt(text, {
      ...policy,
      [field]: bytes32('de'),
    });
    assert.equal(report.status, 'invalid', field);
  }
  assert.equal(
    (await auditIssuanceReceipt(text, { ...policy, profileVersion: '2' }))
      .status,
    'invalid',
  );
  for (let index = 1; index <= 5; index++) {
    const changed = `${publicValues.slice(0, 2 + index * 64)}${'ab'.repeat(32)}${publicValues.slice(2 + (index + 1) * 64)}`;
    assert.equal(
      status(
        await auditIssuanceReceipt(
          JSON.stringify({ ...receipt, publicValues: changed }),
          policy,
        ),
        'public_values_binding',
      ),
      'failed',
    );
  }
  const badPadding = `0x${'1'.padEnd(64, '0')}${publicValues.slice(66)}`;
  assert.equal(
    status(
      await auditIssuanceReceipt(
        JSON.stringify({ ...receipt, publicValues: badPadding }),
        policy,
      ),
      'public_values_binding',
    ),
    'failed',
  );
  const expiredClaim = `${publicValues.slice(0, -64)}${'1'.padStart(64, '0')}`;
  assert.equal(
    status(
      await auditIssuanceReceipt(
        JSON.stringify({ ...receipt, publicValues: expiredClaim }),
        policy,
      ),
      'expiry_order',
    ),
    'failed',
  );
});

await test('schema rejects private additions, unknown nested fields, malformed EOA signatures and byte excess', () => {
  for (const input of [
    null,
    [],
    {},
    { ...receipt, format: 'unknown' },
    { ...receipt, request: { ...request, privateBalance: 'secret-marker' } },
    { ...receipt, permit: { ...permit, signedKey: attacker.address } },
    {
      ...receipt,
      transaction: { ...receipt.transaction, blockConfirmed: true },
    },
    { ...receipt, publicValues: `${publicValues}00` },
    { ...receipt, proofBytes: '0x' },
    { ...receipt, proofBytes: '0x1' },
    { ...receipt, proofBytes: `0x${'11'.repeat(MAX_PROOF_BYTES + 1)}` },
    {
      ...receipt,
      holderSignature: `${receipt.holderSignature.slice(0, -2)}00`,
    },
    { ...receipt, issuerSignature: `0x${'ff'.repeat(64)}1b` },
  ]) {
    assert.throws(
      () => parseIssuanceReceipt(JSON.stringify(input)),
      (error) =>
        error instanceof AuditInputError &&
        !error.message.includes('secret-marker'),
    );
  }
  assert.throws(
    () => parseIssuanceReceipt('x'.repeat(MAX_RECEIPT_BYTES + 1)),
    /byte limit/,
  );
  assert.throws(
    () => parseIssuanceReceipt('😀'.repeat(MAX_RECEIPT_BYTES / 4 + 1)),
    /byte limit/,
  );
  assert.throws(
    () => parseAuditPolicy(' '.repeat(MAX_POLICY_BYTES + 1)),
    /byte limit/,
  );
  assert.throws(
    () => parseAuditPolicy({ ...policy, registryVerified: true }),
    /trust policy/,
  );
  assert.throws(
    () => parseAuditPolicy({ ...policy, proofSystem: 'unknown' }),
    /trust policy/,
  );
  assert.throws(
    () => parseAuditPolicy({ ...policy, outerVersion: 'latest' }),
    /trust policy/,
  );
});

await test('raw receipt and policy inputs reject duplicate decoded fields before normalization', () => {
  for (const input of [
    text.replace('{', '{"format":"private-marker",'),
    text.replace('"request":{', '"request":{"amount":"1",'),
    text.replace('"request":{', '"request":{"amoun\\u0074":"1",'),
    text.replace('"permit":{', '"permit":{"nonce":"private-marker",'),
  ]) {
    assert.notEqual(input, text);
    assert.throws(
      () => parseIssuanceReceipt(input),
      (error) =>
        error instanceof AuditInputError &&
        error.code === 'invalid_receipt' &&
        !error.message.includes('private-marker'),
    );
  }
  const policyText = JSON.stringify(policy);
  for (const key of ['format', 'forma\\u0074']) {
    assert.throws(
      () =>
        parseAuditPolicy(
          policyText.replace('{', `{"${key}":"private-marker",`),
        ),
      (error) =>
        error instanceof AuditInputError &&
        error.code === 'invalid_policy' &&
        !error.message.includes('private-marker'),
    );
  }
});

await test('proof adapters require exact outer verifier identity and never complete unknown historical checks', async () => {
  const identity = {
    proofSystem: policy.proofSystem,
    outerVersion: policy.outerVersion,
    verifierAddress: policy.verifierAddress,
    verifierCodeHash: policy.verifierCodeHash,
  };
  let calls = 0;
  const adapter: ProofVerificationAdapter = {
    identity,
    async verify(input) {
      calls++;
      assert.equal(input.programVKey, policy.programVKey);
      assert.equal(input.publicValues, publicValues);
      return true;
    },
  };
  const checked = await auditIssuanceReceipt(text, policy, {
    proofVerifier: adapter,
  });
  assert.equal(status(checked, 'proof_cryptography'), 'verified');
  assert.equal(status(checked, 'historical_token_configuration'), 'unverified');
  assert.ok(checked.missingEvidence.includes('historical_token_configuration'));
  assert.equal(checked.status, 'incomplete');
  assert.equal(checked.complete, false);
  assert.equal(calls, 1);
  for (const patch of [
    { outerVersion: 'v1.0.0' },
    { verifierAddress: attacker.address },
    { verifierCodeHash: bytes32('ba') },
  ]) {
    assert.equal(
      status(
        await auditIssuanceReceipt(text, policy, {
          proofVerifier: { ...adapter, identity: { ...identity, ...patch } },
        }),
        'proof_cryptography',
      ),
      'failed',
    );
  }
  assert.equal(calls, 1);
  const bad = await auditIssuanceReceipt(text, policy, {
    proofVerifier: {
      identity,
      async verify() {
        return false;
      },
    },
  });
  assert.equal(bad.status, 'invalid');
  const unavailable = await auditIssuanceReceipt(text, policy, {
    proofVerifier: {
      identity,
      async verify() {
        throw new Error('secret-adapter-details');
      },
    },
  });
  assert.equal(status(unavailable, 'proof_cryptography'), 'unverified');
  assert.ok(!JSON.stringify(unavailable).includes('secret-adapter-details'));
});

await test('expected Issued event matches contract ABI and remains declared bytes, not inclusion evidence', async () => {
  const expected = getExpectedIssuedEvent(text);
  const decoded = decodeEventLog({
    abi: ISSUED_EVENT_ABI,
    data: expected.data,
    topics: [...expected.topics] as [Hex, ...Hex[]],
  });
  assert.equal(decoded.args.requestDigest, digest);
  assert.equal(decoded.args.milligrams, BigInt(request.amount));
  assert.equal(decoded.args.publicValuesHash, keccak256(publicValues));
  assert.equal(decoded.args.programVKey, policy.programVKey);
  assert.equal(expected.data.length, 2 + 10 * 64);
  assert.equal(expected.topics.length, 4);
  const source = await readFile(
    new URL('../../../../contracts/src/IssuanceGate.sol', import.meta.url),
    'utf8',
  );
  const declaration = source
    .match(/event Issued\(([\s\S]*?)\);/)![1]
    .split(',')
    .map((field) => field.trim().replace(/\s+/g, ' '));
  const abiFields = ISSUED_EVENT_ABI[0].inputs.map(
    (field) =>
      `${field.type}${'indexed' in field && field.indexed ? ' indexed' : ''} ${field.name}`,
  );
  assert.deepEqual(declaration, abiFields);
  assert.equal(
    status(await auditIssuanceReceipt(text, policy), 'transaction_inclusion'),
    'unverified',
  );
  assert.equal(
    status(
      await auditIssuanceReceipt(
        JSON.stringify({ ...receipt, transaction: null }),
        policy,
      ),
      'transaction_inclusion',
    ),
    'unverified',
  );
});

await test('CLI is truthful by default, strict incomplete exits 2, invalid exits 1 with private-safe output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'issuance-audit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'receipt.json');
  const policyPath = join(directory, 'policy.json');
  await writeFile(receiptPath, text);
  await writeFile(policyPath, JSON.stringify(policy));
  const run = (...extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../cli.js', import.meta.url)),
        '--receipt',
        receiptPath,
        '--policy',
        policyPath,
        ...extra,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
  const incomplete = run();
  assert.equal(incomplete.status, 0);
  assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete');
  const strict = run('--strict');
  assert.equal(strict.status, 2);
  assert.equal(JSON.parse(strict.stdout).complete, false);
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, requestDigest: bytes32('ef') }),
  );
  assert.equal(run().status, 1);
  await writeFile(
    receiptPath,
    JSON.stringify({
      ...receipt,
      'sensitive-content-marker': 'secret-value-marker',
    }),
  );
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).proofVerification, null);
  assert.ok(!invalid.stdout.includes('secret-value-marker'));
  assert.ok(!invalid.stdout.includes('sensitive-content-marker'));
  assert.equal(invalid.stderr, '');
  await writeFile(receiptPath, Buffer.from([0xff, 0xff]));
  assert.equal(JSON.parse(run().stdout).error.code, 'unreadable');
});

await test('RPC proof checks distinguish explicit rejection from server failure and unstable chain views', async (t) => {
  const { createRpcProofVerifier } =
    await import('../src/rpc-proof-verifier.js');
  const code = '0x6000';
  const rpcPolicy = { ...policy, verifierCodeHash: keccak256(code) };
  for (const scenario of [
    'returned',
    'replay',
    'wrong-version',
    'wrong-replay-hash',
    'wrong-block-number',
    'revert',
    'internal',
    'transport',
    'null-result',
    'empty-result',
    'nonempty-result',
    'reorg',
    'wrong-code',
    'wrong-chain',
    'hedera-contract-execution-exception',
    'hedera-insufficient-gas',
  ] as const) {
    await t.test(scenario, async (subtest) => {
      let blockReads = 0;
      let proofCalls = 0;
      subtest.mock.method(
        globalThis,
        'fetch',
        async (_input: unknown, init?: { body?: unknown }) => {
          const call = JSON.parse(String(init?.body));
          let result: unknown;
          let error: unknown;
          let httpStatus = 200;
          if (call.method === 'eth_chainId')
            result = scenario === 'wrong-chain' ? '0x127' : '0x128';
          else if (call.method === 'eth_getBlockByNumber') {
            blockReads++;
            result = {
              number:
                scenario === 'wrong-block-number' && blockReads > 1
                  ? '0x2'
                  : '0x1',
              hash: bytes32(
                scenario === 'reorg' && blockReads > 1 ? '02' : '01',
              ),
              timestamp: '0x60000000',
              transactions: [],
            };
          } else if (call.method === 'eth_getCode') {
            assert.equal(
              call.params[1],
              '0x1',
              'runtime must use the selected block',
            );
            result = scenario === 'wrong-code' ? '0x6001' : code;
          } else if (
            call.method === 'eth_call' &&
            call.params[0].data === toFunctionSelector('VERSION()')
          ) {
            assert.equal(call.params[1], '0x1');
            result = encodeAbiParameters(
              [{ type: 'string' }],
              [
                scenario === 'wrong-version'
                  ? 'v0.0.0'
                  : rpcPolicy.outerVersion,
              ],
            );
          } else if (call.method === 'eth_call') {
            proofCalls++;
            assert.equal(
              call.params[1],
              '0x1',
              'proof must use the same block as runtime',
            );
            if (scenario === 'transport')
              throw new Error('transport unavailable');
            if (scenario === 'internal')
              error = {
                code: -32603,
                message: 'backend temporarily unavailable',
              };
            else if (
              scenario === 'hedera-contract-execution-exception' ||
              scenario === 'hedera-insufficient-gas'
            ) {
              // Local fixtures of the observed Hedera relay HTTP 400 shape.
              // Neither a generic execution exception nor a gas failure proves rejection.
              httpStatus = 400;
              const exception =
                scenario === 'hedera-contract-execution-exception'
                  ? 'CONTRACT_EXECUTION_EXCEPTION'
                  : 'INSUFFICIENT_GAS';
              error = {
                code: -32000,
                message: `[Request ID: 00000000-0000-4000-8000-000000000001] Error occurred during transaction simulation: ${exception}`,
              };
            } else if (scenario === 'null-result') result = null;
            else if (scenario === 'empty-result') result = '';
            else if (scenario === 'nonempty-result') result = '0x00';
            else if (
              ['returned', 'replay', 'wrong-block-number'].includes(scenario)
            )
              result = '0x';
            else
              error = {
                code: 3,
                message: 'execution reverted',
                data: '0xdeadbeef',
              };
          } else throw new Error(`Unexpected RPC method ${call.method}`);
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: call.id,
              ...(error ? { error } : { result }),
            }),
            {
              status: httpStatus,
              headers: { 'content-type': 'application/json' },
            },
          );
        },
      );
      const adapter = createRpcProofVerifier({
        policy: rpcPolicy,
        rpcUrl: 'http://127.0.0.1:12345/private-rpc?apiKey=not-for-report',
        ...(['replay', 'wrong-replay-hash'].includes(scenario)
          ? {
              block: {
                number: '1',
                hash: bytes32(scenario === 'replay' ? '01' : '99'),
              },
            }
          : {}),
      });
      const report = await auditIssuanceReceipt(text, rpcPolicy, {
        proofVerifier: adapter,
      });
      assert.equal(
        status(report, 'proof_cryptography'),
        scenario === 'revert'
          ? 'failed'
          : ['returned', 'replay'].includes(scenario)
            ? 'verified'
            : 'unverified',
      );
      assert.equal(
        report.status,
        scenario === 'revert' ? 'invalid' : 'incomplete',
      );
      assert.equal(report.complete, false);
      assert.equal(status(report, 'transaction_inclusion'), 'unverified');
      assert.equal(
        proofCalls,
        [
          'wrong-code',
          'wrong-chain',
          'wrong-version',
          'wrong-replay-hash',
        ].includes(scenario)
          ? 0
          : 1,
      );
      assert.equal(report.format, 'ultratokenizer.audit-report.v2');
      assert.equal(
        report.proofVerification?.result ?? null,
        scenario === 'revert'
          ? 'reverted'
          : ['returned', 'replay'].includes(scenario)
            ? 'returned'
            : null,
      );
      if (report.proofVerification) {
        assert.equal(report.proofVerification.blockNumber, '1');
        assert.equal(report.proofVerification.blockHash, bytes32('01'));
        assert.equal(
          report.proofVerification.verifierCodeHash,
          rpcPolicy.verifierCodeHash,
        );
        assert.equal(
          report.proofVerification.outerVersion,
          rpcPolicy.outerVersion,
        );
        assert.equal(
          report.proofVerification.proofBytesHash,
          keccak256(parseIssuanceReceipt(text).proofBytes),
        );
        assert.equal(
          report.proofVerification.publicValuesHash,
          keccak256(receipt.publicValues),
        );
        assert.equal(report.proofVerification.assurance, 'trusted-rpc');
        assert.equal(
          report.proofVerification.rpcOrigin,
          'http://127.0.0.1:12345',
        );
      }
      assert.ok(!JSON.stringify(report).includes('not-for-report'));
      assert.ok(!JSON.stringify(report).includes('private-rpc'));
    });
  }
});

await test('RPC replay rejects malformed or accessor-bearing block selectors without falling back', async () => {
  const { createRpcProofVerifier } =
    await import('../src/rpc-proof-verifier.js');
  let reads = 0;
  const accessor = Object.defineProperty({ hash: bytes32('01') }, 'number', {
    enumerable: true,
    get() {
      reads++;
      return '1';
    },
  });
  for (const block of [
    null,
    false,
    0,
    '',
    [],
    {},
    { number: '01', hash: bytes32('01') },
    { number: '1', hash: bytes32('00') },
    { number: '1', hash: bytes32('01'), extra: true },
    accessor,
  ]) {
    assert.throws(
      () =>
        createRpcProofVerifier({
          policy,
          rpcUrl: 'https://rpc.invalid',
          block: block as never,
        }),
      /Unsupported verifier block reference/,
    );
  }
  assert.equal(reads, 0);
});
