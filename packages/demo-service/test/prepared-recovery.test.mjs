import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPreparedRecovery,
  checkSubmittedRecovery,
} from '../src/prepared-recovery.mjs';
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
  return { check, write, preparation, job, folder, review, program };
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

await test('submitted recovery requires the exact already-reserved paid identity', async (t) => {
  const f = await fixture(t);
  const budgetFolder = await mkdtemp(join(tmpdir(), 'ut-observation-budget-'));
  t.after(() => rm(budgetFolder, { recursive: true, force: true }));
  const budgetPath = join(budgetFolder, 'budget.jsonl');
  const requester = `0x${'66'.repeat(20)}`;
  const budgetId = '88'.repeat(32);
  const requestId = `0x${'99'.repeat(32)}`;
  const transactionHash = `0x${'aa'.repeat(32)}`;
  const plan = {
    preparation: f.preparation,
    budgetId,
    planId: 'same-plan',
    requestIdentity: 'same-paid-identity',
    quote: { requester, maxRequestCostWei: '123' },
    settings: { deadlineUnix: 1800000000 },
  };
  const rows = [
    { body: { event: 'prepared', plan } },
    { body: { event: 'signed' } },
    { body: { event: 'dispatch_attempted' } },
    {
      body: {
        event: 'acknowledged',
        request_id: requestId,
        transaction_hash: transactionHash,
      },
    },
  ];
  const budget = [
    { eventHash: budgetId, body: { event: 'created', requester } },
    {
      body: {
        event: 'reserved',
        plan_id: plan.planId,
        request_identity: plan.requestIdentity,
        maximum_cost_wei: '123',
      },
    },
  ];
  const writeRows = (path, input) =>
    writeFile(path, input.map((row) => JSON.stringify(row) + '\n').join(''), {
      mode: 0o600,
    });
  const requestPath = join(f.folder, 'job.sp1-network-request.jsonl');
  await writeRows(requestPath, rows);
  await writeRows(budgetPath, budget);
  const check = () =>
    checkSubmittedRecovery(
      f.folder,
      f.job,
      f.review,
      f.program,
      budgetPath,
      requester,
    );
  assert.equal((await check()).requestId, requestId);
  await writeRows(budgetPath, [budget[0]]);
  await assert.rejects(check(), { code: 'proof_request_uncertain' });
  await writeRows(budgetPath, budget);
  await writeRows(requestPath, [
    ...rows,
    {
      body: {
        event: 'recovered',
        request_id: `0x${'bb'.repeat(32)}`,
        transaction_hash: transactionHash,
      },
    },
  ]);
  await assert.rejects(check(), { code: 'proof_request_uncertain' });
  await writeRows(requestPath, rows.slice(0, 3));
  await assert.rejects(check(), { code: 'proof_request_uncertain' });
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
