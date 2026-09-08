import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerVerifier } from '../src/lib/verification/worker-client.ts';
import { MAX_RECEIPT_BYTES } from '../src/lib/verification/contracts.ts';

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
const checked = {
  execution: 'dedicated-worker',
  requestIntegrity: 'consistent',
  evidence: 'not-verified',
  issuer: 'not-verified',
  proof: 'not-verified',
  chain: 'not-verified',
  receipt: { format: 'ultratokenizer.sample-receipt.v1', mode: 'simulation' },
};

test('worker correlation ignores unrelated replies and success cleans up the worker', async () => {
  const { client, workers } = harness();
  const pending = client.verify('{}');
  const worker = workers[0];
  assert.equal(worker.message.type, 'verify-sample-v1');
  worker.reply({ id: worker.message.id + 1, ok: true, result: checked });
  assert.equal(worker.terminated, 0);
  worker.reply({ id: worker.message.id, ok: true, result: checked });
  assert.equal((await pending).requestIntegrity, 'consistent');
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  client.dispose();
});

test('new requests cancel CPU work and stale results cannot complete the replacement', async () => {
  const { client, workers } = harness();
  const previous = client.verify('{}');
  const rejected = assert.rejects(previous, /cancelled/);
  const staleHandler = workers[0].onmessage;
  const oldId = workers[0].message.id;
  const current = client.verify('{"new":true}');
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
    client.verify('x'.repeat(MAX_RECEIPT_BYTES + 1)),
    /64 KB/,
  );
  await assert.rejects(
    client.verify('😀'.repeat(MAX_RECEIPT_BYTES / 4 + 1)),
    /64 KB/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    client.verify('{}', { signal: abort.signal }),
    /cancelled/,
  );
  assert.equal(workers.length, 0);
  client.dispose();
});

test('abort, timeout and disposal terminate workers and expose safe errors', async () => {
  const { client, workers } = harness(5);
  const abort = new AbortController();
  const cancelled = client.verify('{}', { signal: abort.signal });
  const rejected = assert.rejects(cancelled, /cancelled/);
  abort.abort();
  await rejected;
  assert.equal(workers[0].terminated, 1);
  await assert.rejects(client.verify('{}'), /timed out/);
  assert.equal(workers[1].terminated, 1);
  const disposed = client.verify('{}');
  const disposedCheck = assert.rejects(disposed, /cancelled/);
  client.dispose();
  await disposedCheck;
  assert.equal(workers[2].terminated, 1);
  await assert.rejects(client.verify('{}'), /could not start/);
});

test('startup and execution failures cannot fall back to UI-thread verification', async () => {
  const unavailable = createWorkerVerifier(() => {
    throw new Error('private internal details');
  });
  await assert.rejects(
    unavailable.verify('{}'),
    (error) =>
      error.code === 'unavailable' && !error.message.includes('private'),
  );
  const { client, workers } = harness();
  const failed = client.verify('{}');
  workers[0].onerror({
    preventDefault() {},
    message: 'private internal details',
  });
  await assert.rejects(
    failed,
    (error) => error.code === 'failed' && !error.message.includes('private'),
  );
  assert.equal(workers[0].terminated, 1);
  const invalid = client.verify('{}');
  workers[1].reply({
    id: workers[1].message.id,
    ok: false,
    code: 'injected error text',
  });
  await assert.rejects(invalid, (error) => error.code === 'failed');
  client.dispose();
});
