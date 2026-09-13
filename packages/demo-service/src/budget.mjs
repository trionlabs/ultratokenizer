import { check, confined, readOwned, readJson, sha256 } from './io.mjs';

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
    remainingActiveWei: (
      integer(review.activeTotalCapWei) - reserved
    ).toString(),
  };
}
