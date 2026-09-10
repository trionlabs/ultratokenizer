import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fixture from '../fixtures/request.synthetic.json' with { type: 'json' };
import {
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
} from '../src/request-digest.js';
import {
  getIssuerPermitDigest,
  getIssuerPermitTypedData,
  parseIssuerPermit,
} from '../src/issuer-permit.js';

const permit = {
  requestDigest: getIssuanceRequestDigest(fixture),
  issuerId: fixture.issuerId,
  keyVersion: '1',
  nonce: '0',
  validUntil: fixture.validUntil,
};

await test('permit is canonical, frozen and a distinct EIP-712 authorization', async () => {
  assert.ok(Object.isFrozen(parseIssuerPermit(permit)));
  assert.notEqual(
    getIssuerPermitDigest(fixture, permit),
    getIssuanceRequestDigest(fixture),
  );
  const signer = privateKeyToAccount(generatePrivateKey());
  const signature = await signer.signTypedData(
    getIssuerPermitTypedData(fixture, permit),
  );
  assert.equal(
    await verifyTypedData({
      ...getIssuerPermitTypedData(fixture, permit),
      address: signer.address,
      signature,
    }),
    true,
  );
  assert.equal(
    await verifyTypedData({
      ...getIssuanceRequestTypedData(fixture),
      address: signer.address,
      signature,
    }),
    false,
  );
  for (const [field, value] of [
    ['keyVersion', '2'],
    ['nonce', '1'],
    ['validUntil', (BigInt(fixture.validUntil) - 1n).toString()],
  ]) {
    assert.equal(
      await verifyTypedData({
        ...getIssuerPermitTypedData(fixture, { ...permit, [field]: value }),
        address: signer.address,
        signature,
      }),
      false,
    );
  }
});

await test('permit cannot authorize changed request, issuer, chain or gate', () => {
  for (const [field, value] of [
    ['amount', '1001'],
    ['chainId', '295'],
    ['gate', '0x7777777777777777777777777777777777777777'],
    ['recipient', '0x7777777777777777777777777777777777777777'],
  ]) {
    assert.throws(() =>
      getIssuerPermitTypedData({ ...fixture, [field]: value }, permit),
    );
  }
  assert.throws(() =>
    getIssuerPermitTypedData(fixture, {
      ...permit,
      issuerId: `0x${'77'.repeat(32)}`,
    }),
  );
  assert.throws(() =>
    getIssuerPermitTypedData(fixture, {
      ...permit,
      validUntil: (BigInt(fixture.validUntil) + 1n).toString(),
    }),
  );
});

await test('permit rejects unsigned fields, missing fields, ambiguous integers and overflow', () => {
  for (const input of [
    null,
    [],
    new Date(),
    { ...permit, extra: true },
    { ...permit, [Symbol('hidden')]: true },
  ])
    assert.throws(() => parseIssuerPermit(input));
  for (const field of Object.keys(permit)) {
    const input: Record<string, unknown> = { ...permit };
    delete input[field];
    assert.throws(() => parseIssuerPermit(input));
  }
  for (const field of ['keyVersion', 'nonce', 'validUntil']) {
    for (const value of ['01', '-1', '1e3', ' 1', 1, 1n, '9'.repeat(1000)])
      assert.throws(() => parseIssuerPermit({ ...permit, [field]: value }));
  }
  for (const field of ['keyVersion', 'validUntil']) {
    assert.throws(() => parseIssuerPermit({ ...permit, [field]: '0' }));
    assert.throws(() =>
      parseIssuerPermit({ ...permit, [field]: (1n << 64n).toString() }),
    );
  }
  assert.throws(() =>
    parseIssuerPermit({ ...permit, nonce: (1n << 256n).toString() }),
  );
  for (const field of ['requestDigest', 'issuerId'])
    assert.throws(() =>
      parseIssuerPermit({ ...permit, [field]: `0x${'00'.repeat(32)}` }),
    );
});
