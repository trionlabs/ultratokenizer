import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPreparedRecovery } from '../src/prepared-recovery.mjs';
import { sha256 } from '../src/io.mjs';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'ut-prepared-recovery-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const write = (name, value) =>
    writeFile(join(folder, name), JSON.stringify(value) + '\n', {
      mode: 0o600,
    });
  const request = { requestId: 'same request' };
  const requestBytes = Buffer.from(JSON.stringify(request) + '\n');
  const review = { requestDigest: `0x${'11'.repeat(32)}` };
  const reviewBytes = Buffer.from(JSON.stringify(review) + '\n');
  const job = {
    request,
    requestDigest: review.requestDigest,
    documentId: '22'.repeat(32),
    reservation: { transactionHash: `0x${'33'.repeat(32)}` },
  };
  const program = {
    programVKey: `0x${'44'.repeat(32)}`,
    elfSha256: '55'.repeat(32),
  };
  const preparation = {
    schemaVersion: 2,
    status: 'prepared_no_upload',
    proofMode: 'groth16',
    fixtureKind: 'reviewed-synthetic-deployment-v2',
    networkUploadOccurred: false,
    proofRequestSubmitted: false,
    requestDigest: job.requestDigest,
    requestJsonSha256: sha256(requestBytes),
    pdfSha256: job.documentId,
    reviewManifestSha256: sha256(reviewBytes),
    reviewedSynthetic: review,
    ...program,
  };
  await Promise.all([
    write('request.json', request),
    write('review.json', review),
    write('job.sp1-network-preparation.json', preparation),
    write('reservation.json', job.reservation),
    write('reservation-hash.json', job.reservation),
  ]);
  const check = () => checkPreparedRecovery(folder, job, review, program);
  return { check, write, preparation, job };
}

await test('only matching local preparation artifacts can be reused', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.check()).preparation.proofRequestSubmitted, false);
  for (const field of [
    'requestDigest',
    'requestJsonSha256',
    'pdfSha256',
    'reviewManifestSha256',
    'programVKey',
    'elfSha256',
  ]) {
    await f.write('job.sp1-network-preparation.json', {
      ...f.preparation,
      [field]: 'altered',
    });
    await assert.rejects(f.check(), { code: 'preparation_failed' });
  }
});

for (const name of [
  'job.sp1-network-staging.jsonl',
  'job.sp1-network-quote.json',
  'job.sp1-network-request.jsonl',
  'prepared-proof-recovery.json',
]) {
  await test(`existing ${name} prevents pre-dispatch recovery`, async (t) => {
    const f = await fixture(t);
    await f.write(name, {});
    await assert.rejects(f.check(), { code: 'proof_request_uncertain' });
  });
}

await test('request, review and reservation substitution are rejected', async (t) => {
  const f = await fixture(t);
  await f.write('request.json', { ...f.job.request, recipient: 'other' });
  await assert.rejects(f.check(), { code: 'preparation_failed' });
  await f.write('request.json', f.job.request);
  await f.write('reservation.json', {
    transactionHash: `0x${'77'.repeat(32)}`,
  });
  await assert.rejects(f.check(), { code: 'preparation_failed' });
});
