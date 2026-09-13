import { join } from 'node:path';
import { check, confined, exact, readOwned, readJson, sha256 } from './io.mjs';

const UNIT = 10n ** 18n;
function integer(value) {
  check(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value),
    'operations_disabled',
  );
  return BigInt(value);
}
function usd(value) {
  check(
    typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value),
    'operations_disabled',
  );
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
}
/** Conservative liability review; the requester separately authenticates each budget journal. */
export async function checkBudgetReview(root, config, now) {
  const review = await readJson(
    confined(root, config.budgetReviewPath),
    16 * 1024,
  );
  check(
    review.format === 'ultratokenizer.demo-budget-review.v1' &&
      review.distinctDocumentsOnly === true &&
      Number.isSafeInteger(review.validUntilUnix) &&
      now < review.validUntilUnix,
    'operations_disabled',
  );
  check(
    review.activeBudgetPath === config.network.budgetPath &&
      review.requester.toLowerCase() ===
        config.network.requesterAddress.toLowerCase(),
    'operations_disabled',
  );
  check(
    Array.isArray(review.retainedBudgets) &&
      review.retainedBudgets.length >= 2 &&
      review.retainedBudgets.length <= 10,
    'operations_disabled',
  );
  const paths = new Set([review.activeBudgetPath]);
  let maximum = 0n;
  for (const retained of review.retainedBudgets) {
    check(!paths.has(retained.path), 'operations_disabled');
    paths.add(retained.path);
    const bytes = await readOwned(confined(root, retained.path), 128 * 1024);
    check(sha256(bytes) === retained.sha256, 'operations_disabled');
    const first = JSON.parse(bytes.toString('utf8').split('\n')[0]).body;
    check(
      first.event === 'created' &&
        first.requester === review.requester &&
        first.total_cap_wei === retained.maximumLiabilityWei,
      'operations_disabled',
    );
    maximum += integer(retained.maximumLiabilityWei);
  }
  const current = (
    await readOwned(confined(root, review.activeBudgetPath), 128 * 1024)
  )
    .toString('utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  check(
    current[0].eventHash === review.activeBudgetId &&
      /^[0-9a-f]{64}$/.test(review.activeBudgetId),
    'operations_disabled',
  );
  const created = current[0].body;
  check(
    created.event === 'created' &&
      created.requester === review.requester &&
      created.total_cap_wei === review.activeTotalCapWei &&
      created.single_cap_wei === review.activeSingleCapWei,
    'operations_disabled',
  );
  const identities = new Set();
  let reserved = 0n;
  for (const row of current.slice(1)) {
    const entry = row.body;
    check(
      entry.event === 'reserved' && !identities.has(entry.request_identity),
      'operations_disabled',
    );
    identities.add(entry.request_identity);
    const cost = integer(entry.maximum_cost_wei);
    check(
      cost > 0n && cost <= integer(review.activeSingleCapWei),
      'operations_disabled',
    );
    reserved += cost;
  }
  check(reserved <= integer(review.activeTotalCapWei), 'operations_disabled');
  maximum += integer(review.activeTotalCapWei);
  check(maximum === integer(review.aggregateMaximumWei), 'operations_disabled');
  const price = usd(review.priceUsd),
    cap = usd(review.authorizedUsdCap);
  check(
    price > 0n &&
      cap > 0n &&
      cap <= usd('3') &&
      Number.isSafeInteger(review.priceMargin) &&
      review.priceMargin >= 2,
    'operations_disabled',
  );
  check(
    maximum * price * BigInt(review.priceMargin) <= cap * UNIT,
    'operations_disabled',
  );
  return {
    aggregateMaximumWei: maximum.toString(),
    activeSingleCapWei: review.activeSingleCapWei,
    remainingActiveWei: (
      integer(review.activeTotalCapWei) - reserved
    ).toString(),
  };
}

/** An operator-owned exception admits one new document, never another HTTP-selected budget. */
export async function readContinuationReview(root, config, now) {
  if (!config.continuationReviewPath) return undefined;
  const review = await readJson(
    confined(root, config.continuationReviewPath),
    16 * 1024,
  );
  exact(review, [
    'format',
    'validUntilUnix',
    'aggregateReviewSha256',
    'nextDocumentId',
    'retainedJob',
  ]);
  const retained = review.retainedJob;
  exact(retained, [
    'jobId',
    'documentId',
    'requestDigest',
    'budgetPath',
    'budgetId',
    'paidRequestId',
    'reservationTransactionHash',
    'mode',
  ]);
  check(
    review.format === 'ultratokenizer.demo-continuation.v1' &&
      Number.isSafeInteger(review.validUntilUnix) &&
      now < review.validUntilUnix &&
      /^[0-9a-f]{64}$/.test(review.nextDocumentId) &&
      /^[0-9a-f]{64}$/.test(retained.documentId) &&
      review.nextDocumentId !== retained.documentId &&
      /^0x[0-9a-f]{64}$/.test(retained.requestDigest) &&
      retained.jobId === retained.requestDigest.slice(2) &&
      /^[0-9a-f]{64}$/.test(retained.budgetId) &&
      /^0x[0-9a-f]{64}$/.test(retained.paidRequestId) &&
      /^0x[0-9a-f]{64}$/.test(retained.reservationTransactionHash) &&
      retained.mode === 'observe-only' &&
      retained.budgetPath !== config.network.budgetPath &&
      sha256(
        await readOwned(confined(root, config.budgetReviewPath), 16 * 1024),
      ) === review.aggregateReviewSha256,
    'operations_disabled',
  );
  confined(root, retained.budgetPath);
  await checkBudgetReview(root, config, now);
  return review;
}

/** Resolve immutable budget identity, including legacy paid plans, without authorizing spending. */
export async function resolveProofBudget(
  root,
  config,
  job,
  folder,
  { newJob = false, now = Math.floor(Date.now() / 1000) } = {},
) {
  const review = await readJson(
    confined(root, config.budgetReviewPath),
    16 * 1024,
  );
  check(
    review.format === 'ultratokenizer.demo-budget-review.v1' &&
      review.activeBudgetPath === config.network.budgetPath &&
      review.requester.toLowerCase() ===
        config.network.requesterAddress.toLowerCase() &&
      Array.isArray(review.retainedBudgets) &&
      review.retainedBudgets.length <= 10,
    'operations_disabled',
  );
  let binding = job.proofBudget;
  if (newJob) {
    check(
      !job.holderSignature &&
        !binding &&
        !job.reservation &&
        !job.proof &&
        !job.bundle,
      'job_conflict',
    );
    const budget = await checkBudgetReview(root, config, now);
    check(
      BigInt(budget.remainingActiveWei) >= BigInt(budget.activeSingleCapWei),
      'proof_budget_unavailable',
    );
    const continuation = await readContinuationReview(root, config, now);
    check(
      !continuation || continuation.nextDocumentId === job.documentId,
      'operations_disabled',
    );
    binding = {
      path: review.activeBudgetPath,
      id: review.activeBudgetId,
      requester: review.requester,
    };
  } else if (!binding) {
    // Existing paid jobs predate proofBudget. Their retained plan supplies the
    // immutable ID; a missing plan never falls back to today's active budget.
    const rows = (
      await readOwned(
        join(folder, 'job.sp1-network-request.jsonl'),
        2 * 1024 * 1024,
      )
    )
      .toString('utf8')
      .trim()
      .split('\n');
    const first = JSON.parse(rows[0]);
    check(
      first.body?.event === 'prepared' &&
        /^[0-9a-f]{64}$/.test(first.body.plan?.budgetId),
      'proof_request_uncertain',
    );
    binding = { id: first.body.plan.budgetId, requester: review.requester };
  } else {
    exact(binding, ['path', 'id', 'requester']);
  }
  check(
    /^[0-9a-f]{64}$/.test(binding.id) &&
      binding.requester.toLowerCase() === review.requester.toLowerCase(),
    'proof_request_uncertain',
  );
  const candidates = [
    {
      path: review.activeBudgetPath,
      id: review.activeBudgetId,
      maximumLiabilityWei: review.activeTotalCapWei,
    },
    ...review.retainedBudgets,
  ];
  const matches = [];
  for (const candidate of candidates) {
    const bytes = await readOwned(confined(root, candidate.path), 128 * 1024);
    const first = JSON.parse(bytes.toString('utf8').split('\n')[0]);
    check(
      first.body?.event === 'created' &&
        first.body.requester.toLowerCase() === review.requester.toLowerCase() &&
        first.body.total_cap_wei === candidate.maximumLiabilityWei &&
        (candidate.sha256
          ? sha256(bytes) === candidate.sha256
          : first.eventHash === candidate.id),
      'operations_disabled',
    );
    if (
      first.eventHash === binding.id &&
      (!binding.path || binding.path === candidate.path)
    )
      matches.push(candidate.path);
  }
  check(matches.length === 1, 'proof_request_uncertain');
  return Object.freeze({
    path: matches[0],
    id: binding.id,
    requester: review.requester,
  });
}
