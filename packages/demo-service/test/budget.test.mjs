import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkBudgetReview,
  readContinuationReview,
  resolveProofBudget,
} from '../src/budget.mjs';
import { RuntimeAdapter } from '../src/runtime.mjs';
import {
  writeNew,
  readOwned,
  replaceJson,
  sha256,
  privateDirectory,
} from '../src/io.mjs';

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

async function continuationFixture(t) {
  const f = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  f.review.validUntilUnix = now + 3600;
  for (const [index, retained] of f.review.retainedBudgets.entries()) {
    await replaceJson(join(f.root, retained.path), {
      ...f.created,
      eventHash: (index ? 'cc' : 'bb').repeat(32),
    });
    retained.sha256 = sha256(await readOwned(join(f.root, retained.path)));
  }
  await f.save();
  const old = {
    jobId: '11'.repeat(32),
    documentId: '22'.repeat(32),
    requestDigest: `0x${'11'.repeat(32)}`,
    holderSignature: 'test-only-retained-signature',
    status: 'attention_required',
    detailCode: 'proof_request_rejected',
    reservation: { transactionHash: `0x${'33'.repeat(32)}` },
  };
  const next = { jobId: '55'.repeat(32), documentId: '44'.repeat(32) };
  const continuation = {
    format: 'ultratokenizer.demo-continuation.v1',
    validUntilUnix: now + 1800,
    aggregateReviewSha256: sha256(await readOwned(join(f.root, 'review.json'))),
    nextDocumentId: next.documentId,
    retainedJob: {
      jobId: old.jobId,
      documentId: old.documentId,
      requestDigest: old.requestDigest,
      budgetPath: 'old-a.jsonl',
      budgetId: 'bb'.repeat(32),
      paidRequestId: `0x${'66'.repeat(32)}`,
      reservationTransactionHash: old.reservation.transactionHash,
      mode: 'observe-only',
    },
  };
  f.config.continuationReviewPath = 'continuation.json';
  f.config.storePath = 'jobs';
  await writeNew(join(f.root, 'continuation.json'), continuation);
  const folder = join(f.root, 'jobs', old.jobId);
  await privateDirectory(folder);
  await writeNew(join(folder, 'job.sp1-network-request.jsonl'), {
    body: {
      event: 'prepared',
      plan: { budgetId: continuation.retainedJob.budgetId },
    },
  });
  return { ...f, now, old, next, continuation, folder };
}

await test('new dispatch binds the approved budget while legacy recovery keeps the original budget after activation', async (t) => {
  const f = await continuationFixture(t);
  const selected = await resolveProofBudget(
    f.root,
    f.config,
    f.next,
    undefined,
    { newJob: true, now: f.now },
  );
  assert.deepEqual(selected, {
    path: 'new.jsonl',
    id: 'aa'.repeat(32),
    requester,
  });
  assert.deepEqual(
    await resolveProofBudget(f.root, f.config, f.old, f.folder),
    { path: 'old-a.jsonl', id: 'bb'.repeat(32), requester },
  );
  const restarted = JSON.parse(
    JSON.stringify({
      ...f.next,
      holderSignature: 'retained',
      proofBudget: selected,
    }),
  );
  assert.deepEqual(
    await resolveProofBudget(f.root, f.config, restarted),
    selected,
  );
  await assert.rejects(
    resolveProofBudget(
      f.root,
      f.config,
      { ...f.next, documentId: '77'.repeat(32) },
      undefined,
      { newJob: true, now: f.now },
    ),
  );
  await assert.rejects(
    resolveProofBudget(f.root, f.config, f.old, f.folder, {
      newJob: true,
      now: f.now,
    }),
  );
});

await test('missing legacy identity, wrong snapshot, changed retained budget and changed aggregate review fail closed', async (t) => {
  const f = await continuationFixture(t);
  await assert.rejects(
    resolveProofBudget(f.root, f.config, { ...f.old }, join(f.root, 'missing')),
  );
  await assert.rejects(
    resolveProofBudget(f.root, f.config, {
      ...f.old,
      proofBudget: { path: 'new.jsonl', id: 'bb'.repeat(32), requester },
    }),
  );
  await assert.rejects(
    resolveProofBudget(f.root, f.config, {
      ...f.old,
      proofBudget: {
        path: 'old-a.jsonl',
        id: 'bb'.repeat(32),
        requester: `0x${'99'.repeat(20)}`,
      },
    }),
  );
  await appendFile(join(f.root, 'old-a.jsonl'), '\n');
  await assert.rejects(resolveProofBudget(f.root, f.config, f.old, f.folder));
  f.review.priceUsd = '9';
  await f.save();
  await assert.rejects(readContinuationReview(f.root, f.config, f.now));
});

await test('expired new-spend approval cannot remove read-only access to the original paid budget', async (t) => {
  const f = await continuationFixture(t);
  await assert.rejects(readContinuationReview(f.root, f.config, f.now + 7200));
  const selected = await resolveProofBudget(f.root, f.config, f.old, f.folder, {
    now: f.now + 7200,
  });
  assert.equal(selected.id, 'bb'.repeat(32));
  assert.equal(selected.path, 'old-a.jsonl');
});

await test('dispatch rechecks the selected document and continuation expiry after signature persistence', async (t) => {
  const f = await continuationFixture(t);
  const runtime = new RuntimeAdapter(f.root, f.config);
  runtime.assertOperationsEnabled = async () => {};
  const proofBudget = await runtime.selectProofBudget(f.next);
  const signed = { ...f.next, holderSignature: 'retained', proofBudget };
  assert.deepEqual(await runtime.assertProofDispatch(signed), proofBudget);
  await assert.rejects(
    runtime.assertProofDispatch({ ...signed, documentId: '99'.repeat(32) }),
    { code: 'operations_disabled' },
  );
  await assert.rejects(runtime.assertProofDispatch(f.old, f.folder), {
    code: 'operations_disabled',
  });
  f.continuation.validUntilUnix = f.now - 1;
  await replaceJson(join(f.root, 'continuation.json'), f.continuation);
  await assert.rejects(runtime.assertProofDispatch(signed), {
    code: 'operations_disabled',
  });
  // The same guard runs before the reservation ledger is opened.
  await assert.rejects(runtime.reserveOnce(signed), {
    code: 'operations_disabled',
  });
  assert.equal(
    (await resolveProofBudget(f.root, f.config, f.old, f.folder)).path,
    'old-a.jsonl',
  );
});

await test('retained-job exception requires exact paid identity, reservation and explicit observer mode', async (t) => {
  const f = await continuationFixture(t);
  const runtime = new RuntimeAdapter(f.root, f.config);
  let paidRequestId = f.continuation.retainedJob.paidRequestId;
  runtime.checkSubmittedProofRecovery = async () => ({
    requestId: paidRequestId,
  });
  const admission = await runtime.dispatchAdmission([f.old], new Map());
  assert.deepEqual(admission, {
    nextDocumentId: f.next.documentId,
    retainedJobIds: [f.old.jobId],
  });
  assert.deepEqual(
    await runtime.dispatchAdmission(
      [{ ...f.old, status: 'proving' }],
      new Map([[f.old.jobId, 'observe']]),
    ),
    admission,
  );
  await assert.rejects(
    runtime.dispatchAdmission([f.old], new Map([[f.old.jobId, 'dispatch']])),
  );
  await assert.rejects(
    runtime.dispatchAdmission([{ ...f.old, status: 'proving' }], new Map()),
  );
  await assert.rejects(
    runtime.dispatchAdmission(
      [{ ...f.old, detailCode: 'reservation_uncertain' }],
      new Map(),
    ),
  );
  await assert.rejects(
    runtime.dispatchAdmission(
      [{ ...f.old, reservation: { transactionHash: `0x${'99'.repeat(32)}` } }],
      new Map(),
    ),
  );
  paidRequestId = `0x${'99'.repeat(32)}`;
  await assert.rejects(runtime.dispatchAdmission([f.old], new Map()));
});
