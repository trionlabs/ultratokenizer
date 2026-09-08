import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { encodeAbiParameters, decodeEventLog, keccak256, type Hex } from 'viem';
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
  assert.ok(!invalid.stdout.includes('secret-value-marker'));
  assert.ok(!invalid.stdout.includes('sensitive-content-marker'));
  assert.equal(invalid.stderr, '');
  await writeFile(receiptPath, Buffer.from([0xff, 0xff]));
  assert.equal(JSON.parse(run().stdout).error.code, 'unreadable');
});
