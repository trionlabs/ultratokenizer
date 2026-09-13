import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { loadModule } from './helpers.mjs';
const { createDocumentSession } = await loadModule(
  '../src/lib/application/document-session.ts',
);
const { createIssuanceSession } = await loadModule('./fixtures/session.ts');
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const hash = (text) => keccak256(toHex(text));
const file = () => new File(['%PDF-1.7\nexample\n%%EOF'], 'signed.pdf');

async function harness(overrides = {}) {
  const fixture = await createFixture();
  const calls = [];
  const prepared = {
    request: fixture.bundle.request,
    sourceId: fixture.deployment.auditPolicy.sourceId,
    signerFingerprint: fixture.deployment.auditPolicy.sourceSignerFingerprint,
    policyTermsHash: hash('Policy'),
    rightsTermsHash: hash('Rights'),
  };
  const configuration = {
    issuer: {
      label: 'Demo issuer',
      agentId: '116',
      identityRegistry: fixture.bundle.request.gate,
      issuerId: fixture.bundle.request.issuerId,
      wallet: fixture.deployment.auditPolicy.issuerAddress,
      selected: true,
    },
    terms: {
      policy: { text: 'Policy', hash: prepared.policyTermsHash },
      rights: { text: 'Rights', hash: prepared.rightsTermsHash },
      checked: true,
      blockNumber: '1',
    },
    readiness: { canStart: true },
  };
  const document = {
    ...configuration,
    documentId: 'doc_1',
    document: {
      name: 'PRIVATE DOCUMENT NAME.pdf',
      amountMilligrams: fixture.bundle.request.amount,
      recipient: fixture.bundle.request.recipient,
      issuerId: prepared.request.issuerId,
      sourceId: prepared.sourceId,
      sourceSignerFingerprint: prepared.signerFingerprint,
      profile: 'ultratokenizer-synthetic-gold-v2',
      sha256: hash('document'),
    },
  };
  const job = {
    jobId: 'job_1',
    documentId: document.documentId,
    requestDigest: fixture.receipt.requestDigest,
    prepared,
    status: 'awaiting_signature',
    readiness: { canStart: true },
  };
  let status = {
    jobId: job.jobId,
    documentId: job.documentId,
    requestDigest: job.requestDigest,
    phase: 'proof',
    status: 'proving',
    detailCode: null,
    bundleReady: false,
    canRetry: false,
  };
  const holder = createIssuanceSession(() => ({
    connect: async () => ({
      address: prepared.request.recipient,
      chainId: '296',
    }),
    prepareRequest: async (value) => {
      calls.push('prepare-holder');
      return { prepared: value, gatePaused: true };
    },
    signRequest: async () => {
      calls.push('sign');
      return fixture.holderSignature;
    },
    restorePreparedRequest: async (value, signature) => {
      calls.push('restore-holder');
      return { prepared: value, signature, gatePaused: true };
    },
    acceptPreparedBundle: async (bundle) => {
      calls.push('validate-proof');
      return bundle;
    },
    ...overrides.holder,
  }));
  holder.setProvider({ request() {} });
  holder.loadDeployment(JSON.stringify(fixture.deployment));
  await holder.connect();
  const api = {
    configuration: async () => configuration,
    upload: async () => {
      calls.push('upload');
      return document;
    },
    prepare: async () => {
      calls.push('prepare-api');
      return job;
    },
    start: async () => {
      calls.push('start');
      return status;
    },
    status: async () => {
      calls.push('status');
      return status;
    },
    bundle: async () => {
      calls.push('bundle');
      return fixture.bundle;
    },
    refreshPermit: async () => {
      calls.push('permit');
      return status;
    },
    ...overrides.api,
  };
  const session = createDocumentSession(holder, api);
  return {
    session,
    holder,
    calls,
    prepared,
    job,
    document,
    fixture,
    api,
    setStatus: (value) => {
      status = { ...status, ...value };
    },
  };
}

test('document-to-proof sequence signs once before start and accepts proof only after explicit ready response', async () => {
  const h = await harness();
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  assert.deepEqual(h.calls, [
    'upload',
    'prepare-api',
    'prepare-holder',
    'sign',
    'start',
  ]);
  assert.equal(h.holder.read().sourceProof, 'unchecked');
  assert.equal(h.holder.read().transaction, undefined);
  h.setStatus({
    phase: 'issuance',
    status: 'ready_to_mint',
    bundleReady: true,
  });
  await h.session.checkStatus();
  assert.equal(h.holder.read().sourceProof, 'accepted');
  assert.deepEqual(h.calls.slice(-3), ['status', 'bundle', 'validate-proof']);
  assert.equal(h.holder.read().transaction, undefined);
  h.session.dispose();
  h.holder.dispose();
});

test('lost start response retains one immutable job; retries only check its status', async () => {
  const h = await harness({
    api: {
      start: async () => {
        throw new Error('PRIVATE TRACE');
      },
    },
  });
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  assert.equal(h.session.read().started, true);
  assert.ok(h.session.read().job);
  assert.doesNotMatch(h.session.read().error, /PRIVATE/);
  const before = [...h.calls];
  await h.session.verifyAndMint();
  await h.session.upload(file());
  assert.deepEqual(h.calls, before);
  await h.session.checkStatus();
  assert.equal(h.session.read().status.status, 'proving');
  assert.equal(h.holder.read().sourceProof, 'unchecked');
  h.session.dispose();
  h.holder.dispose();
});

test('wallet change while preparing clears consent and cannot start proof with the old request', async () => {
  let release;
  const h = await harness({
    holder: {
      prepareRequest: (prepared) =>
        new Promise((resolve) => {
          release = () => resolve({ prepared, gatePaused: false });
        }),
    },
  });
  await h.session.upload(file());
  h.session.disclose(true);
  const pending = h.session.verifyAndMint();
  await new Promise(setImmediate);
  h.holder.walletChanged();
  release();
  await pending;
  assert.equal(h.session.read().reviewed, false);
  assert.equal(h.holder.read().signature, undefined);
  assert.equal(h.session.read().started, false);
  assert.ok(!h.calls.includes('start'));
  h.session.dispose();
  h.holder.dispose();
});

test('refresh restores only public request data and resumes read-only without another signature or proof request', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const h = await harness();
  h.session.restoreStorage(storage);
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  const saved = [...values.values()][0];
  assert.doesNotMatch(saved, /PRIVATE DOCUMENT|%PDF|amountMilligrams|sha256/);
  h.session.dispose();
  h.holder.walletChanged();
  await h.holder.connect();
  const restored = createDocumentSession(h.holder, h.api);
  restored.restoreStorage(storage);
  const before = [...h.calls];
  assert.equal(restored.read().document, undefined);
  assert.equal(restored.read().job.jobId, h.job.jobId);
  assert.deepEqual(h.calls, before);
  await restored.resume();
  assert.deepEqual(h.calls.slice(before.length), ['restore-holder', 'status']);
  assert.equal(h.holder.read().sourceProof, 'unchecked');
  restored.dispose();
  h.holder.dispose();
});

test('pending configuration cannot make the upload button a no-op; stale results are discarded', async () => {
  let release;
  const h = await harness({
    api: {
      configuration: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  const configuration = h.session.loadConfiguration();
  await h.session.upload(file());
  assert.equal(h.session.read().document.documentId, 'doc_1');
  release({ issuer: { label: 'STALE' } });
  await configuration;
  assert.equal(h.session.read().configuration.issuer.label, 'Demo issuer');
  assert.ok(Object.isFrozen(h.session.read()));
  h.session.dispose();
  h.holder.dispose();
});
