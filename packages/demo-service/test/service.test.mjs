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

await test('wrong wallet, unknown fields and expired preparations fail closed', async (t) => {
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
  await f.prepare();
  f.advance(3601);
  await assert.rejects(f.prepare(), { code: 'job_conflict' });
  assert.equal(f.counts.reserve, 0);
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
  await assert.rejects(f.prepare(), { code: 'job_conflict' });
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
    assert.equal(results[1].detailCode, 'proof_budget_unavailable');
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
    assert.equal(ready.readiness.blocker, 'proof_budget_unavailable');
    assert.equal(
      (await restarted.status(first.jobId)).status,
      'attention_required',
    );
    assert.equal(f.counts.reserve, 0);
  } finally {
    await reopened.close();
  }
});
