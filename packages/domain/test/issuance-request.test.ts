import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fixture from '../fixtures/request.synthetic.json' with { type: 'json' };
import {
  assertIssuanceRequestActive,
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  parseIssuanceRequest,
  RequestValidationError,
  serializeIssuanceRequest,
} from '../src/index.js';
import type { RequestErrorCode } from '../src/index.js';

function rejects(input: unknown, code: RequestErrorCode, field?: string) {
  assert.throws(
    () => parseIssuanceRequest(input),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.code, code);
      if (field) assert.equal(error.field, field);
      return true;
    },
  );
}

await test('normalizes a valid request into immutable JSON-safe values', () => {
  const request = parseIssuanceRequest(fixture);
  assert.equal(request.amount, '10000');
  assert.equal(request.nonce, '0');
  assert.deepEqual(JSON.parse(serializeIssuanceRequest(request)), request);
  assert.ok(Object.isFrozen(request));
  assert.notEqual(request, fixture);
});

await test('rejects non-object and non-plain payloads', () => {
  for (const input of [null, undefined, [], 'request', 1, new Date()]) {
    rejects(input, 'invalid_shape');
  }
  rejects(Object.create(fixture), 'invalid_shape');
});

await test('requires every field and rejects additional unsigned data', () => {
  for (const field of Object.keys(fixture)) {
    const input: Record<string, unknown> = { ...fixture };
    delete input[field];
    rejects(input, 'missing_field', field);
  }
  rejects(
    { ...fixture, document: 'private document contents' },
    'unknown_field',
    'document',
  );
  rejects({ ...fixture, [Symbol('hidden')]: true }, 'unknown_field');
});

await test('rejects unsupported versions, actions and units', () => {
  for (const [field, value] of [
    ['schemaVersion', '2'],
    ['action', 'REDEEM'],
    ['unit', 'XAU_GRAM'],
  ]) {
    rejects({ ...fixture, [field]: value }, 'invalid_literal', field);
  }
});

await test('rejects ambiguous numeric representations on every integer field', () => {
  for (const field of [
    'chainId',
    'amount',
    'policyVersion',
    'rightsVersion',
    'nonce',
    'validUntil',
  ]) {
    for (const value of [
      1,
      BigInt(1),
      0.1,
      '01',
      '-1',
      '+1',
      '1.0',
      '1e3',
      ' 1',
      '1 ',
      '',
      '0x01',
      '١',
      '9'.repeat(1000),
    ]) {
      rejects({ ...fixture, [field]: value }, 'invalid_integer', field);
    }
  }
});

await test('rejects zero quantities, domains, versions and expiry placeholders', () => {
  for (const field of [
    'chainId',
    'amount',
    'policyVersion',
    'rightsVersion',
    'validUntil',
  ]) {
    rejects({ ...fixture, [field]: '0' }, 'integer_out_of_range', field);
  }
});

await test('enforces Solidity integer boundaries without precision loss', () => {
  for (const field of ['chainId', 'amount', 'nonce'] as const) {
    const limit = BigInt(1) << BigInt(256);
    const maximum = (limit - BigInt(1)).toString();
    assert.equal(
      parseIssuanceRequest({ ...fixture, [field]: maximum })[field],
      maximum,
    );
    rejects(
      { ...fixture, [field]: limit.toString() },
      'integer_out_of_range',
      field,
    );
  }
  for (const field of [
    'policyVersion',
    'rightsVersion',
    'validUntil',
  ] as const) {
    const limit = BigInt(1) << BigInt(64);
    const maximum = (limit - BigInt(1)).toString();
    assert.equal(
      parseIssuanceRequest({ ...fixture, [field]: maximum })[field],
      maximum,
    );
    rejects(
      { ...fixture, [field]: limit.toString() },
      'integer_out_of_range',
      field,
    );
  }
  const amount = '9007199254740993';
  assert.equal(
    getIssuanceRequestTypedData({ ...fixture, amount }).message.amount,
    BigInt(amount),
  );
});

await test('validates addresses before normalizing their checksums', () => {
  const checksum = '0x52908400098527886E0F7030069857D2E4169EE7';
  assert.equal(
    parseIssuanceRequest({ ...fixture, recipient: checksum.toLowerCase() })
      .recipient,
    checksum,
  );
  assert.equal(
    parseIssuanceRequest({ ...fixture, recipient: checksum }).recipient,
    checksum,
  );
  for (const field of ['gate', 'token', 'recipient']) {
    for (const value of [
      '0x' + '0'.repeat(40),
      '0.0.123',
      '0x1234',
      '0x52908400098527886E0F7030069857D2E4169Ee7',
    ]) {
      rejects({ ...fixture, [field]: value }, 'invalid_address', field);
    }
  }
});

await test('requires nonzero bytes32 identifiers and normalizes hex case', () => {
  for (const field of [
    'requestId',
    'issuerId',
    'reservationId',
    'claimCommitment',
    'claimUsageId',
  ]) {
    for (const value of [
      '0x' + '0'.repeat(64),
      'certificate.pdf',
      '0x1234',
      '0x' + 'g'.repeat(64),
    ]) {
      rejects({ ...fixture, [field]: value }, 'invalid_identifier', field);
    }
  }
  assert.equal(
    parseIssuanceRequest({ ...fixture, issuerId: '0x' + 'AB'.repeat(32) })
      .issuerId,
    '0x' + 'ab'.repeat(32),
  );
});

await test('canonical storage and signing are independent of input property order', () => {
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.equal(
    serializeIssuanceRequest(fixture),
    serializeIssuanceRequest(reordered),
  );
  assert.equal(
    getIssuanceRequestDigest(fixture),
    getIssuanceRequestDigest(reordered),
  );
});

const changedFields = {
  requestId: '0x' + 'aa'.repeat(32),
  chainId: '297',
  gate: '0x' + 'aa'.repeat(20),
  token: '0x' + 'bb'.repeat(20),
  recipient: '0x' + 'cc'.repeat(20),
  amount: '1001',
  issuerId: '0x' + 'bb'.repeat(32),
  reservationId: '0x' + 'cc'.repeat(32),
  claimCommitment: '0x' + 'dd'.repeat(32),
  claimUsageId: '0x' + 'ee'.repeat(32),
  policyVersion: '2',
  rightsVersion: '2',
  nonce: '1',
  validUntil: '2000000001',
};

await test('matches the pinned version-one request digest', () => {
  assert.equal(
    getIssuanceRequestDigest(fixture),
    '0xc591af7ea5cdef6005e1a9b31f14d7d30566e87615478d25a4861f43721b5deb',
  );
});

await test('every supported variable field is bound to the signing digest', () => {
  const digest = getIssuanceRequestDigest(fixture);
  for (const [field, value] of Object.entries(changedFields)) {
    assert.notEqual(
      getIssuanceRequestDigest({ ...fixture, [field]: value }),
      digest,
      `${field} was not bound`,
    );
  }
});

await test('an actual EOA signature fails after any request or domain field changes', async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const signature = await signer.signTypedData(
    getIssuanceRequestTypedData(fixture),
  );
  assert.equal(
    await verifyTypedData({
      ...getIssuanceRequestTypedData(fixture),
      address: signer.address,
      signature,
    }),
    true,
  );
  for (const [field, value] of Object.entries(changedFields)) {
    const changed = getIssuanceRequestTypedData({ ...fixture, [field]: value });
    assert.equal(
      await verifyTypedData({ ...changed, address: signer.address, signature }),
      false,
      `${field} accepted an old signature`,
    );
  }
});

await test('mutating returned typed-data definitions cannot alter later digests', () => {
  const expected = getIssuanceRequestDigest(fixture);
  const data = getIssuanceRequestTypedData(fixture);
  data.types.IssuanceRequest.splice(0, 1);
  data.domain.name = 'Different application';
  assert.equal(getIssuanceRequestDigest(fixture), expected);
});

await test('expiry is exclusive and does not depend on the machine clock', () => {
  const expiry = BigInt(fixture.validUntil);
  assert.equal(
    assertIssuanceRequestActive(fixture, expiry - 1n).validUntil,
    fixture.validUntil,
  );
  for (const now of [expiry, expiry + 1n]) {
    assert.throws(
      () => assertIssuanceRequestActive(fixture, now),
      (error: unknown) =>
        error instanceof RequestValidationError &&
        error.code === 'expired_request',
    );
  }
  assert.throws(
    () => assertIssuanceRequestActive(fixture, BigInt(-1)),
    (error: unknown) =>
      error instanceof RequestValidationError && error.code === 'invalid_time',
  );
});

await test('historical requests remain hashable after their expiry', () => {
  const expired = { ...fixture, validUntil: '1' };
  assert.match(getIssuanceRequestDigest(expired), /^0x[0-9a-f]{64}$/);
  assert.throws(
    () => assertIssuanceRequestActive(expired, BigInt(2)),
    RequestValidationError,
  );
});

await test('validation errors do not echo supplied private values', () => {
  const secret = 'confidential-certificate-content';
  assert.throws(
    () => parseIssuanceRequest({ ...fixture, claimCommitment: secret }),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
