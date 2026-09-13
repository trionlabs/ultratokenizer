import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  getIssuanceRequestDigest,
  parseDuplicateFreeJson,
} from '../../../dist/domain/src/index.js';
import {
  check,
  confined,
  exact,
  privateDirectory,
  readJson,
  readOwned,
  runJson,
  sha256,
  writeNew,
  ServiceError,
} from './io.mjs';

const LIMITS = {
  preparation: 64 * 1024,
  requestJournal: 2 * 1024 * 1024,
  budget: 128 * 1024,
  rawProof: 1024 * 1024,
  normalizedProof: 1024 * 1024,
  retrieval: 16 * 1024,
  originAdmission: 16 * 1024,
};
const SOURCE_PREFIX =
  'work/runtime/hedera-testnet/document-flow/public-control-demo04/';
const OUTPUT_PREFIX = 'work/runtime/hedera-testnet/verified-proof-import/';

async function pinnedFile(root, pin, maximum) {
  exact(pin, ['path', 'sha256']);
  check(/^[0-9a-f]{64}$/.test(pin.sha256), 'proof_invalid');
  const path = confined(root, pin.path);
  check(
    relative(root, path) === pin.path && (await realpath(path)) === path,
    'proof_invalid',
  );
  const bytes = await readOwned(path, maximum);
  check(sha256(bytes) === pin.sha256, 'proof_invalid');
  return { path, bytes };
}
const json = (bytes) =>
  parseDuplicateFreeJson(bytes.toString('utf8'), bytes.length);
function rows(bytes) {
  check(bytes.at(-1) === 10, 'proof_invalid');
  return bytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => parseDuplicateFreeJson(line, 2 * 1024 * 1024));
}

/** Read-only until every artifact is pinned. No witness, URI or signature is logged. */
export async function readProofImport(runtime, reviewPath, reviewSha256) {
  const root = await realpath(runtime.root);
  const reviewFile = await pinnedFile(
    root,
    { path: reviewPath, sha256: reviewSha256 },
    32 * 1024,
  );
  const review = exact(json(reviewFile.bytes), [
    'format',
    'purpose',
    'jobId',
    'requestDigest',
    'reservationTransactionHash',
    'originalRequestJournalSha256',
    'originalBudgetSha256',
    'outputPath',
    'source',
  ]);
  check(
    review.format === 'ultratokenizer.verified-proof-import.v1' &&
      review.purpose === 'adopt-separate-public-synthetic-proof' &&
      /^[0-9a-f]{64}$/.test(review.jobId) &&
      review.requestDigest === `0x${review.jobId}` &&
      /^0x[0-9a-f]{64}$/.test(review.reservationTransactionHash) &&
      /^[0-9a-f]{64}$/.test(review.originalRequestJournalSha256) &&
      /^[0-9a-f]{64}$/.test(review.originalBudgetSha256) &&
      review.outputPath === `${OUTPUT_PREFIX}${review.jobId}`,
    'proof_invalid',
  );
  exact(review.source, Object.keys(LIMITS));
  const artifacts = {};
  for (const [name, maximum] of Object.entries(LIMITS)) {
    const pin = review.source[name];
    check(
      name === 'originAdmission'
        ? pin.path === runtime.config.network.originAdmissionPath
        : pin.path.startsWith(SOURCE_PREFIX),
      'proof_invalid',
    );
    artifacts[name] = await pinnedFile(root, pin, maximum);
  }
  check(
    new Set(Object.values(artifacts).map((entry) => entry.path)).size ===
      Object.keys(LIMITS).length,
    'proof_invalid',
  );
  return { root, review, reviewSha256, artifacts };
}

/** Operator-only: caller must own JobStore's exclusive process lock. No HTTP route. */
export async function importVerifiedProof(service, input, command = runJson) {
  const { runtime, store } = service;
  const { root, review, reviewSha256, artifacts } = input;
  check(store.lock && service.running.size === 0, 'proof_request_uncertain');
  return store.serial(async () => {
    const job = store.get(review.jobId);
    check(
      job.status === 'attention_required' &&
        job.phase === 'proof' &&
        !job.proof &&
        !job.bundle &&
        !job.proofImport &&
        job.reservation &&
        job.requestDigest === review.requestDigest &&
        getIssuanceRequestDigest(job.request) === review.requestDigest &&
        job.reservation.transactionHash === review.reservationTransactionHash,
      'proof_request_uncertain',
    );
    await service.authenticate(job, { holderSignature: job.holderSignature });
    await runtime.assertOperationsEnabled({ newJob: false });
    const folder = store.directory(job.jobId);
    const originalJournal = join(folder, 'job.sp1-network-request.jsonl');
    const originalBudget = confined(root, runtime.config.network.budgetPath);
    const unchanged = async () => {
      check(
        sha256(await readOwned(originalJournal, 2 * 1024 * 1024)) ===
          review.originalRequestJournalSha256 &&
          sha256(await readOwned(originalBudget, 128 * 1024)) ===
            review.originalBudgetSha256,
        'proof_request_uncertain',
      );
      for (const [name, maximum] of Object.entries(LIMITS))
        await pinnedFile(root, review.source[name], maximum);
    };
    await unchanged();
    const original = await runtime.checkSubmittedProofRecovery(job, folder);
    await runtime.assertReservationUnused(job);
    const preparation = json(artifacts.preparation.bytes);
    const originalPreparation = await readJson(
      join(folder, 'job.sp1-network-preparation.json'),
      64 * 1024,
    );
    const journal = rows(artifacts.requestJournal.bytes);
    const plan = journal[0]?.body?.plan;
    const budget = rows(artifacts.budget.bytes);
    const retrieval = json(artifacts.retrieval.bytes);
    check(
      isDeepStrictEqual(preparation, originalPreparation) &&
        isDeepStrictEqual(plan?.preparation, originalPreparation) &&
        preparation.requestDigest === job.requestDigest &&
        preparation.pdfSha256 === job.documentId &&
        preparation.programVKey === runtime.program.programVKey &&
        preparation.elfSha256 === runtime.program.elfSha256 &&
        plan.publicDisclosure?.purpose === 'public-synthetic-sp1-control' &&
        plan.publicDisclosure.authorizedPublicDisclosure === true &&
        plan.publicDisclosure.preparationId === preparation.preparationId &&
        budget[0]?.body?.event === 'created' &&
        budget[0].eventHash === plan.budgetId &&
        budget.some(
          (row) =>
            row.body?.event === 'reserved' &&
            row.body.plan_id === plan.planId &&
            row.body.request_identity === plan.requestIdentity &&
            row.body.maximum_cost_wei === plan.quote.maxRequestCostWei,
        ) &&
        artifacts.budget.path !== originalBudget &&
        artifacts.requestJournal.path !== originalJournal &&
        retrieval.format === 'ultratokenizer.retrieved-proof.v1' &&
        retrieval.status === 'downloaded_unverified' &&
        retrieval.requestJournalSha256 ===
          review.source.requestJournal.sha256 &&
        retrieval.normalizedSha256 === review.source.normalizedProof.sha256 &&
        retrieval.normalizedBytes === artifacts.normalizedProof.bytes.length &&
        retrieval.artifactSha256 === review.source.rawProof.sha256 &&
        retrieval.artifactBytes === artifacts.rawProof.bytes.length &&
        retrieval.programVKey === runtime.program.programVKey &&
        retrieval.outerCircuitVersion === preparation.outerCircuitVersion &&
        retrieval.publicValuesSha256 === preparation.publicValuesSha256 &&
        retrieval.budgetReleased === false &&
        retrieval.requestId !== original.requestId &&
        journal.some(
          (row) =>
            ['acknowledged', 'recovered'].includes(row.body?.event) &&
            row.body.request_id === retrieval.requestId &&
            row.body.transaction_hash === retrieval.requestTransactionHash,
        ),
      'proof_invalid',
    );
    const output = confined(root, review.outputPath);
    await privateDirectory(output);
    const raw = join(output, 'import-raw.sp1-network-proof');
    const normalized = join(output, 'import-normalized.sp1-network-proof');
    const receipt = join(
      output,
      'import-retrieved.sp1-network-submission.json',
    );
    // The existing requester validates the full paid journal/signature and exact
    // current fulfillment. This command cannot submit or release any budget.
    await command(runtime.path('networkRequesterPath'), [
      'retrieve-proof',
      artifacts.requestJournal.path,
      review.source.requestJournal.sha256,
      artifacts.originAdmission.path,
      raw,
      normalized,
      receipt,
    ]);
    check(
      sha256(await readOwned(raw, 1024 * 1024)) ===
        review.source.rawProof.sha256 &&
        sha256(await readOwned(normalized, 1024 * 1024)) ===
          review.source.normalizedProof.sha256,
      'proof_invalid',
    );
    const freshRetrieval = await readJson(receipt, 16 * 1024);
    for (const key of [
      'requestId',
      'requestTransactionHash',
      'fulfillmentTransactionHash',
      'requestJournalSha256',
      'programVKey',
      'outerCircuitVersion',
      'publicValuesSha256',
    ])
      check(freshRetrieval[key] === retrieval[key], 'proof_invalid');
    const verified = await runtime.verifyGroth16(
      job,
      join(folder, 'request.json'),
      preparation,
      normalized,
      freshRetrieval,
    );
    await runtime.assertReservationUnused(job);
    await unchanged();
    const provenance = {
      format: 'ultratokenizer.verified-proof-import-record.v1',
      reviewSha256,
      requestDigest: job.requestDigest,
      reservationTransactionHash: job.reservation.transactionHash,
      sourceRequestId: retrieval.requestId,
      sourceRequestTransactionHash: retrieval.requestTransactionHash,
      sourceFulfillmentTransactionHash: retrieval.fulfillmentTransactionHash,
      sourceRequestJournalSha256: review.source.requestJournal.sha256,
      sourceBudgetSha256: review.source.budget.sha256,
      sourceRetrievalSha256: review.source.retrieval.sha256,
      normalizedProofSha256: review.source.normalizedProof.sha256,
      originalRequestId: original.requestId,
      originalRequestJournalSha256: review.originalRequestJournalSha256,
      originalBudgetSha256: review.originalBudgetSha256,
      originalBudgetReleased: false,
      newProofRequestSubmitted: false,
      acceptance: verified.acceptance,
      verifiedAt: new Date().toISOString(),
    };
    await writeNew(join(output, 'verified-proof.json'), verified.exported);
    await writeNew(join(output, 'provenance.json'), provenance);
    await store.update(job, {
      status: 'authorizing',
      phase: 'issuance',
      detailCode: null,
      proof: verified.exported,
      proofImport: {
        reviewSha256,
        provenancePath: relative(root, join(output, 'provenance.json')),
      },
    });
    try {
      const bundle = await runtime.permit(job, folder);
      await store.update(job, {
        status: 'ready_to_mint',
        bundle,
        detailCode: null,
      });
    } catch (error) {
      await store.update(job, {
        status: 'attention_required',
        detailCode:
          error instanceof ServiceError ? error.code : 'issuer_unavailable',
      });
    }
    return service.status(job.jobId);
  });
}
