import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bundleModule, requestFixture } from './helpers.mjs';

const loaded = await bundleModule('../src/auth.ts');
after(loaded.cleanup);
const { authenticate } = loaded.module;
const keys = await generateKeyPair('RS256', { modulusLength: 2048 });
const publicKey = {
  ...(await exportJWK(keys.publicKey)),
  alg: 'RS256',
  kid: 'test-key',
  use: 'sig',
};
const config = {
  issuer: 'https://identity.synthetic.invalid/',
  audience: 'ultratokenizer-api',
  jwks: JSON.stringify({ keys: [publicKey] }),
};
const now = 2_000_000_000;
async function token(overrides = {}, header = {}) {
  return `Bearer ${await new SignJWT({ iss: config.issuer, aud: config.audience, sub: 'holder', wallet: requestFixture.recipient, iat: now, exp: now + 300, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt', ...header }).sign(keys.privateKey)}`;
}

void test('authenticates a short-lived access token without persisting raw subject or token', async () => {
  const principal = await authenticate(
    await token(),
    config,
    new Date(now * 1000),
  );
  assert.equal(principal.wallet, requestFixture.recipient);
  assert.match(principal.ownerId, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(principal).includes('holder'), false);
  assert.equal(Object.keys(principal).length, 2);
});

void test('rejects expired, future, wrong-scope, missing-wallet and wrong-type tokens', async () => {
  for (const overrides of [
    { exp: now },
    { iat: now + 1 },
    { iss: 'https://wrong.invalid/' },
    { aud: 'other' },
    { wallet: '' },
    { sub: '' },
    { exp: now + 301 },
    { iat: now - 301, exp: now + 1 },
  ]) {
    await assert.rejects(
      authenticate(await token(overrides), config, new Date(now * 1000)),
      { message: 'unauthorized' },
    );
  }
  await assert.rejects(
    authenticate(await token({}, { typ: 'JWT' }), config, new Date(now * 1000)),
    { message: 'unauthorized' },
  );
  await assert.rejects(
    authenticate(
      await token({}, { kid: 'other' }),
      config,
      new Date(now * 1000),
    ),
    { message: 'unauthorized' },
  );
});

void test('empty trust configuration and private keys fail closed', async () => {
  for (const jwks of [
    '{"keys":[]}',
    '{',
    JSON.stringify({ keys: [{ ...publicKey, d: 'private' }] }),
  ]) {
    await assert.rejects(
      authenticate(await token(), { ...config, jwks }, new Date(now * 1000)),
      { message: 'not_configured' },
    );
  }
  await assert.rejects(
    authenticate('Bearer ' + 'x'.repeat(9000), config, new Date(now * 1000)),
    { message: 'unauthorized' },
  );
});

void test('untrusted signatures cannot select their own identity provider key', async () => {
  const attacker = await generateKeyPair('RS256', { modulusLength: 2048 });
  const forged = await new SignJWT({
    iss: config.issuer,
    aud: config.audience,
    sub: 'holder',
    wallet: requestFixture.recipient,
    iat: now,
    exp: now + 300,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: 'test-key',
      typ: 'at+jwt',
      jwk: await exportJWK(attacker.publicKey),
    })
    .sign(attacker.privateKey);
  await assert.rejects(
    authenticate(`Bearer ${forged}`, config, new Date(now * 1000)),
    { message: 'unauthorized' },
  );
});
