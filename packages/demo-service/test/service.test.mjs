import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getIssuanceRequestTypedData,
  parseIssuanceRequest,
} from '../../../dist/domain/src/index.js';
import { DemoService, MAX_PDF_BYTES } from '../src/service.mjs';
import { JobStore } from '../src/store.mjs';
import { RuntimeAdapter } from '../src/runtime.mjs';
import { ServiceError, sha256 } from '../src/io.mjs';

// Public deterministic test keys only; never loaded from application configuration.
const holder = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const sample = JSON.parse(
  await readFile(
    new URL('../../domain/fixtures/request.synthetic.json', import.meta.url),
    'utf8',
  ),
);
const pdf = Buffer.from('%PDF-1.7\nunit test input');
const id = sha256(pdf);
const hash = `0x${'44'.repeat(32)}`;
async function fixture(t, { enabled = true, failure } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ut-demo-service-'));
  const store = await new JobStore(directory).open();
  const counts = { reserve: 0, prove: 0, permit: 0, verify: 0 };
  let now = 1800000000;
  const source = {
    recipient: holder.address,
    sourceId: hash,
    sourceSignerFingerprint: hash,
  };
  const runtime = {
    configuration: async () => ({
      issuer: {},
      terms: { policy: { hash }, rights: { hash }, checked: true },
      readiness: enabled
        ? { canStart: true }
        : { canStart: false, blocker: 'proof_provider_unresolved' },
    }),
    source: async (value) => {
      assert.equal(value, id);
      return source;
    },
    inspect: async (value, bytes) => {
      assert.equal(value, id);
      assert.deepEqual(bytes, pdf);
      return source;
    },
    draft: async (_source, fields) => ({
      ...sample,
      ...Object.fromEntries(
        ['recipient', 'requestId', 'reservationId', 'nonce'].map((key) => [
          key,
          fields[key],
        ]),
      ),
      amount: '1000',
      validUntil: String(fields.now + 3600),
    }),
    verifyDraft: async () => {
      counts.verify += 1;
    },
    assertOperationsEnabled: async () => {
      if (!enabled) throw new ServiceError('operations_disabled');
    },
    assertCredentialsReady: async () => {},
    dispatchAdmission: async () => ({ retainedJobIds: [] }),
    selectProofBudget: async () => ({
      path: 'reviewed-budget.jsonl',
      id: 'aa'.repeat(32),
      requester: holder.address,
    }),
    checkPreparedProofRecovery: async () => {},
    reserve: async () => {
      counts.reserve += 1;
      if (failure === 'reserve')
        throw new ServiceError('reservation_uncertain');
      return { transactionHash: hash };
    },
    prove: async (job, _folder, update) => {
      counts.prove += 1;
      await update('proving');
      if (failure === 'prove')
        throw new ServiceError('proof_request_uncertain');
      return { testOnly: true, request: job.request };
    },
    permit: async (job) => {
      counts.permit += 1;
      return {
        testOnly: true,
        request: job.request,
        permit: { validUntil: String(now + 600) },
      };
    },
  };
  const service = new DemoService(runtime, store, () => now);
  t.after(async () => {
    await Promise.all(service.running.values());
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const prepare = () =>
    service.prepare({ documentId: id, recipient: holder.address });
  const sign = async (prepared, account = holder) => ({
    holderSignature: await account.signTypedData(
      getIssuanceRequestTypedData(prepared.request),
    ),
  });
  const settle = async () => {
    await Promise.all(service.running.values());
  };
  return {
    store,
    service,
    runtime,
    counts,
    prepare,
    sign,
    settle,
    directory,
    advance: (seconds) => {
      now += seconds;
    },
  };
}

await test('concurrent prepare deduplicates one immutable canonical job', async (t) => {
  const f = await fixture(t);
  const jobs = await Promise.all(Array.from({ length: 8 }, f.prepare));
  assert.equal(new Set(jobs.map((job) => job.jobId)).size, 1);
  assert.equal(f.counts.verify, 1);
  assert.equal(jobs[0].request.amount, '1000');
  assert.equal(jobs[0].prepared.request, jobs[0].request);
  assert.equal(
    (await stat(join(f.directory, jobs[0].jobId, 'job.json'))).mode & 0o777,
    0o600,
  );
});

await test('reupload and prepare resume signed active jobs without changing or dispatching them', async (t) => {
  for (const status of ['proving', 'ready_to_mint', 'attention_required']) {
    await t.test(status, async (subtest) => {
      const f = await fixture(subtest, { enabled: false });
      const initial = await f.prepare();
      const approval = await f.sign(initial);
      const job = f.store.get(initial.jobId);
      await f.store.update(job, {
        status,
        holderSignature: approval.holderSignature,
        reservation: { transactionHash: hash },
        ...(status === 'ready_to_mint'
          ? { proof: {}, bundle: { permit: { validUntil: '1800000600' } } }
          : {}),
      });
      const before = JSON.stringify(job);
      const inspected = await f.service.document(pdf);
      assert.equal(inspected.existingJobStatus, status);
      assert.equal(inspected.readiness.canStart, false);
      const resumed = await f.prepare();
      assert.equal(resumed.status, status);
      assert.deepEqual(resumed.request, initial.request);
      assert.equal(resumed.requestDigest, initial.requestDigest);
      await assert.rejects(
        f.service.start(resumed.jobId, await f.sign(resumed, other)),
        { code: 'invalid_signature' },
      );
      assert.equal(
        (await f.service.start(resumed.jobId, approval)).status,
        status,
      );
      assert.equal(JSON.stringify(job), before);
      assert.deepEqual(f.counts, {
        reserve: 0,
        prove: 0,
        permit: 0,
        verify: 1,
      });
    });
  }
});

await test('wrong wallet and unknown preparation fields fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.prepare({ documentId: id, recipient: other.address }),
    { code: 'wrong_account' },
  );
  await assert.rejects(
    f.service.prepare({
      documentId: id,
      recipient: holder.address,
      amount: '999',
    }),
    { code: 'invalid_request' },
  );
  assert.equal(f.counts.reserve, 0);
});

await test('expired unsigned preparation rotates once and preserves the archived request', async (t) => {
  const f = await fixture(t);
  const old = await f.prepare();
  const oldSignature = await f.sign(old);
  assert.equal((await f.prepare()).jobId, old.jobId);
  f.advance(3600);
  const replacements = await Promise.all(Array.from({ length: 8 }, f.prepare));
  const fresh = replacements[0];
  assert.equal(new Set(replacements.map((job) => job.jobId)).size, 1);
  for (const field of ['requestId', 'reservationId', 'nonce'])
    assert.notEqual(fresh.request[field], old.request[field]);
  assert.notEqual(fresh.jobId, old.jobId);
  assert.equal(f.store.jobs.size, 1);
  assert.equal(f.counts.verify, 2);
  const archived = JSON.parse(
    await readFile(
      join(f.directory, 'expired-unsigned', old.jobId, 'job.json'),
      'utf8',
    ),
  );
  assert.equal(archived.requestDigest, old.requestDigest);
  assert.equal(archived.holderSignature, undefined);
  await assert.rejects(f.service.start(old.jobId, oldSignature), {
    code: 'job_not_found',
  });
  await assert.rejects(f.service.start(fresh.jobId, oldSignature), {
    code: 'invalid_signature',
  });
  assert.equal(f.counts.reserve, 0);
  assert.equal(f.counts.prove, 0);
  await f.store.close();
  const reopened = await new JobStore(f.directory).open();
  try {
    assert.equal(reopened.jobs.size, 1);
    assert.equal(reopened.forDocument(id).jobId, fresh.jobId);
    assert.throws(() => reopened.get(old.jobId), { code: 'job_not_found' });
  } finally {
    await reopened.close();
  }
});

await test('expired jobs with state changes or possible side effects cannot be replaced', async (t) => {
  for (const patch of [
    { holderSignature: '0x00' },
    { holderSignature: null },
    { reservation: { transactionHash: hash } },
    { proof: {} },
    { bundle: {} },
    { status: 'blocked' },
    { status: 'reserving' },
    { status: 'attention_required' },
    { detailCode: 'reservation_uncertain' },
    { unrecognizedDispatchEvidence: true },
  ]) {
    await t.test(JSON.stringify(patch), async (subtest) => {
      const f = await fixture(subtest);
      const prepared = await f.prepare();
      const job = f.store.get(prepared.jobId);
      await f.store.update(job, patch);
      f.advance(3601);
      await assert.rejects(f.prepare(), { code: 'job_conflict' });
      assert.equal(f.store.forDocument(id).jobId, prepared.jobId);
      assert.equal(f.counts.reserve, 0);
      assert.equal(f.counts.prove, 0);
    });
  }
});

await test('expired unsigned jobs retain unexpected disk artifacts or changed snapshots', async (t) => {
  for (const changedSnapshot of [false, true]) {
    await t.test(String(changedSnapshot), async (subtest) => {
      const f = await fixture(subtest);
      const prepared = await f.prepare();
      const path = join(
        f.directory,
        prepared.jobId,
        changedSnapshot ? 'job.json' : 'network-dispatch.json',
      );
      const value = changedSnapshot
        ? { ...f.store.get(prepared.jobId), holderSignature: '0x00' }
        : { dispatched: true };
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      f.advance(3601);
      await assert.rejects(f.prepare(), { code: 'job_conflict' });
      assert.equal(f.store.forDocument(id).jobId, prepared.jobId);
      assert.equal(f.counts.reserve, 0);
      assert.equal(f.counts.prove, 0);
    });
  }
});

await test('PDF type, content and byte ceiling are checked before inspection', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.document(Buffer.alloc(MAX_PDF_BYTES + 1)), {
    code: 'document_too_large',
  });
  await assert.rejects(f.service.document(Buffer.from('Subject: email')), {
    code: 'unsupported_document',
  });
  const result = await f.service.document(pdf);
  assert.equal(result.documentId, id);
});

await test('actual holder signature is required before every side effect', async (t) => {
  const f = await fixture(t);
  const job = await f.prepare();
  await assert.rejects(f.service.start(job.jobId, await f.sign(job, other)), {
    code: 'invalid_signature',
  });
  const changed = {
    ...job,
    request: parseIssuanceRequest({ ...job.request, amount: '999' }),
  };
  await assert.rejects(f.service.start(job.jobId, await f.sign(changed)), {
    code: 'invalid_signature',
  });
  await assert.rejects(
    f.service.start(job.jobId, { holderSignature: '0x00' }),
    { code: 'invalid_signature' },
  );
  assert.deepEqual(f.counts, { reserve: 0, prove: 0, permit: 0, verify: 1 });
});

await test('provider blocker retains an authenticated job without allocation or payment', async (t) => {
  const f = await fixture(t, { enabled: false });
  const job = await f.prepare();
  const status = await f.service.start(job.jobId, await f.sign(job));
  assert.equal(status.status, 'blocked');
  assert.equal(status.detailCode, 'proof_provider_unresolved');
  assert.equal(status.bundleReady, false);
  assert.equal(f.counts.reserve + f.counts.prove + f.counts.permit, 0);
  const restored = await f.prepare();
  assert.equal(restored.jobId, job.jobId);
  assert.equal(restored.status, 'awaiting_signature');
});

await test('repeated start never duplicates reservation or proof dispatch', async (t) => {
  const f = await fixture(t);
  const job = await f.prepare();
  const signature = await f.sign(job);
  await Promise.all(
    Array.from({ length: 8 }, () => f.service.start(job.jobId, signature)),
  );
  await f.settle();
  const status = await f.service.status(job.jobId);
  assert.equal(status.status, 'ready_to_mint');
  assert.equal(status.bundleReady, true);
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
  assert.equal(f.counts.permit, 1);
  assert.equal(Object.hasOwn(status, 'holderSignature'), false);
  assert.equal((await f.service.bundle(job.jobId)).testOnly, true);
  const resumed = await f.prepare();
  assert.equal(resumed.jobId, job.jobId);
  assert.equal(resumed.status, 'ready_to_mint');
  await f.service.start(resumed.jobId, signature);
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
  assert.equal(f.counts.permit, 1);
});

for (const failure of ['reserve', 'prove'])
  await test(`${failure} uncertainty never starts a replacement`, async (t) => {
    const f = await fixture(t, { failure });
    const job = await f.prepare();
    const signature = await f.sign(job);
    await f.service.start(job.jobId, signature);
    await f.settle();
    await f.service.start(job.jobId, signature);
    await f.settle();
    const status = await f.service.status(job.jobId);
    assert.equal(status.status, 'attention_required');
    assert.equal(status.canRetry, false);
    assert.equal(f.counts.reserve, 1);
    assert.equal(f.counts.prove, failure === 'prove' ? 1 : 0);
    await assert.rejects(f.service.bundle(job.jobId), {
      code: 'proof_unavailable',
    });
  });

await test('expired permit is explicitly refreshed using the same proof, never reproved', async (t) => {
  const f = await fixture(t);
  const job = await f.prepare();
  const signature = await f.sign(job);
  await f.service.start(job.jobId, signature);
  await f.settle();
  f.advance(600);
  await assert.rejects(f.service.bundle(job.jobId), { code: 'permit_expired' });
  await f.service.refreshPermit(job.jobId, signature);
  assert.equal((await f.service.status(job.jobId)).bundleReady, true);
  assert.equal(f.counts.prove, 1);
  assert.equal(f.counts.permit, 2);
});

await test('concurrent journal patches keep one hash chain and preserve both fields', async (t) => {
  const f = await fixture(t);
  const job = f.store.get((await f.prepare()).jobId);
  await Promise.all([
    f.store.update(job, { left: 1 }),
    f.store.update(job, { right: 2 }),
  ]);
  const events = (
    await readFile(join(f.directory, job.jobId, 'events.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(events[1].previousHash, events[0].hash);
  assert.equal(job.left, 1);
  assert.equal(job.right, 2);
});

await test('reopening an interrupted job stops for reconciliation without dispatch', async (t) => {
  const f = await fixture(t);
  const job = f.store.get((await f.prepare()).jobId);
  await f.store.update(job, { status: 'proving' });
  await f.store.close();
  const reopened = await new JobStore(f.directory).open();
  assert.equal(reopened.get(job.jobId).status, 'attention_required');
  assert.equal(reopened.get(job.jobId).detailCode, 'proof_request_uncertain');
  assert.equal(f.counts.reserve + f.counts.prove, 0);
  await reopened.close();
});

await test('process ownership and corrupt snapshots fail closed', async (t) => {
  const f = await fixture(t);
  const job = await f.prepare();
  await assert.rejects(new JobStore(f.directory).open(), { code: 'EEXIST' });
  await f.store.close();
  const path = join(f.directory, job.jobId, 'job.json');
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  snapshot.request.amount = '999';
  await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
  const reopened = new JobStore(f.directory);
  await assert.rejects(reopened.open(), { code: 'service_unavailable' });
  await reopened.close();
});

await test('one issuer nonce stream serializes reservations across distinct jobs', async () => {
  const runtime = new RuntimeAdapter('', {});
  const order = [];
  let active = 0;
  runtime.reserveOnce = async (job) => {
    active += 1;
    assert.equal(active, 1);
    order.push(job);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return job;
  };
  assert.deepEqual(
    await Promise.all([runtime.reserve('first'), runtime.reserve('second')]),
    ['first', 'second'],
  );
  assert.deepEqual(order, ['first', 'second']);
});

await test('concurrent distinct documents acquire only one dispatch slot before chain reservation', async (t) => {
  const f = await fixture(t);
  const secondId = 'bb'.repeat(32);
  const source = await f.runtime.source(id);
  const draft = f.runtime.draft;
  f.runtime.source = async (documentId) => ({ ...source, documentId });
  f.runtime.draft = async (input, fields) => ({
    ...(await draft(input, fields)),
    claimUsageId: `0x${input.documentId}`,
  });
  const first = await f.prepare();
  const second = await f.service.prepare({
    documentId: secondId,
    recipient: holder.address,
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const reserve = f.runtime.reserve;
  f.runtime.reserve = async (...args) => {
    const result = await reserve(...args);
    await held;
    return result;
  };
  const signatures = await Promise.all([f.sign(first), f.sign(second)]);
  try {
    const results = await Promise.all([
      f.service.start(first.jobId, signatures[0]),
      f.service.start(second.jobId, signatures[1]),
    ]);
    assert.equal(results[1].status, 'blocked');
    assert.equal(results[1].detailCode, 'verification_in_progress');
    assert.equal(f.counts.reserve, 1);
    assert.equal(f.store.get(second.jobId).holderSignature, undefined);
  } finally {
    release();
  }
  await f.settle();
  assert.equal((await f.service.status(first.jobId)).status, 'ready_to_mint');
});

await test('a durable interrupted dispatch blocks a new document after process restart', async (t) => {
  const f = await fixture(t);
  const first = await f.prepare();
  await f.store.update(f.store.get(first.jobId), {
    status: 'staging',
    ...(await f.sign(first)),
  });
  await f.store.close();
  const reopened = await new JobStore(f.directory).open();
  try {
    const restarted = new DemoService(f.runtime, reopened);
    const ready = await restarted.config();
    assert.equal(ready.readiness.canStart, false);
    assert.equal(ready.readiness.blocker, 'proof_request_uncertain');
    assert.equal(
      (await restarted.status(first.jobId)).status,
      'attention_required',
    );
    assert.equal(f.counts.reserve, 0);
  } finally {
    await reopened.close();
  }
});

await test('credential preflight failure cannot reserve backing or retain a dispatch signature', async (t) => {
  const f = await fixture(t);
  const job = await f.prepare();
  f.runtime.assertCredentialsReady = async () => {
    throw new ServiceError('operations_disabled');
  };
  await assert.rejects(f.service.start(job.jobId, await f.sign(job)), {
    code: 'operations_disabled',
  });
  assert.equal(f.store.get(job.jobId).status, 'awaiting_signature');
  assert.equal(f.store.get(job.jobId).holderSignature, undefined);
  assert.equal(f.counts.reserve + f.counts.prove, 0);
});

await test('budget selection fails before persisting a signature or reserving backing', async (t) => {
  const f = await fixture(t);
  const job = await f.prepare();
  f.runtime.selectProofBudget = async () => {
    throw new ServiceError('operations_disabled');
  };
  await assert.rejects(f.service.start(job.jobId, await f.sign(job)), {
    code: 'operations_disabled',
  });
  assert.equal(f.store.get(job.jobId).holderSignature, undefined);
  assert.equal(f.store.get(job.jobId).proofBudget, undefined);
  assert.equal(f.counts.reserve + f.counts.prove, 0);
  await assert.rejects(
    f.service.start(job.jobId, {
      ...(await f.sign(job)),
      proofBudget: { path: 'attacker.jsonl' },
    }),
    { code: 'invalid_request' },
  );
});

await test('proof budget is durable before the first reservation and survives process restart', async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const expected = await f.runtime.selectProofBudget(
    f.store.get(prepared.jobId),
  );
  const reserve = f.runtime.reserve;
  f.runtime.reserve = async (job) => {
    const disk = JSON.parse(
      await readFile(join(f.directory, job.jobId, 'job.json'), 'utf8'),
    );
    assert.deepEqual(job.proofBudget, expected);
    assert.deepEqual(disk.proofBudget, expected);
    assert.equal(disk.holderSignature, job.holderSignature);
    return reserve(job);
  };
  await f.service.start(prepared.jobId, await f.sign(prepared));
  await f.settle();
  await f.store.close();
  const reopened = await new JobStore(f.directory).open();
  try {
    assert.deepEqual(reopened.get(prepared.jobId).proofBudget, expected);
  } finally {
    await reopened.close();
  }
});

await test('one reviewed observer permits only the selected document and never hides another unfinished job', async (t) => {
  for (const other of [
    'none',
    'unfinished',
    'reservation_uncertain',
    'dispatch',
  ]) {
    await t.test(other, async (subtest) => {
      const f = await fixture(subtest);
      const nextId = 'bb'.repeat(32),
        thirdId = 'cc'.repeat(32);
      const source = await f.runtime.source(id);
      f.runtime.source = async (documentId) => ({ ...source, documentId });
      const old = await f.prepare();
      await f.store.update(f.store.get(old.jobId), {
        status: 'proving',
        ...(await f.sign(old)),
        reservation: { transactionHash: hash },
      });
      const unchanged = JSON.stringify(f.store.get(old.jobId));
      f.runtime.dispatchAdmission = async () => ({
        nextDocumentId: nextId,
        retainedJobIds: [old.jobId],
      });
      f.service.running.set(old.jobId, Promise.resolve());
      f.service.runningModes.set(
        old.jobId,
        other === 'dispatch' ? 'dispatch' : 'observe',
      );
      const next = await f.service.prepare({
        documentId: nextId,
        recipient: holder.address,
      });
      assert.equal((await f.service.config(thirdId)).readiness.canStart, false);
      if (other === 'unfinished' || other === 'reservation_uncertain') {
        const third = await f.service.prepare({
          documentId: thirdId,
          recipient: holder.address,
        });
        await f.store.update(f.store.get(third.jobId), {
          status: 'attention_required',
          ...(await f.sign(third)),
          detailCode:
            other === 'reservation_uncertain'
              ? other
              : 'proof_request_uncertain',
        });
      }
      const result = await f.service.start(next.jobId, await f.sign(next));
      if (other === 'none') {
        assert.notEqual(result.status, 'blocked');
        await f.settle();
        assert.equal(f.counts.reserve, 1);
        assert.equal(f.counts.prove, 1);
      } else {
        assert.equal(result.status, 'blocked');
        assert.equal(f.store.get(next.jobId).holderSignature, undefined);
        assert.equal(f.store.get(next.jobId).proofBudget, undefined);
        assert.equal(f.counts.reserve + f.counts.prove, 0);
      }
      assert.equal(JSON.stringify(f.store.get(old.jobId)), unchanged);
    });
  }
});

await test('explicit prepared-proof continuation reuses the reservation and starts only once', async (t) => {
  const f = await fixture(t, { failure: 'prove' });
  const prepared = await f.prepare();
  await f.service.start(prepared.jobId, await f.sign(prepared));
  await f.settle();
  const job = f.store.get(prepared.jobId);
  // Historical failed credential loading occurred after native preparation.
  await f.store.update(job, { detailCode: 'invalid_request' });
  let dispatches = 0;
  f.runtime.prove = async (same, _folder, update, options) => {
    assert.equal(same.requestDigest, prepared.requestDigest);
    assert.equal(options.prepared, true);
    dispatches++;
    await update('proving');
    return { testOnly: true, request: same.request };
  };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => f.service.resumePreparedProof(job.jobId)),
  );
  await f.settle();
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(f.counts.reserve, 1);
  assert.equal(dispatches, 1);
  assert.equal(job.status, 'ready_to_mint');
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.directory, job.jobId, 'prepared-proof-recovery.json'),
        'utf8',
      ),
    ).requestDigest,
    prepared.requestDigest,
  );
});

await test('an uncertain stage or paid request cannot enter prepared-proof continuation', async (t) => {
  const f = await fixture(t, { failure: 'prove' });
  const job = await f.prepare();
  await f.service.start(job.jobId, await f.sign(job));
  await f.settle();
  await assert.rejects(f.service.resumePreparedProof(job.jobId), {
    code: 'proof_request_uncertain',
  });
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
});

await test('failed preparation artifact admission cannot mutate or launch the retained job', async (t) => {
  const f = await fixture(t, { failure: 'prove' });
  const prepared = await f.prepare();
  await f.service.start(prepared.jobId, await f.sign(prepared));
  await f.settle();
  const job = f.store.get(prepared.jobId);
  await f.store.update(job, { detailCode: 'invalid_request' });
  f.runtime.checkPreparedProofRecovery = async () => {
    throw new ServiceError('proof_request_uncertain');
  };
  await assert.rejects(f.service.resumePreparedProof(job.jobId), {
    code: 'proof_request_uncertain',
  });
  assert.equal(job.status, 'attention_required');
  assert.equal(job.detailCode, 'invalid_request');
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
  await assert.rejects(
    stat(join(f.directory, job.jobId, 'prepared-proof-recovery.json')),
    { code: 'ENOENT' },
  );
});

await test('submitted-proof continuation observes the same job without credentials, budget admission or dispatch', async (t) => {
  const f = await fixture(t, { failure: 'prove' });
  const prepared = await f.prepare();
  await f.service.start(prepared.jobId, await f.sign(prepared));
  await f.settle();
  let observations = 0;
  f.runtime.checkSubmittedProofRecovery = async () => ({
    journalHash: 'retained',
  });
  f.runtime.assertOperationsEnabled = async () => {
    throw new Error('New spend is forbidden');
  };
  f.runtime.assertCredentialsReady = async () => {
    throw new Error('Credential loading is forbidden');
  };
  f.runtime.observeSubmittedProof = async (job, _folder, update) => {
    observations++;
    await update('proving');
    throw new ServiceError('proof_observation_unavailable');
  };
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      f.service.resumeSubmittedProof(prepared.jobId),
    ),
  );
  await f.settle();
  assert.equal(
    attempts.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
  assert.equal(observations, 1);
  // A later explicit read-only continuation may retry observation, never spending.
  await f.service.resumeSubmittedProof(prepared.jobId);
  await f.settle();
  assert.equal(observations, 2);
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
});

await test('terminal proof rejection retains the reservation and forbids restart or paid retry', async (t) => {
  const f = await fixture(t, { failure: 'prove' });
  const prepared = await f.prepare();
  const approval = await f.sign(prepared);
  await f.service.start(prepared.jobId, approval);
  await f.settle();
  const reservation = f.store.get(prepared.jobId).reservation;
  let observations = 0;
  f.runtime.checkSubmittedProofRecovery = async () => ({
    journalHash: 'retained',
  });
  f.runtime.observeSubmittedProof = async () => {
    observations++;
    throw new ServiceError('proof_request_rejected');
  };
  await f.service.resumeSubmittedProof(prepared.jobId);
  await f.settle();
  const result = await f.service.status(prepared.jobId);
  assert.equal(result.status, 'attention_required');
  assert.equal(result.detailCode, 'proof_request_rejected');
  assert.equal(result.canRetry, false);
  assert.equal(result.bundleReady, false);
  assert.equal(
    (await f.service.config()).readiness.blocker,
    'proof_request_rejected',
  );
  assert.deepEqual(f.store.get(prepared.jobId).reservation, reservation);
  const repeats = await Promise.all(
    Array.from({ length: 8 }, () => f.service.start(prepared.jobId, approval)),
  );
  assert.ok(
    repeats.every((value) => value.detailCode === 'proof_request_rejected'),
  );
  await assert.rejects(f.service.resumeSubmittedProof(prepared.jobId), {
    code: 'proof_request_uncertain',
  });
  await assert.rejects(f.service.resumePreparedProof(prepared.jobId), {
    code: 'proof_request_uncertain',
  });
  assert.equal(observations, 1);
  assert.equal(f.counts.reserve, 1);
  assert.equal(f.counts.prove, 1);
  assert.equal(f.counts.permit, 0);
});

await test('actual budget denial is preserved when no signed work occupies the service', async (t) => {
  const f = await fixture(t);
  const original = f.runtime.configuration;
  f.runtime.configuration = async () => ({
    ...(await original()),
    readiness: { canStart: false, blocker: 'proof_budget_unavailable' },
  });
  assert.deepEqual((await f.service.config()).readiness, {
    canStart: false,
    blocker: 'proof_budget_unavailable',
  });
  assert.equal(f.counts.reserve, 0);
  assert.equal(f.counts.prove, 0);
});
