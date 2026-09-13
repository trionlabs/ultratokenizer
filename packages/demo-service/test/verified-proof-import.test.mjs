import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseIssuanceRequest,
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
} from '../../../dist/domain/src/index.js';
import { JobStore } from '../src/store.mjs';
import { DemoService } from '../src/service.mjs';
import {
  readProofImport,
  importVerifiedProof,
} from '../src/verified-proof-import.mjs';
import { sha256 } from '../src/io.mjs';

const holder = privateKeyToAccount(`0x${'11'.repeat(32)}`); // Public test account.
const sample = JSON.parse(
  await readFile(
    new URL('../../domain/fixtures/request.synthetic.json', import.meta.url),
    'utf8',
  ),
);
const word = (value) => `0x${value.repeat(64)}`;
const sourcePrefix =
  'work/runtime/hedera-testnet/document-flow/public-control-demo04/';
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'proof-import-test-')),
  );
  const storePath = 'work/runtime/hedera-testnet/document-flow/jobs';
  const store = new JobStore(join(root, storePath));
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const put = async (path, data) => {
    const bytes = Buffer.isBuffer(data)
      ? data
      : Buffer.from(JSON.stringify(data) + '\n');
    await mkdir(join(root, path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), bytes, { mode: 0o600 });
    return { path, sha256: sha256(bytes) };
  };
  const request = parseIssuanceRequest({
    ...sample,
    recipient: holder.address,
    amount: '1000',
    validUntil: '2000000000',
  });
  const digest = getIssuanceRequestDigest(request);
  const id = digest.slice(2);
  const job = await store.create({
    jobId: id,
    request,
    requestDigest: digest,
    documentId: 'ab'.repeat(32),
    holderSignature: await holder.signTypedData(
      getIssuanceRequestTypedData(request),
    ),
    prepared: { request },
    reservation: { transactionHash: word('4') },
    status: 'attention_required',
    phase: 'proof',
    detailCode: 'proof_request_uncertain',
  });
  const preparation = {
    preparationId: word('a'),
    requestDigest: digest,
    pdfSha256: job.documentId,
    programVKey: word('b'),
    elfSha256: 'cc'.repeat(32),
    publicValuesSha256: 'dd'.repeat(32),
    outerCircuitVersion: 'v6.1.0',
  };
  await put(`${storePath}/${id}/job.sp1-network-preparation.json`, preparation);
  await put(`${storePath}/${id}/request.json`, request);
  const originalJournal = await put(
    `${storePath}/${id}/job.sp1-network-request.jsonl`,
    Buffer.from('{"original":"private paid journal"}\n'),
  );
  const originalBudget = await put(
    'work/runtime/hedera-testnet/original.sp1-network-budget.jsonl',
    Buffer.from('{"original":"retained budget"}\n'),
  );
  const budgetId = 'ee'.repeat(32);
  const plan = {
    preparation,
    budgetId,
    planId: 'ff'.repeat(32),
    requestIdentity: '11'.repeat(32),
    quote: { maxRequestCostWei: '100' },
    publicDisclosure: {
      purpose: 'public-synthetic-sp1-control',
      authorizedPublicDisclosure: true,
      preparationId: preparation.preparationId,
    },
  };
  const source = {};
  source.preparation = await put(
    sourcePrefix + 'run.sp1-network-preparation.json',
    preparation,
  );
  source.requestJournal = await put(
    sourcePrefix + 'run.sp1-network-request.jsonl',
    Buffer.from(
      [
        { body: { event: 'prepared', plan } },
        {
          body: {
            event: 'acknowledged',
            request_id: word('2'),
            transaction_hash: word('3'),
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    ),
  );
  source.budget = await put(
    sourcePrefix + 'run.sp1-network-budget.jsonl',
    Buffer.from(
      [
        { eventHash: budgetId, body: { event: 'created' } },
        {
          body: {
            event: 'reserved',
            plan_id: plan.planId,
            request_identity: plan.requestIdentity,
            maximum_cost_wei: '100',
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    ),
  );
  const raw = Buffer.from('synthetic raw transport fixture');
  const normalized = Buffer.from('synthetic normalized transport fixture');
  source.rawProof = await put(sourcePrefix + 'run-raw.sp1-network-proof', raw);
  source.normalizedProof = await put(
    sourcePrefix + 'run-normalized.sp1-network-proof',
    normalized,
  );
  const retrieval = {
    format: 'ultratokenizer.retrieved-proof.v1',
    status: 'downloaded_unverified',
    requestId: word('2'),
    requestTransactionHash: word('3'),
    fulfillmentTransactionHash: word('5'),
    requestJournalSha256: source.requestJournal.sha256,
    artifactSha256: source.rawProof.sha256,
    artifactBytes: raw.length,
    normalizedSha256: source.normalizedProof.sha256,
    normalizedBytes: normalized.length,
    programVKey: preparation.programVKey,
    outerCircuitVersion: preparation.outerCircuitVersion,
    publicValuesSha256: preparation.publicValuesSha256,
    budgetReleased: false,
  };
  source.retrieval = await put(
    sourcePrefix + 'run-retrieved.sp1-network-submission.json',
    retrieval,
  );
  source.originAdmission = await put(
    'work/runtime/hedera-testnet/origin-admission.json',
    { testOnly: true },
  );
  const review = {
    format: 'ultratokenizer.verified-proof-import.v1',
    purpose: 'adopt-separate-public-synthetic-proof',
    jobId: id,
    requestDigest: digest,
    reservationTransactionHash: job.reservation.transactionHash,
    originalRequestJournalSha256: originalJournal.sha256,
    originalBudgetSha256: originalBudget.sha256,
    outputPath: `work/runtime/hedera-testnet/verified-proof-import/${id}`,
    source,
  };
  const counts = { reservationChecks: 0, retrieval: 0, verify: 0, permit: 0 };
  const runtime = {
    root,
    program: preparation,
    config: {
      network: {
        budgetPath: originalBudget.path,
        originAdmissionPath: source.originAdmission.path,
      },
    },
    path: () => 'injected-read-only-requester',
    assertOperationsEnabled: async () => {},
    checkSubmittedProofRecovery: async () => ({ requestId: word('1') }),
    assertReservationUnused: async () => {
      counts.reservationChecks += 1;
    },
    verifyGroth16: async (
      actual,
      requestPath,
      expected,
      proofPath,
      receipt,
    ) => {
      counts.verify += 1;
      assert.equal(actual, job);
      assert.deepEqual(expected, preparation);
      assert.deepEqual(
        JSON.parse(await readFile(requestPath, 'utf8')),
        request,
      );
      assert.deepEqual(await readFile(proofPath), normalized);
      assert.equal(receipt.requestId, retrieval.requestId);
      return {
        exported: { testOnly: true, request },
        acceptance: { testOnly: true },
      };
    },
    permit: async (actual) => {
      counts.permit += 1;
      assert.ok(actual.proof);
      return { request, permit: { validUntil: '2000000000' } };
    },
  };
  const service = new DemoService(runtime, store, () => 1800000000);
  const load = async () => {
    const pin = await put(
      'work/runtime/hedera-testnet/import-review.json',
      review,
    );
    return readProofImport(runtime, pin.path, pin.sha256);
  };
  const command = async (_, args) => {
    counts.retrieval += 1;
    assert.equal(args[0], 'retrieve-proof');
    assert.equal(args[1], join(root, source.requestJournal.path));
    assert.equal(args[2], source.requestJournal.sha256);
    for (const [path, bytes] of [
      [args[4], raw],
      [args[5], normalized],
      [args[6], Buffer.from(JSON.stringify(retrieval))],
    ])
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  };
  return {
    root,
    store,
    job,
    service,
    runtime,
    review,
    counts,
    load,
    command,
    put,
    originalJournal,
    originalBudget,
  };
}

await test('operator imports into the existing job without re-reserving, paying or altering either journal/budget', async (t) => {
  const f = await fixture(t);
  const input = await f.load();
  const result = await importVerifiedProof(f.service, input, f.command);
  assert.equal(result.bundleReady, true);
  assert.deepEqual(f.counts, {
    reservationChecks: 2,
    retrieval: 1,
    verify: 1,
    permit: 1,
  });
  assert.equal(f.store.jobs.size, 1);
  assert.equal(f.job.requestDigest, f.review.requestDigest);
  for (const pin of [
    f.originalJournal,
    f.originalBudget,
    f.review.source.requestJournal,
    f.review.source.budget,
  ])
    assert.equal(sha256(await readFile(join(f.root, pin.path))), pin.sha256);
  const report = JSON.parse(
    await readFile(join(f.root, f.job.proofImport.provenancePath), 'utf8'),
  );
  assert.equal(report.originalBudgetReleased, false);
  assert.equal(report.newProofRequestSubmitted, false);
  assert.notEqual(report.sourceRequestId, report.originalRequestId);
  await assert.rejects(importVerifiedProof(f.service, input, f.command));
  assert.equal(f.counts.permit, 1);
});

for (const failure of [
  'signature',
  'reservation',
  'preparation',
  'native-proof',
  'original-budget-changed',
  'concurrent-observer',
]) {
  await test(`import fails closed for ${failure}`, async (t) => {
    const f = await fixture(t);
    const input = await f.load();
    if (failure === 'signature') f.job.holderSignature = '0x00';
    if (failure === 'reservation')
      f.job.reservation.transactionHash = word('9');
    if (failure === 'preparation') {
      const preparationPath = join(
        f.store.directory(f.job.jobId),
        'job.sp1-network-preparation.json',
      );
      const value = JSON.parse(await readFile(preparationPath, 'utf8'));
      value.requestDigest = word('9');
      await writeFile(preparationPath, JSON.stringify(value));
    }
    if (failure === 'native-proof')
      f.runtime.verifyGroth16 = async () => {
        throw new Error('invalid native proof');
      };
    if (failure === 'original-budget-changed')
      await f.put(f.originalBudget.path, { different: true });
    if (failure === 'concurrent-observer')
      f.service.running.set('other', Promise.resolve());
    await assert.rejects(importVerifiedProof(f.service, input, f.command));
    assert.equal(f.counts.permit, 0);
    assert.equal(f.job.proof, undefined);
    assert.equal(f.job.bundle, undefined);
  });
}

await test('a changed source artifact is rejected before any native command', async (t) => {
  const f = await fixture(t);
  const input = await f.load();
  await f.put(f.review.source.normalizedProof.path, Buffer.from('changed'));
  await assert.rejects(importVerifiedProof(f.service, input, f.command));
  assert.equal(f.counts.retrieval, 0);
  assert.equal(f.counts.verify, 0);
});

await test('failed permit retains the verified proof and import provenance for ordinary permit recovery', async (t) => {
  const f = await fixture(t);
  f.runtime.permit = async () => {
    throw new Error('issuer unavailable');
  };
  const result = await importVerifiedProof(
    f.service,
    await f.load(),
    f.command,
  );
  assert.equal(result.status, 'attention_required');
  assert.equal(result.detailCode, 'issuer_unavailable');
  assert.ok(f.job.proof && f.job.proofImport);
  assert.equal(f.job.bundle, undefined);
});

await test('failed artifact or review pins do not create any import outputs', async (t) => {
  const f = await fixture(t);
  f.review.source.normalizedProof.sha256 = '00'.repeat(32);
  await assert.rejects(f.load());
  const contents = await readdir(join(f.root, 'work/runtime/hedera-testnet'));
  assert.ok(!contents.includes('verified-proof-import'));
});
