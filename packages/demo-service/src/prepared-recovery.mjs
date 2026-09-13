import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { check, readJson, readOwned, sha256 } from './io.mjs';
import { parseDuplicateFreeJson } from '../../../dist/domain/src/index.js';

const ALLOWED = new Set([
  'job.json',
  'events.jsonl',
  'reservation-send.intent.json',
  'reservation-send.signed.json',
  'reservation-send.dispatch.json',
  'reservation-hash.json',
  'reservation.json',
  'request.json',
  'review.json',
  'job.sp1-network-preparation.json',
]);

/** Reuse only the local, pre-upload boundary. Any later artifact is ambiguous. */
export async function checkPreparedRecovery(
  folder,
  job,
  expectedReview,
  program,
) {
  const names = await readdir(folder);
  check(
    names.every((name) => ALLOWED.has(name)),
    'proof_request_uncertain',
  );
  return checkArtifacts(folder, job, expectedReview, program);
}

async function checkArtifacts(folder, job, expectedReview, program) {
  const requestBytes = await readOwned(join(folder, 'request.json'), 16 * 1024);
  const reviewBytes = await readOwned(join(folder, 'review.json'), 16 * 1024);
  const [request, review, preparation, reservation, hash] = await Promise.all([
    readJson(join(folder, 'request.json'), 16 * 1024),
    readJson(join(folder, 'review.json'), 16 * 1024),
    readJson(join(folder, 'job.sp1-network-preparation.json'), 64 * 1024),
    readJson(join(folder, 'reservation.json'), 64 * 1024),
    readJson(join(folder, 'reservation-hash.json'), 1024),
  ]);
  check(
    isDeepStrictEqual(request, job.request) &&
      isDeepStrictEqual(review, expectedReview) &&
      isDeepStrictEqual(reservation, job.reservation) &&
      hash.transactionHash === job.reservation.transactionHash &&
      preparation.schemaVersion === 2 &&
      preparation.status === 'prepared_no_upload' &&
      preparation.proofMode === 'groth16' &&
      preparation.fixtureKind === 'reviewed-synthetic-deployment-v2' &&
      preparation.networkUploadOccurred === false &&
      preparation.proofRequestSubmitted === false &&
      preparation.requestDigest === job.requestDigest &&
      preparation.requestJsonSha256 === sha256(requestBytes) &&
      preparation.pdfSha256 === job.documentId &&
      preparation.reviewManifestSha256 === sha256(reviewBytes) &&
      isDeepStrictEqual(preparation.reviewedSynthetic, review) &&
      preparation.programVKey === program.programVKey &&
      preparation.elfSha256 === program.elfSha256,
    'preparation_failed',
  );
  // Rust staging re-derives the signed PDF witness and validates the preparation
  // seal before any upload. This guard does not replace that verifier.
  return { preparation, reviewHash: sha256(reviewBytes) };
}

/** Bind an existing acknowledged request; never establish new spending permission. */
export async function checkSubmittedRecovery(
  folder,
  job,
  expectedReview,
  program,
  budgetPath,
  requester,
) {
  const names = await readdir(folder);
  const allowed = new Set([
    ...ALLOWED,
    'prepared-proof-recovery.json',
    'job.sp1-network-staging.jsonl',
    'job.sp1-network-quote.json',
    'job.sp1-network-submission.json',
    'job.sp1-network-request.jsonl',
  ]);
  check(
    names.every((name) => allowed.has(name)),
    'proof_request_uncertain',
  );
  const { preparation } = await checkArtifacts(
    folder,
    job,
    expectedReview,
    program,
  );
  const readRows = async (path, maximum) => {
    const bytes = await readOwned(path, maximum);
    check(bytes.at(-1) === 10, 'proof_request_uncertain');
    return {
      bytes,
      rows: bytes
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => parseDuplicateFreeJson(line, maximum)),
    };
  };
  const { bytes, rows } = await readRows(
    join(folder, 'job.sp1-network-request.jsonl'),
    2 * 1024 * 1024,
  );
  const budget = (await readRows(budgetPath, 128 * 1024)).rows;
  const plan = rows[0]?.body?.plan;
  check(
    rows[0]?.body?.event === 'prepared' &&
      plan &&
      isDeepStrictEqual(plan.preparation, preparation) &&
      plan.quote.requester.toLowerCase() === requester.toLowerCase() &&
      budget[0]?.body?.event === 'created' &&
      budget[0].body.requester.toLowerCase() === requester.toLowerCase() &&
      plan.budgetId === budget[0].eventHash &&
      budget.some(
        (row) =>
          row.body?.event === 'reserved' &&
          row.body.plan_id === plan.planId &&
          row.body.request_identity === plan.requestIdentity &&
          row.body.maximum_cost_wei === plan.quote.maxRequestCostWei,
      ) &&
      rows.some((row) => row.body?.event === 'signed') &&
      rows.some((row) => row.body?.event === 'dispatch_attempted'),
    'proof_request_uncertain',
  );
  const known = rows.filter((row) =>
    ['acknowledged', 'recovered'].includes(row.body?.event),
  );
  const id = known[0]?.body?.request_id;
  const hash = known[0]?.body?.transaction_hash;
  check(
    typeof id === 'string' &&
      /^0x[0-9a-f]{64}$/.test(id) &&
      typeof hash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(hash) &&
      known.every(
        (row) =>
          row.body.request_id === id && row.body.transaction_hash === hash,
      ) &&
      Number.isSafeInteger(plan.settings.deadlineUnix) &&
      plan.settings.deadlineUnix > 0,
    'proof_request_uncertain',
  );
  // The Rust observer authenticates the full hash chain, signed body and exact
  // remote request before reporting an observation. Node only admits the binding.
  return {
    journalHash: sha256(bytes),
    deadline: plan.settings.deadlineUnix,
    requestId: id,
    transactionHash: hash,
  };
}
