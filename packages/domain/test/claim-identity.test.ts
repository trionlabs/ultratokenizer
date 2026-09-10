import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestValidationError } from '../src/errors.js';
import { CLAIM_USAGE_TYPE, getClaimUsageId } from '../src/claim-identity.js';

const identity = {
  sourceId: '0x' + 'a1'.repeat(32),
  claimId: '0x' + 'b2'.repeat(32),
};

await test('matches the independent V2 ABI vector and differs from the legacy namespace', () => {
  assert.equal(
    getClaimUsageId(identity),
    '0xc8a8c0da5c7e9b2370346176465191740d40138c03945a79cebbd21e2ff7ddf8',
  );
  assert.notEqual(
    getClaimUsageId(identity),
    '0x617dc7ea467453c7bfd93b57b93bda15cba00b3024ba28671c01b499d10ef651',
  );
});

await test('reauthorizing a source right under another issuer preserves consumption identity', () => {
  const first = { ...identity, issuerId: '0x' + 'c3'.repeat(32) };
  const reissued = { ...identity, issuerId: '0x' + 'c4'.repeat(32) };
  const sourceIdentity = (claim: typeof first) => ({
    sourceId: claim.sourceId,
    claimId: claim.claimId,
  });
  assert.equal(
    getClaimUsageId(sourceIdentity(first)),
    getClaimUsageId(sourceIdentity(reissued)),
  );
  assert.throws(() => getClaimUsageId(first), RequestValidationError);
});

await test('different authenticated source rights have different identifiers', () => {
  const base = getClaimUsageId(identity);
  assert.notEqual(
    getClaimUsageId({ ...identity, claimId: '0x' + 'b3'.repeat(32) }),
    base,
  );
  assert.notEqual(
    getClaimUsageId({ ...identity, sourceId: '0x' + 'a2'.repeat(32) }),
    base,
  );
  assert.equal(
    getClaimUsageId({
      sourceId: identity.sourceId.toUpperCase().replace('0X', '0x'),
      claimId: identity.claimId,
    }),
    base,
  );
});

await test('rejects inputs that create request, issuer or deployment-specific identities', () => {
  for (const extra of [
    { issuerId: '0x' + 'c3'.repeat(32) },
    { holder: '0x' + '33'.repeat(20) },
    { salt: '0x' + '99'.repeat(32) },
    { nonce: '0' },
    { policyVersion: '2' },
    { chainId: '296' },
    { gate: '0x' + '11'.repeat(20) },
  ])
    assert.throws(
      () => getClaimUsageId({ ...identity, ...extra }),
      RequestValidationError,
    );
});

await test('rejects malformed, zero, missing and accessor-backed identity inputs', () => {
  for (const field of ['sourceId', 'claimId']) {
    for (const value of [
      '0x' + '00'.repeat(32),
      '0x1234',
      'not-hex',
      123,
      undefined,
    ]) {
      assert.throws(
        () => getClaimUsageId({ ...identity, [field]: value }),
        RequestValidationError,
      );
    }
  }
  for (const input of [
    null,
    [],
    new Date(),
    {},
    { sourceId: identity.sourceId },
  ]) {
    assert.throws(() => getClaimUsageId(input), RequestValidationError);
  }
  let reads = 0;
  const accessor = { ...identity };
  Object.defineProperty(accessor, 'claimId', {
    get() {
      reads++;
      return identity.claimId;
    },
  });
  assert.throws(() => getClaimUsageId(accessor), RequestValidationError);
  assert.equal(reads, 0);
});

await test('pins the issuer-independent domain separator', () => {
  assert.equal(
    CLAIM_USAGE_TYPE,
    'UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)',
  );
});
