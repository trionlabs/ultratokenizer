import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { check, readJson, readOwned, sha256 } from './io.mjs';

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
