import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBudgetReview } from '../src/budget.mjs';
import { RuntimeAdapter } from '../src/runtime.mjs';
import { writeNew, readOwned, replaceJson, sha256 } from '../src/io.mjs';

const requester = `0x${'11'.repeat(20)}`;
const cap = '500000000000000000';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ut-demo-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = {
    eventHash: 'aa'.repeat(32),
    body: {
      event: 'created',
      requester,
      single_cap_wei: cap,
      total_cap_wei: cap,
    },
  };
  const retained = [];
  for (const path of ['old-a.jsonl', 'old-b.jsonl']) {
    await writeNew(join(root, path), created);
    retained.push({
      path,
      sha256: sha256(await readOwned(join(root, path))),
      maximumLiabilityWei: cap,
    });
  }
  await writeNew(join(root, 'new.jsonl'), created);
  const review = {
    format: 'ultratokenizer.demo-budget-review.v1',
    distinctDocumentsOnly: true,
    validUntilUnix: 200,
    requester,
    retainedBudgets: retained,
    activeBudgetPath: 'new.jsonl',
    activeBudgetId: created.eventHash,
    activeTotalCapWei: cap,
    activeSingleCapWei: cap,
    aggregateMaximumWei: '1500000000000000000',
    priceUsd: '0.20',
    authorizedUsdCap: '3',
    priceMargin: 2,
  };
  await writeNew(join(root, 'review.json'), review);
  const config = {
    budgetReviewPath: 'review.json',
    network: { budgetPath: 'new.jsonl', requesterAddress: requester },
  };
  return {
    root,
    config,
    review,
    created,
    check: () => checkBudgetReview(root, config, 100),
    save: () => replaceJson(join(root, 'review.json'), review),
  };
}
await test('aggregate review retains both old caps and permits one distinct bounded budget', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.check(), {
    aggregateMaximumWei: '1500000000000000000',
    activeSingleCapWei: cap,
    remainingActiveWei: cap,
  });
});
await test('active budget can append a reservation without invalidating its identity', async (t) => {
  const f = await fixture(t);
  await appendFile(
    join(f.root, 'new.jsonl'),
    JSON.stringify({
      body: {
        event: 'reserved',
        request_identity: 'aa'.repeat(32),
        maximum_cost_wei: '400000000000000000',
      },
    }) + '\n',
  );
  assert.equal((await f.check()).remainingActiveWei, '100000000000000000');
});
await test('insufficient new-job budget cannot block the already-funded job or its permit', async (t) => {
  const f = await fixture(t);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  f.review.validUntilUnix = expires;
  await f.save();
  f.config.operationsEnabled = true;
  Object.assign(f.config.network, {
    privateStdinEnabled: true,
    disclosureApproved: true,
    approvalValidUntilUnix: expires,
  });
  const runtime = new RuntimeAdapter(f.root, f.config);
  assert.equal((await runtime.readiness()).canStart, true);
  await appendFile(
    join(f.root, 'new.jsonl'),
    JSON.stringify({
      body: {
        event: 'reserved',
        request_identity: 'aa'.repeat(32),
        maximum_cost_wei: '412203857100000000',
      },
    }) + '\n',
  );
  assert.deepEqual(await runtime.readiness(), {
    canStart: false,
    blocker: 'proof_budget_unavailable',
  });
  assert.deepEqual(await runtime.readiness({ newJob: false }), {
    canStart: true,
  });
  runtime.configuration = async (options) => ({
    readiness: await runtime.readiness(options),
  });
  await runtime.assertOperationsEnabled();
  await assert.rejects(runtime.assertOperationsEnabled({ newJob: true }), {
    code: 'proof_budget_unavailable',
  });
});
await test('same-cap replacement budget and changed retained journal are rejected', async (t) => {
  const f = await fixture(t);
  await replaceJson(join(f.root, 'new.jsonl'), {
    ...f.created,
    eventHash: 'bb'.repeat(32),
  });
  await assert.rejects(f.check(), { code: 'operations_disabled' });
  await replaceJson(join(f.root, 'new.jsonl'), f.created);
  await appendFile(join(f.root, 'old-a.jsonl'), '\n');
  await assert.rejects(f.check(), { code: 'operations_disabled' });
});
await test('expired review, understated old liability and excess USD exposure fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(checkBudgetReview(f.root, f.config, 200), {
    code: 'operations_disabled',
  });
  f.review.aggregateMaximumWei = cap;
  await f.save();
  await assert.rejects(f.check(), { code: 'operations_disabled' });
  f.review.aggregateMaximumWei = '1500000000000000000';
  f.review.priceUsd = '2';
  await f.save();
  await assert.rejects(f.check(), { code: 'operations_disabled' });
});
await test('cumulative reservations and duplicate paid identities cannot exceed the budget', async (t) => {
  const f = await fixture(t);
  const reserved = {
    body: {
      event: 'reserved',
      request_identity: 'ab'.repeat(32),
      maximum_cost_wei: '400000000000000000',
    },
  };
  await appendFile(
    join(f.root, 'new.jsonl'),
    JSON.stringify(reserved) + '\n' + JSON.stringify(reserved) + '\n',
  );
  await assert.rejects(f.check(), { code: 'operations_disabled' });
});
