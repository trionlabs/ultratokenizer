import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './helpers.mjs';
const { createWorkerVerifier } = await loadModule(
  '../src/lib/verification/worker-client.ts',
);
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const { auditIssuanceReceipt } = await loadModule(
  '../../../packages/audit/src/index.ts',
);
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
const fixture = await createFixture();
const receiptText = JSON.stringify(fixture.receipt);
const options = { policyText: JSON.stringify(fixture.policy) };
const checked = {
  execution: 'dedicated-worker',
  mode: 'offline',
  receipt: fixture.receipt,
  report: await auditIssuanceReceipt(receiptText, fixture.policy),
};

test('HTTP IPv6 verification fails before worker creation with supported-host guidance', async () => {
  const { client, workers } = harness();
  await assert.rejects(
    client.verify(receiptText, { ...options, rpcUrl: 'http://[::1]:8545/' }),
    /Use HTTPS, or HTTP at localhost or 127\.0\.0\.1\./,
  );
  assert.equal(workers.length, 0);
  client.dispose();
});

test('worker correlation ignores unrelated replies and success cleans up the worker', async () => {
  const { client, workers } = harness();
  const pending = client.verify(receiptText, options);
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

test('an explicit online proof result retains required unverified history', async () => {
  const { client, workers } = harness();
  const result = structuredClone(checked);
  result.mode = 'rpc';
  result.report.checks.find(
    (check) => check.id === 'proof_cryptography',
  ).status = 'verified';
  result.report.missingEvidence = result.report.missingEvidence.filter(
    (id) => id !== 'proof_cryptography',
  );
  const pending = client.verify(receiptText, {
    ...options,
    rpcUrl: 'https://rpc.example.invalid/',
  });
  workers[0].reply({ id: workers[0].message.id, ok: true, result });
  const verified = await pending;
  assert.equal(verified.report.status, 'incomplete');
  assert(verified.report.missingEvidence.includes('historical_registry'));
  client.dispose();
});

for (const scenario of [
  'permit binding failure',
  'undecodable public values',
  'wrong transaction chain',
]) {
  test(`worker accepts actual audit report for ${scenario}`, async () => {
    const receipt = structuredClone(fixture.receipt);
    if (scenario === 'permit binding failure')
      receipt.permit.requestDigest = `0x${'ab'.repeat(32)}`;
    else if (scenario === 'undecodable public values')
      receipt.publicValues = `0x01${receipt.publicValues.slice(4)}`;
    else receipt.transaction.chainId = '1';
    const text = JSON.stringify(receipt);
    const result = {
      ...checked,
      receipt,
      report: await auditIssuanceReceipt(text, fixture.policy),
    };
    assert.equal(result.report.status, 'invalid');
    const { client, workers } = harness();
    const pending = client.verify(text, options);
    workers[0].reply({ id: workers[0].message.id, ok: true, result });
    assert.equal((await pending).report.status, 'invalid');
    client.dispose();
  });
}

test('new requests cancel CPU work and stale results cannot complete the replacement', async () => {
  const { client, workers } = harness();
  const previous = client.verify(receiptText, options);
  const rejected = assert.rejects(previous, /cancelled/);
  const staleHandler = workers[0].onmessage;
  const oldId = workers[0].message.id;
  const current = client.verify(receiptText, options);
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
    /Use HTTPS/,
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
  const complete = client.verify(receiptText, options);
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
  await assert.rejects(client.verify(receiptText, options), /timed out/);
  assert.equal(workers[1].terminated, 1);
  const disposed = client.verify(receiptText, options);
  const disposedCheck = assert.rejects(disposed, /cancelled/);
  client.dispose();
  await disposedCheck;
  assert.equal(workers[2].terminated, 1);
  await assert.rejects(client.verify(receiptText, options), /could not start/);
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
  const failed = client.verify(receiptText, options);
  workers[0].onerror({
    preventDefault() {},
    message: 'private internal details',
  });
  await assert.rejects(
    failed,
    (error) => error.code === 'failed' && !error.message.includes('private'),
  );
  assert.equal(workers[0].terminated, 1);
  const invalid = client.verify(receiptText, options);
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
    await globalThis.onmessage({
      data: {
        type: 'verify-issuance-v1',
        id: ++id,
        text: '{}',
        policyText: '{}',
        rpcUrl: 'http://[::1]:8545/',
      },
    });
    assert.deepEqual(replies.at(-1), { id, ok: false, code: 'invalid_rpc' });
  } finally {
    if (previousHandler === undefined) delete globalThis.onmessage;
    else globalThis.onmessage = previousHandler;
    if (previousPost === undefined) delete globalThis.postMessage;
    else globalThis.postMessage = previousPost;
  }
});

for (const [name, changed] of [
  [
    'omitted canonical checks',
    (result) => {
      result.report.checks = result.report.checks.filter(
        (check) => check.id !== 'historical_supply',
      );
      result.report.missingEvidence = result.report.missingEvidence.filter(
        (id) => id !== 'historical_supply',
      );
    },
  ],
  [
    'replaced canonical check',
    (result) => {
      result.report.checks.find((check) => check.id === 'request_digest').id =
        'invented_check';
    },
  ],
  ...[
    'historical_registry',
    'historical_reservation',
    'historical_supply',
    'historical_token_configuration',
    'replay_accounting',
    'execution_time',
    'current_revocation',
    'account_code',
    'transaction_inclusion',
    'proof_cryptography',
  ].map((id) => [
    `unsupported verified ${id}`,
    (result) => {
      result.report.checks.find((check) => check.id === id).status = 'verified';
      result.report.missingEvidence = result.report.missingEvidence.filter(
        (missing) => missing !== id,
      );
    },
  ]),
  [
    'unrelated report digest',
    (result) => {
      result.report.requestDigest = `0x${'ab'.repeat(32)}`;
    },
  ],
  [
    'null check',
    (result) => {
      result.report.checks = [null];
    },
  ],
  [
    'non-string check id',
    (result) => {
      result.report.checks[0].id = {};
    },
  ],
  [
    'non-string detail',
    (result) => {
      result.report.checks[0].detail = [];
    },
  ],
  [
    'unbounded detail',
    (result) => {
      result.report.checks[0].detail = 'x'.repeat(4097);
    },
  ],
  [
    'malformed receipt',
    (result) => {
      result.receipt = { format: result.receipt.format };
    },
  ],
  [
    'substituted receipt',
    (result) => {
      result.receipt.request.amount = '999';
    },
  ],
  [
    'malformed limitation',
    (result) => {
      result.report.limitations = [null];
    },
  ],
  [
    'malformed missing evidence',
    (result) => {
      result.report.missingEvidence = [{}];
    },
  ],
  [
    'status disagrees with checks',
    (result) => {
      result.report.status = 'invalid';
    },
  ],
]) {
  test(`worker rejects ${name} immediately, terminates, and permits a valid retry`, async () => {
    const { client, workers } = harness();
    const candidate = structuredClone(checked);
    changed(candidate);
    const pending = client.verify(receiptText, options);
    const rejected = assert.rejects(
      pending,
      (error) => error.code === 'failed',
    );
    assert.doesNotThrow(() =>
      workers[0].reply({
        id: workers[0].message.id,
        ok: true,
        result: candidate,
      }),
    );
    assert.equal(workers[0].terminated, 1);
    await rejected;
    const retry = client.verify(receiptText, options);
    workers[1].reply({ id: workers[1].message.id, ok: true, result: checked });
    assert.equal(
      (await retry).receipt.request.amount,
      fixture.receipt.request.amount,
    );
    assert.equal(workers[1].terminated, 1);
    client.dispose();
  });
}
