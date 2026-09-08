import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createJourney, transition } from '../src/lib/domain/journey.ts';

// Bundle the same adapter used by the app, resolving the domain's .js imports.
const scratch = await mkdtemp(join(tmpdir(), 'ultratokenizer-receipt-'));
after(() => rm(scratch, { recursive: true, force: true }));
await build({
  configFile: false,
  logLevel: 'silent',
  ssr: { noExternal: true },
  build: {
    ssr: fileURLToPath(
      new URL('../src/lib/adapters/sample-receipt.ts', import.meta.url),
    ),
    outDir: scratch,
    target: 'esnext',
    rollupOptions: { output: { entryFileNames: 'sample-receipt.mjs' } },
  },
});
const { createSampleReceipt, verifySampleReceipt, MAX_RECEIPT_BYTES } =
  await import(pathToFileURL(join(scratch, 'sample-receipt.mjs')).href);

function complete() {
  let journey = transition(createJourney(), {
    type: 'load_sample',
    scenario: 'supported',
  });
  journey = transition(journey, {
    type: 'review',
    grams: '1.250',
    consent: true,
  });
  for (const check of ['subject', 'reservation', 'rights'])
    journey = transition(journey, {
      type: 'issuer_check',
      check,
      checked: true,
    });
  journey = transition(journey, { type: 'authorize' });
  journey = transition(journey, { type: 'prove', succeeds: true });
  return transition(journey, { type: 'mint', succeeds: true });
}

test('a completed sample round-trips independently and an unfinished flow cannot export', () => {
  assert.throws(
    () => createSampleReceipt(createJourney()),
    /Complete the sample/,
  );
  const receipt = createSampleReceipt(complete());
  const checked = verifySampleReceipt(JSON.stringify(receipt));
  assert.equal(checked.request.amount, '1250');
  assert.equal(checked.requestDigest, receipt.requestDigest);
  assert.equal(checked.mode, 'simulation');
  assert.ok(
    Object.values(checked.integrations).every(
      (value) => value === 'not-connected',
    ),
  );
});

test('changes to amount, recipient, issuer, reservation and chain invalidate the saved digest', () => {
  const receipt = createSampleReceipt(complete());
  for (const [key, value] of Object.entries({
    amount: '1251',
    recipient: `0x${'77'.repeat(20)}`,
    issuerId: `0x${'77'.repeat(32)}`,
    reservationId: `0x${'88'.repeat(32)}`,
    chainId: '295',
  })) {
    const changed = {
      ...receipt,
      request: { ...receipt.request, [key]: value },
    };
    assert.throws(
      () => verifySampleReceipt(JSON.stringify(changed)),
      /digest mismatch/,
    );
  }
});

test('a self-authored changed request with a fresh digest is consistent but remains unauthenticated', () => {
  const original = createSampleReceipt(complete());
  const changed = createSampleReceipt({ ...complete(), amountMg: '9999' });
  const checked = verifySampleReceipt(JSON.stringify(changed));
  assert.notEqual(checked.requestDigest, original.requestDigest);
  assert.equal(checked.request.amount, '9999');
  assert.equal(checked.mode, 'simulation');
  assert.ok(
    Object.values(checked.integrations).every(
      (value) => value === 'not-connected',
    ),
  );
});

test('simulation receipts reject authority claims, malformed schemas, invalid JSON and oversized input', () => {
  const receipt = createSampleReceipt(complete());
  for (const value of [
    null,
    [],
    {},
    { ...receipt, mode: 'production' },
    { ...receipt, transactionHash: 'fake' },
    {
      ...receipt,
      integrations: { ...receipt.integrations, chain: 'verified' },
    },
    { ...receipt, request: { ...receipt.request, unexpected: true } },
  ]) {
    assert.throws(() => verifySampleReceipt(JSON.stringify(value)));
  }
  assert.throws(() => verifySampleReceipt('{'), /valid JSON/);
  assert.throws(
    () => verifySampleReceipt(' '.repeat(MAX_RECEIPT_BYTES + 1)),
    /64 KB/,
  );
});
