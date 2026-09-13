import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { loadModule } from './helpers.mjs';
const { createDocumentSession } = await loadModule(
  '../src/lib/application/document-session.ts',
);
const { createIssuanceSession, IssuanceClientError } = await loadModule(
  './fixtures/session.ts',
);
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

async function completedDocument(outcome = 'confirmed') {
  const mintHash = hash('confirmed document mint');
  const values = new Map();
  let failRemoval = false;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      if (failRemoval) throw new Error('Storage unavailable');
      values.delete(key);
    },
  };
  const h = await harness({
    holder: {
      simulate: async () => {},
      submit: async () => mintHash,
      wait: async () => {
        if (outcome !== 'confirmed')
          throw new IssuanceClientError(
            outcome === 'reverted'
              ? 'transaction_reverted'
              : 'transaction_uncertain',
          );
        return {
          ...h.fixture.receipt,
          transaction: { ...h.fixture.receipt.transaction, hash: mintHash },
        };
      },
    },
  });
  h.session.restoreStorage(storage);
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  h.setStatus({
    status: 'ready_to_mint',
    phase: 'issuance',
    bundleReady: true,
  });
  await h.session.checkStatus();
  await h.holder.simulate();
  await h.holder.submit();
  if (outcome !== 'pending') await h.holder.confirm();
  assert.equal(h.holder.read().transaction.outcome, outcome);
  return { ...h, values, failRemoval: () => (failRemoval = true) };
}

test('a reuploaded active document signs the same request and resumes with new-proof budget closed', async () => {
  const h = await harness();
  try {
    h.document.readiness = {
      canStart: false,
      blocker: 'proof_budget_unavailable',
    };
    h.document.existingJobStatus = 'proving';
    h.job.status = 'proving';
    h.job.readiness = h.document.readiness;
    await h.session.upload(file());
    h.session.disclose(true);
    await h.session.verifyAndMint();
    assert.equal(h.session.read().error, undefined);
    assert.equal(h.session.read().started, true);
    assert.equal(h.session.read().status.status, 'proving');
    assert.equal(h.session.read().job.requestDigest, h.job.requestDigest);
    assert.equal(
      h.holder.read().preparedRequest.request.requestId,
      h.prepared.request.requestId,
    );
    assert.deepEqual(h.calls, ['upload', 'prepare-api', 'sign', 'start']);
    assert.equal(h.calls.includes('bundle'), false);
  } finally {
    h.session.dispose();
    h.holder.dispose();
  }
});

test('a confirmed document can finish and accept a new PDF without reusing approval or proof', async () => {
  const h = await completedDocument();
  try {
    const { wallet, deployment } = h.holder.read();
    const uploads = h.calls.filter((call) => call === 'upload').length;
    assert.equal(h.values.size, 1);
    assert.equal(h.session.startAnotherDocument(), true);
    assert.equal(h.values.size, 0);
    assert.equal(h.session.read().started, false);
    assert.equal(h.session.read().document, undefined);
    assert.equal(h.session.read().job, undefined);
    assert.equal(h.session.read().reviewed, false);
    assert.equal(h.holder.read().wallet, wallet);
    assert.equal(h.holder.read().deployment, deployment);
    for (const key of [
      'receipt',
      'transaction',
      'signature',
      'preparedRequest',
      'bundle',
      'tokenIntent',
    ])
      assert.equal(h.holder.read()[key], undefined, key);
    assert.equal(h.holder.read().sourceProof, 'unchecked');
    await h.session.upload(file());
    assert.equal(
      h.calls.filter((call) => call === 'upload').length,
      uploads + 1,
    );
    assert.equal(h.calls.filter((call) => call === 'start').length, 1);
  } finally {
    h.session.dispose();
    h.holder.dispose();
  }
});

test('failure to remove a completed browser record preserves its receipt and blocks a new document', async () => {
  const h = await completedDocument();
  try {
    h.failRemoval();
    const receipt = h.holder.read().receipt;
    assert.equal(h.session.startAnotherDocument(), false);
    assert.equal(h.holder.read().receipt, receipt);
    assert.equal(h.session.read().started, true);
    assert.equal(h.values.size, 1);
    assert.match(h.session.read().error, /browser/i);
  } finally {
    h.session.dispose();
    h.holder.dispose();
  }
});

test('starting another document cannot discard an active signed proof job', async () => {
  const h = await harness();
  try {
    await h.session.upload(file());
    h.session.disclose(true);
    await h.session.verifyAndMint();
    const job = h.session.read().job;
    assert.equal(h.session.startAnotherDocument(), false);
    assert.equal(h.session.read().job, job);
    assert.equal(h.session.read().started, true);
  } finally {
    h.session.dispose();
    h.holder.dispose();
  }
});

for (const outcome of ['pending', 'unresolved', 'reverted']) {
  test(`starting another document cannot discard a ${outcome} wallet outcome`, async () => {
    const h = await completedDocument(outcome);
    try {
      const transaction = h.holder.read().transaction;
      const job = h.session.read().job;
      assert.equal(h.session.startAnotherDocument(), false);
      assert.equal(h.holder.read().transaction, transaction);
      assert.equal(h.session.read().job, job);
      assert.equal(h.values.size, 1);
    } finally {
      h.session.dispose();
      h.holder.dispose();
    }
  });
}

test('document-to-proof sequence signs once before start and accepts proof only after explicit ready response', async () => {
  const h = await harness();
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  assert.deepEqual(h.calls, ['upload', 'prepare-api', 'sign', 'start']);
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
      signRequest: () =>
        new Promise((resolve) => {
          release = () => resolve('0x');
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
  assert.deepEqual(h.calls.slice(before.length), ['status']);
  assert.equal(h.holder.read().signature, undefined);
  h.setStatus({
    status: 'ready_to_mint',
    phase: 'issuance',
    bundleReady: true,
  });
  await restored.checkStatus();
  assert.deepEqual(h.calls.slice(before.length), [
    'status',
    'status',
    'restore-holder',
    'bundle',
    'validate-proof',
  ]);
  assert.equal(h.holder.read().sourceProof, 'accepted');
  restored.dispose();
  h.holder.dispose();
});

test('reloaded issuer approval recovery restores the saved signature only on explicit permit refresh', async () => {
  for (const detailCode of [
    'permit_expired',
    'issuer_unavailable',
    'deployment_unavailable',
  ]) {
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
    h.session.dispose();
    h.holder.walletChanged();
    await h.holder.connect();
    const restored = createDocumentSession(h.holder, h.api);
    restored.restoreStorage(storage);
    h.setStatus({
      status: 'attention_required',
      phase: 'issuance',
      detailCode,
      bundleReady: false,
    });
    const before = h.calls.length;
    await restored.resume();
    assert.deepEqual(h.calls.slice(before), ['status']);
    assert.equal(h.holder.read().signature, undefined);
    assert.equal(h.holder.read().sourceProof, 'unchecked');
    h.setStatus({
      status: 'ready_to_mint',
      detailCode: null,
      bundleReady: true,
    });
    await restored.refreshPermit();
    assert.deepEqual(h.calls.slice(before), [
      'status',
      'restore-holder',
      'permit',
      'bundle',
      'validate-proof',
    ]);
    assert.equal(h.calls.filter((call) => call === 'start').length, 1);
    assert.equal(h.holder.read().sourceProof, 'accepted');
    restored.dispose();
    h.holder.dispose();
  }
});

test('a wallet change during saved issuer approval restoration cannot refresh the permit', async () => {
  let finish;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const h = await harness({
    holder: {
      restorePreparedRequest: (prepared, signature) =>
        new Promise((resolve) => {
          finish = () => resolve({ prepared, signature, gatePaused: true });
        }),
    },
  });
  h.session.restoreStorage(storage);
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  h.session.dispose();
  h.holder.walletChanged();
  await h.holder.connect();
  const restored = createDocumentSession(h.holder, h.api);
  restored.restoreStorage(storage);
  h.setStatus({
    status: 'attention_required',
    phase: 'issuance',
    detailCode: 'permit_expired',
    bundleReady: false,
  });
  await restored.resume();
  const pending = restored.refreshPermit();
  assert.equal(typeof finish, 'function');
  h.holder.walletChanged();
  finish();
  await pending;
  assert.ok(!h.calls.includes('permit'));
  assert.equal(h.holder.read().sourceProof, 'unchecked');
  assert.equal(h.holder.read().signature, undefined);
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

// `started` is set before the POST, so a request that never reached the service
// leaves it parked at awaiting_signature while this session believes the job is
// running. Resume must re-send the start it already has a signature for.
test('a start request that never arrived is re-sent once on resume', async () => {
  const h = await harness();
  try {
    // The service never saw the first start, so it still reports the job unsigned.
    h.setStatus({ status: 'awaiting_signature' });
    await h.session.upload(file());
    h.session.disclose(true);
    await h.session.verifyAndMint();
    assert.equal(h.session.read().started, true);
    assert.equal(h.calls.filter((call) => call === 'start').length, 1);

    // The re-sent start is the one that lands, and its status is what sticks.
    h.api.start = async () => {
      h.calls.push('start');
      h.setStatus({ status: 'proving' });
      return {
        ...h.job,
        phase: 'proof',
        status: 'proving',
        bundleReady: false,
      };
    };
    await h.session.resume();
    assert.deepEqual(h.calls.slice(-3), ['status', 'restore-holder', 'start']);
    assert.equal(h.session.read().status.status, 'proving');
  } finally {
    h.session.dispose();
    h.holder.dispose();
  }
});

// A running job reports a running status, so resume must observe it and stop.
test('resume never re-sends start for a job the service has begun', async () => {
  const h = await harness();
  try {
    await h.session.upload(file());
    h.session.disclose(true);
    await h.session.verifyAndMint();
    const before = h.calls.filter((call) => call === 'start').length;
    await h.session.resume();
    assert.equal(h.calls.filter((call) => call === 'start').length, before);
  } finally {
    h.session.dispose();
    h.holder.dispose();
  }
});

// A saved record that will not parse may still have work behind it on the
// service, so a new document cannot quietly start beside it.
test('an unreadable saved job stays visible after configuration and requires acknowledged removal', async () => {
  const h = await harness();
  let removed = 0;
  h.session.restoreStorage({
    getItem: () => 'not json',
    setItem: () => {},
    removeItem: () => {
      removed++;
    },
  });
  assert.equal(h.session.read().unreadable, true);
  assert.match(h.session.read().error, /will not cancel/);
  await h.session.loadConfiguration();
  assert.match(h.session.read().error, /will not cancel/);
  const before = [...h.calls];
  await h.session.upload(file());
  assert.deepEqual(h.calls, before, 'upload stays closed while unreadable');
  h.session.discard();
  assert.equal(h.session.read().unreadable, true);
  assert.equal(removed, 0, 'removal needs explicit acknowledgment');
  h.session.discard(true);
  assert.equal(removed, 1);
  assert.equal(h.session.read().unreadable, false);
  assert.equal(h.session.read().error, undefined);
  await h.session.upload(file());
  assert.deepEqual(h.calls, [...before, 'upload']);
  h.session.dispose();
  h.holder.dispose();
});

test('removal cannot forget a known signed job with an uncertain start', async () => {
  const h = await harness({
    api: {
      start: async () => {
        throw new Error('Lost start response');
      },
    },
  });
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  const job = h.session.read().job;
  const signature = h.holder.read().signature;
  const before = [...h.calls];
  h.session.discard(true);
  assert.equal(h.session.read().started, true);
  assert.equal(h.session.read().job, job);
  assert.equal(h.holder.read().signature, signature);
  await h.session.upload(file());
  assert.deepEqual(h.calls, before);
  h.session.dispose();
  h.holder.dispose();
});

test('failed browser removal keeps the unreadable record closed', async () => {
  const h = await harness();
  h.session.restoreStorage({
    getItem: () => 'not json',
    setItem: () => {},
    removeItem: () => {
      throw new Error('Browser storage denied');
    },
  });
  h.session.discard(true);
  assert.equal(h.session.read().unreadable, true);
  assert.match(h.session.read().error, /could not remove/);
  const before = [...h.calls];
  await h.session.upload(file());
  assert.deepEqual(h.calls, before);
  h.session.dispose();
  h.holder.dispose();
});

test('wallet changes during resume status observation cannot start a paid job', async () => {
  const h = await harness();
  h.setStatus({ status: 'awaiting_signature' });
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  const starts = h.calls.filter((call) => call === 'start').length;
  const status = h.api.status;
  h.api.status = async (...args) => {
    const response = await status(...args);
    h.holder.walletChanged();
    return response;
  };
  await h.session.resume();
  assert.equal(h.calls.filter((call) => call === 'start').length, starts);
  assert.equal(h.holder.read().signature, undefined);
  assert.equal(h.session.read().errorCode, 'wrong_account');
  assert.equal(h.session.read().status.status, 'awaiting_signature');
  h.session.dispose();
  h.holder.dispose();
});

test('a successful unchanged status refresh records completion without manufacturing proof progress', async () => {
  const h = await harness();
  await h.session.upload(file());
  h.session.disclose(true);
  await h.session.verifyAndMint();
  const previous = h.session.read().status;
  const before = Date.now();
  await h.session.checkStatus();
  assert.deepEqual(h.session.read().status, previous);
  assert.ok(h.session.read().statusCheckedAt >= before);
  assert.equal(h.session.read().pending, undefined);
  assert.equal(h.holder.read().sourceProof, 'unchecked');
  assert.equal(h.holder.read().transaction, undefined);
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  h.session.dispose();
  h.holder.dispose();
});
