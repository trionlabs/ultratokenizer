import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './helpers.mjs';
import { createWorkerVerifier } from '../src/lib/verification/worker-client.ts';
import {
  MAX_RECEIPT_BYTES,
  MAX_POLICY_BYTES,
} from '../src/lib/verification/contracts.ts';

function harness(timeout = 1000) {
  const workers = [];
  const client = createWorkerVerifier(() => {
    const worker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      message: null,
      terminated: 0,
      postMessage(message) {
        this.message = message;
      },
      terminate() {
        this.terminated++;
      },
      reply(data) {
        this.onmessage?.({ data });
      },
    };
    workers.push(worker);
    return worker;
  }, timeout);
  return { client, workers };
}
const options = { policyText: '{}' };
const checked = {
  execution: 'dedicated-worker',
  mode: 'offline',
  receipt: { format: 'ultratokenizer.issuance-receipt.v1' },
  report: {
    format: 'ultratokenizer.audit-report.v1',
    status: 'incomplete',
    complete: false,
    checks: [],
    missingEvidence: [],
    limitations: [],
  },
};

test('worker correlation ignores unrelated replies and success cleans up the worker', async () => {
  const { client, workers } = harness();
  const pending = client.verify('{}', options);
  const worker = workers[0];
  assert.equal(worker.message.type, 'verify-issuance-v1');
  worker.reply({ id: worker.message.id + 1, ok: true, result: checked });
  assert.equal(worker.terminated, 0);
  worker.reply({ id: worker.message.id, ok: true, result: checked });
  assert.equal((await pending).report.status, 'incomplete');
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  client.dispose();
});

test('new requests cancel CPU work and stale results cannot complete the replacement', async () => {
  const { client, workers } = harness();
  const previous = client.verify('{}', options);
  const rejected = assert.rejects(previous, /cancelled/);
  const staleHandler = workers[0].onmessage;
  const oldId = workers[0].message.id;
  const current = client.verify('{"new":true}', options);
  assert.equal(workers[0].terminated, 1);
  staleHandler({ data: { id: oldId, ok: true, result: checked } });
  assert.equal(workers[1].terminated, 0);
  workers[1].reply({ id: workers[1].message.id, ok: true, result: checked });
  await rejected;
  await current;
  client.dispose();
});

test('UTF-8 byte limits and pre-aborted requests prevent worker creation', async () => {
  const { client, workers } = harness();
  await assert.rejects(
    client.verify('x'.repeat(MAX_RECEIPT_BYTES + 1), options),
    /256 KB/,
  );
  await assert.rejects(
    client.verify('😀'.repeat(MAX_RECEIPT_BYTES / 4 + 1), options),
    /256 KB/,
  );
  await assert.rejects(
    client.verify('{}', { policyText: 'x'.repeat(MAX_POLICY_BYTES + 1) }),
    /8 KB/,
  );
  await assert.rejects(
    client.verify('{}', {
      ...options,
      rpcUrl: 'https://user:secret@example.invalid/',
    }),
    /HTTPS RPC/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    client.verify('{}', { ...options, signal: abort.signal }),
    /cancelled/,
  );
  assert.equal(workers.length, 0);
  client.dispose();
});

test('non-string receipt and policy inputs report the invalid field without coercion or a worker', async () => {
  const { client, workers } = harness();
  let coercions = 0;
  for (const value of [
    undefined,
    null,
    1,
    false,
    [],
    {},
    new String('{}'),
    {
      toString() {
        coercions++;
        return '{}';
      },
    },
  ]) {
    await assert.rejects(
      client.verify(value, options),
      (error) => error.code === 'invalid_receipt',
    );
    await assert.rejects(
      client.verify('{}', { policyText: value }),
      (error) => error.code === 'invalid_policy',
    );
  }
  assert.equal(coercions, 0);
  assert.equal(workers.length, 0);
  client.dispose();
});

test('worker replies cannot claim complete assurance or silently switch verification mode', async () => {
  const { client, workers } = harness();
  const complete = client.verify('{}', options);
  workers[0].reply({
    id: workers[0].message.id,
    ok: true,
    result: { ...checked, report: { ...checked.report, complete: true } },
  });
  await assert.rejects(complete, (error) => error.code === 'failed');
  const online = client.verify('{}', {
    ...options,
    rpcUrl: 'https://rpc.example.invalid/',
  });
  workers[1].reply({ id: workers[1].message.id, ok: true, result: checked });
  await assert.rejects(online, (error) => error.code === 'failed');
});

test('abort, timeout and disposal terminate workers and expose safe errors', async () => {
  const { client, workers } = harness(5);
  const abort = new AbortController();
  const cancelled = client.verify('{}', { ...options, signal: abort.signal });
  const rejected = assert.rejects(cancelled, /cancelled/);
  abort.abort();
  await rejected;
  assert.equal(workers[0].terminated, 1);
  await assert.rejects(client.verify('{}', options), /timed out/);
  assert.equal(workers[1].terminated, 1);
  const disposed = client.verify('{}', options);
  const disposedCheck = assert.rejects(disposed, /cancelled/);
  client.dispose();
  await disposedCheck;
  assert.equal(workers[2].terminated, 1);
  await assert.rejects(client.verify('{}', options), /could not start/);
});

test('startup and execution failures cannot fall back to UI-thread verification', async () => {
  const unavailable = createWorkerVerifier(() => {
    throw new Error('private internal details');
  });
  await assert.rejects(
    unavailable.verify('{}', options),
    (error) =>
      error.code === 'unavailable' && !error.message.includes('private'),
  );
  const { client, workers } = harness();
  const failed = client.verify('{}', options);
  workers[0].onerror({
    preventDefault() {},
    message: 'private internal details',
  });
  await assert.rejects(
    failed,
    (error) => error.code === 'failed' && !error.message.includes('private'),
  );
  assert.equal(workers[0].terminated, 1);
  const invalid = client.verify('{}', options);
  workers[1].reply({
    id: workers[1].message.id,
    ok: false,
    code: 'injected error text',
  });
  await assert.rejects(invalid, (error) => error.code === 'failed');
  client.dispose();
});

test('the worker itself preserves field-specific input errors when its public client is bypassed', async () => {
  const previousHandler = globalThis.onmessage;
  const previousPost = globalThis.postMessage;
  const replies = [];
  try {
    await loadModule('../src/lib/verification/receipt.worker.ts');
    globalThis.postMessage = (reply) => replies.push(reply);
    let id = 0;
    for (const value of [undefined, null, false, 1, [], {}]) {
      for (const [field, expected] of [
        ['policyText', 'invalid_policy'],
        ['text', 'invalid_receipt'],
      ]) {
        await globalThis.onmessage({
          data: {
            type: 'verify-issuance-v1',
            id: ++id,
            text: '{}',
            policyText: '{}',
            [field]: value,
          },
        });
        assert.deepEqual(replies.at(-1), { id, ok: false, code: expected });
      }
    }
    assert.equal(replies.length, 12);
  } finally {
    if (previousHandler === undefined) delete globalThis.onmessage;
    else globalThis.onmessage = previousHandler;
    if (previousPost === undefined) delete globalThis.postMessage;
    else globalThis.postMessage = previousPost;
  }
});
