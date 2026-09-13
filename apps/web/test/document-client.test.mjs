import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { loadModule } from './helpers.mjs';

const { createDocumentClient, MAX_PDF_BYTES, documentBlocker } =
  await loadModule('../src/lib/application/document-client.ts');
const hash = `0x${'11'.repeat(32)}`;
const address = `0x${'11'.repeat(20)}`;
const config = () => ({
  issuer: {
    label: 'Demo issuer',
    agentId: '116',
    identityRegistry: address,
    issuerId: hash,
    wallet: address,
    selected: true,
  },
  terms: {
    policy: { text: 'Demo policy', hash: keccak256(toHex('Demo policy')) },
    rights: { text: 'Demo rights', hash: keccak256(toHex('Demo rights')) },
    checked: true,
    blockNumber: '123',
  },
  readiness: { canStart: false, blocker: 'proof_provider_unresolved' },
});
const uploaded = () => ({
  ...config(),
  documentId: 'doc_123',
  document: {
    name: 'Signed gold right.pdf',
    amountMilligrams: '12500',
    recipient: address,
    issuerId: hash,
    sourceId: hash,
    sourceSignerFingerprint: hash,
    profile: 'ultratokenizer-synthetic-gold-v2',
    sha256: hash,
  },
});
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const signal = () => new AbortController().signal;

test('PDF upload validates format and size before any network call', async () => {
  let calls = 0;
  const client = createDocumentClient(async () => {
    calls++;
    return json(uploaded());
  });
  for (const file of [
    new File(['{}'], 'proof.json'),
    new File(['hello'], 'fake.pdf'),
    new File(['%PDF-1.7\n', new Uint8Array(MAX_PDF_BYTES)], 'large.pdf'),
  ]) {
    await assert.rejects(client.upload(file, signal()));
  }
  assert.equal(calls, 0);
  const file = new File(['%PDF-1.7\nexample\n%%EOF'], 'gold.pdf');
  await client.upload(file, signal());
  assert.equal(calls, 1);
});

test('document requests use fixed same-origin paths and omit credentials, redirects and caching', async () => {
  const file = new File(['%PDF-1.7\nexample\n%%EOF'], 'gold.pdf');
  const client = createDocumentClient(async (url, options) => {
    assert.equal(url, '/api/documents');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['content-type'], 'application/pdf');
    assert.ok(options.signal instanceof AbortSignal);
    return json(uploaded());
  });
  const result = await client.upload(file, signal());
  assert.equal(result.document.amountMilligrams, '12500');
  assert.ok(Object.isFrozen(result.document));
});

test('configuration rejects altered terms and unchecked or incomplete issuer identities', async () => {
  for (const alter of [
    (v) => {
      v.terms.policy.text += ' altered';
    },
    (v) => {
      v.terms.checked = false;
      v.readiness = { canStart: true };
    },
    (v) => {
      delete v.issuer.wallet;
    },
    (v) => {
      v.issuer.agentId = '116.5';
    },
    (v) => {
      v.readiness.canStart = 'true';
    },
  ]) {
    const value = config();
    alter(value);
    await assert.rejects(
      createDocumentClient(async () => json(value)).configuration(signal()),
    );
  }
});

test('an unchecked Gate observation keeps document inspection available and verification blocked', async () => {
  const value = config();
  value.terms.checked = false;
  delete value.terms.blockNumber;
  value.readiness = { canStart: false, blocker: 'deployment_unavailable' };
  const result = await createDocumentClient(async () =>
    json(value),
  ).configuration(signal());
  assert.equal(result.terms.checked, false);
  assert.equal(result.readiness.canStart, false);
});

test('an unavailable proof budget blocks new verification while document upload remains available', async () => {
  const value = config();
  value.readiness = { canStart: false, blocker: 'proof_budget_unavailable' };
  const client = createDocumentClient(async (url) =>
    json(
      url === '/api/config'
        ? value
        : { ...uploaded(), readiness: value.readiness },
    ),
  );
  const configuration = await client.configuration(signal());
  assert.equal(configuration.readiness.canStart, false);
  assert.equal(configuration.readiness.blocker, 'proof_budget_unavailable');
  assert.equal(
    documentBlocker(configuration.readiness.blocker),
    'The approved proof budget is unavailable. New verification requests are paused.',
  );
  const document = await client.upload(
    new File(['%PDF-1.7\nexample\n%%EOF'], 'gold.pdf'),
    signal(),
  );
  assert.equal(document.documentId, 'doc_123');
  assert.equal(document.readiness.canStart, false);
  assert.equal(document.readiness.blocker, 'proof_budget_unavailable');
});

test('status cannot claim mint readiness without a bundle or switch job binding', async () => {
  const job = { jobId: 'job_123', documentId: 'doc_123', requestDigest: hash };
  const state = {
    ...job,
    phase: 'proof',
    status: 'proving',
    detailCode: null,
    bundleReady: false,
    canRetry: false,
  };
  assert.equal(
    (await createDocumentClient(async () => json(state)).status(job, signal()))
      .status,
    'proving',
  );
  for (const patch of [
    { jobId: 'job_other' },
    { documentId: 'doc_other' },
    { requestDigest: `0x${'22'.repeat(32)}` },
    { status: 'ready_to_mint', bundleReady: false },
    { status: 'confirmed' },
    { canRetry: true },
  ]) {
    await assert.rejects(
      createDocumentClient(async () => json({ ...state, ...patch })).status(
        job,
        signal(),
      ),
    );
  }
});

test('a submitted proof observation failure remains readable without implying another submission', async () => {
  const job = { jobId: 'job_123', documentId: 'doc_123', requestDigest: hash };
  const client = createDocumentClient(async () =>
    json({
      ...job,
      phase: 'proof',
      status: 'attention_required',
      detailCode: 'proof_observation_unavailable',
      bundleReady: false,
      canRetry: false,
    }),
  );
  const status = await client.status(job, signal());
  assert.equal(status.bundleReady, false);
  assert.equal(status.canRetry, false);
  assert.match(documentBlocker(status.detailCode), /submitted proof request/);
  assert.doesNotMatch(
    documentBlocker(status.detailCode),
    /invalid response|sign again/,
  );
});

test('unknown service errors, HTML and duplicate JSON keys never become UI messages', async () => {
  for (const response of [
    json(
      { error: { code: 'unexpected', message: 'PRIVATE SERVER TRACE' } },
      500,
    ),
    new Response('<html>SPA fallback</html>', {
      headers: { 'content-type': 'text/html' },
    }),
    new Response('{"issuer":{},"issuer":{}}', {
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    await assert.rejects(
      createDocumentClient(async () => response).configuration(signal()),
      (error) =>
        !error.message.includes('PRIVATE') && !error.message.includes('<html>'),
    );
  }
  await assert.rejects(
    createDocumentClient(async () =>
      json(
        {
          error: { code: 'proof_unavailable', message: 'PRIVATE SERVER TRACE' },
        },
        503,
      ),
    ).configuration(signal()),
    /proof service/i,
  );
});

test('response stream size is bounded even with a dishonest content length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(48 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    createDocumentClient(
      async () =>
        new Response(stream, {
          headers: {
            'content-type': 'application/json',
            'content-length': '2',
          },
        }),
    ).configuration(signal()),
  );
  assert.equal(cancelled, true);
});

// The browser rejects an oversized file before uploading and the service rejects
// it again on arrival, so the same limit is written in two packages that cannot
// import each other: apps/web loads only packages/domain by relative path, and
// demo-service is Node-only. Read the other one and require them to agree,
// otherwise the client would offer a file the service always refuses.
test('the upload limit matches the one the service enforces', async () => {
  const source = await readFile(
    new URL('../../../packages/demo-service/src/service.mjs', import.meta.url),
    'utf8',
  );
  const declared = source.match(
    /export const MAX_PDF_BYTES = ([\d\s*]+);/,
  )?.[1];
  assert.ok(declared, 'demo-service no longer declares MAX_PDF_BYTES');
  const bytes = declared
    .split('*')
    .reduce((total, part) => total * Number(part.trim()), 1);
  assert.equal(bytes, MAX_PDF_BYTES);
});
