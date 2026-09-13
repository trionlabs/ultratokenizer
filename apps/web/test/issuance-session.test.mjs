import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './helpers.mjs';
const { createIssuanceSession, IssuanceClientError } = await loadModule(
  './fixtures/session.ts',
);
const { formatGrams, parseTransferGrams } = await loadModule(
  '../src/lib/issuance.ts',
);
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const { createAtsFixture } = await loadModule('./fixtures/ats.ts');

function tokenIntent(fixture, operation, nonce = '7') {
  return Object.freeze({
    format: 'ultratokenizer.token-intent.v1',
    chainId: fixture.deployment.auditPolicy.chainId,
    token: fixture.deployment.auditPolicy.token,
    account: fixture.bundle.request.recipient,
    nonce,
    ...operation,
  });
}

function harness(fixture, overrides = {}) {
  const calls = [];
  const client = {
    connect: async () => ({
      address: fixture.bundle.request.recipient,
      chainId: '296',
    }),
    validate: async (bundle) => {
      calls.push('validate');
      return bundle;
    },
    sign: async () => {
      calls.push('sign');
      return fixture.holderSignature;
    },
    prepareRequest: async (prepared) => {
      calls.push('prepare-request');
      return { prepared, gatePaused: false };
    },
    signRequest: async () => {
      calls.push('sign-request');
      return fixture.holderSignature;
    },
    restorePreparedRequest: async (prepared, signature) => {
      calls.push('restore-request');
      return { prepared, signature, gatePaused: true };
    },
    acceptPreparedBundle: async (bundle, prepared, signature) => {
      calls.push('accept-prepared');
      assert.equal(signature, fixture.holderSignature);
      assert.deepEqual(bundle.request, prepared.request);
      return bundle;
    },
    simulate: async () => {
      calls.push('simulate');
    },
    submit: async () => {
      calls.push('submit');
      return fixture.transactionHash;
    },
    wait: async () => {
      calls.push('wait');
      return fixture.receipt;
    },
    prepareTokenTransaction: async (operation, expectedAccount) => {
      assert.equal(expectedAccount, fixture.bundle.request.recipient);
      calls.push('prepare-token');
      return tokenIntent(fixture, operation);
    },
    sendTokenTransaction: async () => {
      calls.push('send-token');
      return fixture.transactionHash;
    },
    waitTokenTransaction: async () => {
      calls.push('wait-token');
    },
    ...overrides,
  };
  const session = createIssuanceSession(() => client);
  session.setProvider({ request() {} });
  session.loadDeployment(JSON.stringify(fixture.deployment));
  session.loadBundle(JSON.stringify(fixture.bundle));
  return { session, calls };
}
async function ready(session) {
  await session.connect();
  await session.check();
  session.disclose(true);
  await session.sign();
  await session.simulate();
}

test('connecting before deployment requests only wallet access and keeps issuance closed', async () => {
  const fixture = await createFixture();
  const calls = [];
  const session = createIssuanceSession(() => {
    throw new Error('No deployment client may be created yet');
  });
  session.setProvider({
    async request({ method }) {
      calls.push(method);
      if (method === 'eth_requestAccounts')
        return [fixture.bundle.request.recipient];
      if (method === 'eth_chainId') return '0x128';
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  });
  await session.connect();
  assert.deepEqual(calls, ['eth_requestAccounts', 'eth_chainId']);
  assert.deepEqual(session.read().wallet, {
    address: fixture.bundle.request.recipient,
    chainId: '296',
  });
  assert.equal(session.read().transaction, undefined);
  assert.equal(session.read().deployment, undefined);
  session.loadDeployment(JSON.stringify(fixture.deployment));
  assert.equal(session.read().wallet.address, fixture.bundle.request.recipient);
  session.dispose();

  const wrongChain = createIssuanceSession(() => {
    throw new Error('No deployment client may be created yet');
  });
  wrongChain.setProvider({
    async request({ method }) {
      return method === 'eth_requestAccounts'
        ? [fixture.bundle.request.recipient]
        : '0x1';
    },
  });
  await wrongChain.connect();
  wrongChain.loadDeployment(JSON.stringify(fixture.deployment));
  assert.equal(wrongChain.read().wallet.chainId, '1');
  wrongChain.dispose();
});

test('the first wallet grant accepts its accountsChanged event only after fresh account and chain reads', async () => {
  const fixture = await createFixture();
  const methods = [];
  const wallet = { address: fixture.bundle.request.recipient, chainId: '296' };
  let session;
  session = createIssuanceSession(() => ({
    connect: async () => {
      session.walletChanged();
      return wallet;
    },
  }));
  session.setProvider({
    async request({ method }) {
      methods.push(method);
      if (method === 'eth_accounts') return [wallet.address];
      if (method === 'eth_chainId') return '0x128';
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  });
  session.loadDeployment(JSON.stringify(fixture.deployment));
  await session.connect();
  assert.deepEqual(session.read().wallet, wallet);
  assert.deepEqual(methods, ['eth_accounts', 'eth_chainId']);
  assert.equal(session.read().busy, undefined);
  assert.equal(session.read().error, undefined);
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().signature, undefined);
  session.dispose();
});

for (const changed of ['account', 'chain', 'during-observation', 'provider']) {
  test(`a connection cannot accept a stale result after ${changed} changes`, async () => {
    const fixture = await createFixture();
    const wallet = {
      address: fixture.bundle.request.recipient,
      chainId: '296',
    };
    let session;
    session = createIssuanceSession(() => ({
      connect: async () => {
        if (changed === 'provider') session.setProvider({ request() {} });
        else session.walletChanged();
        return wallet;
      },
    }));
    session.setProvider({
      async request({ method }) {
        if (method === 'eth_accounts')
          return [
            changed === 'account'
              ? fixture.deployment.auditPolicy.issuerAddress
              : wallet.address,
          ];
        if (method === 'eth_chainId') {
          if (changed === 'during-observation') session.walletChanged();
          return changed === 'chain' ? '0x1' : '0x128';
        }
        throw new Error(`Unexpected wallet method: ${method}`);
      },
    });
    session.loadDeployment(JSON.stringify(fixture.deployment));
    await session.connect();
    assert.equal(session.read().wallet, undefined);
    assert.equal(session.read().busy, undefined);
    assert.equal(session.read().sourceProof, 'unchecked');
    assert.equal(session.read().signature, undefined);
    assert.ok(session.read().error);
    session.dispose();
  });
}

test('a delayed first-grant reconciliation cannot publish a wallet after its deadline', async (t) => {
  const fixture = await createFixture();
  const wallet = { address: fixture.bundle.request.recipient, chainId: '296' };
  const reply = deferred();
  let session;
  session = createIssuanceSession(() => ({
    connect: async () => {
      session.walletChanged();
      return wallet;
    },
  }));
  session.setProvider({
    async request({ method }) {
      if (method === 'eth_accounts') return reply.promise;
      if (method === 'eth_chainId') return '0x128';
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  });
  session.loadDeployment(JSON.stringify(fixture.deployment));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connecting = session.connect();
  await Promise.resolve();
  t.mock.timers.tick(120_000);
  await connecting;
  assert.equal(session.read().pendingOperation, 'connecting');
  assert.equal(session.read().wallet, undefined);
  reply.resolve([wallet.address]);
  await flushLateReply();
  assert.equal(session.read().pendingOperation, undefined);
  assert.equal(session.read().wallet, undefined);
  assert.match(session.read().error, /delayed check finished/i);
  session.dispose();
});

test('explicit Hedera testnet switch adds an unknown chain, switches again and rechecks account and chain', async () => {
  const fixture = await createFixture();
  const calls = [];
  let known = false;
  let chain = '0x1';
  let session;
  let clientChecks = 0;
  session = createIssuanceSession(() => ({
    connect: async () => {
      clientChecks++;
      return { address: fixture.bundle.request.recipient, chainId: '296' };
    },
  }));
  session.setProvider({
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts')
        return [fixture.bundle.request.recipient];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_addEthereumChain') {
        // The chain the wallet is asked to add carries the endpoint the
        // operator configured, so the wallet reads the chain this app reads.
        assert.deepEqual(params[0], {
          chainId: '0x128',
          chainName: 'Hedera Testnet',
          nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
          rpcUrls: [fixture.deployment.rpcUrl],
          blockExplorerUrls: ['https://hashscan.io/testnet'],
        });
        known = true;
        return null;
      }
      if (method === 'wallet_switchEthereumChain') {
        assert.deepEqual(params, [{ chainId: '0x128' }]);
        if (!known) throw { code: 4902 };
        chain = '0x128';
        session.walletChanged();
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  await session.connect();
  assert.equal(session.read().wallet.chainId, '1');
  assert.equal(clientChecks, 0);
  await session.switchToTestnet();
  assert.equal(
    calls.filter((method) => method.startsWith('wallet_')).length,
    0,
  );
  session.loadDeployment(JSON.stringify(fixture.deployment));
  assert.equal(session.read().wallet.chainId, '1');
  await session.switchToTestnet();
  assert.deepEqual(
    calls.filter((method) => method.startsWith('wallet_')),
    [
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ],
  );
  assert.equal(clientChecks, 1);
  assert.equal(session.read().wallet.chainId, '296');
  assert.equal(session.read().wallet.address, fixture.bundle.request.recipient);
  assert.equal(session.read().transaction, undefined);
  session.dispose();
});

test('a wrong-chain admitted connect retains the account for an explicit switch', async () => {
  const fixture = await createFixture();
  const calls = [];
  const session = createIssuanceSession(() => ({
    connect: async () => {
      throw new IssuanceClientError('wrong_chain');
    },
  }));
  session.setProvider({
    async request({ method }) {
      calls.push(method);
      if (method === 'eth_accounts') return [fixture.bundle.request.recipient];
      if (method === 'eth_chainId') return '0x1';
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  session.loadDeployment(JSON.stringify(fixture.deployment));
  await session.connect();
  assert.deepEqual(calls, ['eth_accounts', 'eth_chainId']);
  assert.equal(session.read().wallet.chainId, '1');
  assert.match(session.read().error, /different chain/);
  assert.equal(session.read().sourceProof, 'unchecked');
  session.dispose();
});

test('declined or ineffective network switch cannot claim the wallet is on testnet', async () => {
  const fixture = await createFixture();
  for (const outcome of ['declined', 'unchanged']) {
    const calls = [];
    let clientChecks = 0;
    const session = createIssuanceSession(() => ({
      connect: async () => {
        clientChecks++;
        throw new Error('Should not validate a mismatched chain');
      },
    }));
    session.setProvider({
      async request({ method }) {
        calls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts')
          return [fixture.bundle.request.recipient];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'wallet_switchEthereumChain') {
          if (outcome === 'declined') throw { code: 4001 };
          return null;
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    await session.connect();
    session.loadDeployment(JSON.stringify(fixture.deployment));
    await session.switchToTestnet();
    assert.equal(session.read().wallet.chainId, '1');
    assert.equal(clientChecks, 0);
    assert.match(
      session.read().error,
      outcome === 'declined' ? /declined/ : /different chain/,
    );
    assert.equal(
      calls.filter((method) => method === 'wallet_addEthereumChain').length,
      0,
    );
    session.dispose();
  }
});

test('browser deployment rejects HTTP IPv6 before replacing the imported session', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  const previous = session.read();
  assert.throws(
    () =>
      session.loadDeployment(
        JSON.stringify({ ...fixture.deployment, rpcUrl: 'http://[::1]:8545/' }),
      ),
    /Use HTTPS, or HTTP at localhost or 127\.0\.0\.1\./,
  );
  assert.equal(session.read(), previous);
  assert.deepEqual(calls, []);
  session.dispose();
});

test('no default inputs or successful states; signing and submission require prior real client outcomes', async () => {
  const empty = createIssuanceSession(() => {
    throw new Error('must not create a default client');
  });
  assert.equal(empty.read().bundle, undefined);
  assert.equal(empty.read().deployment, undefined);
  await empty.submit();
  assert.equal(empty.read().transaction, undefined);
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  await session.sign();
  assert.deepEqual(calls, []);
  await ready(session);
  assert.equal(session.read().transaction, undefined);
  assert.equal(session.read().bundle.request.amount, '1000');
  await session.submit();
  assert.equal(session.read().transaction.outcome, 'pending');
  assert.equal(session.read().receipt, undefined);
  await session.submit();
  assert.equal(calls.filter((call) => call === 'submit').length, 1);
  await session.confirm();
  assert.equal(session.read().transaction.outcome, 'confirmed');
  assert.equal(session.read().receipt, fixture.receipt);
});

test('failed proof checks cannot enable a signature or preflight', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture, {
    validate: async () => {
      throw new Error('invalid');
    },
  });
  await session.connect();
  await session.check();
  session.disclose(true);
  await session.sign();
  await session.simulate();
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().signature, undefined);
  assert.deepEqual(calls, []);
});

test('wallet changes invalidate unsubmitted signing; actual submitted hashes survive and reconcile', async () => {
  const fixture = await createFixture();
  let finishSign;
  const { session } = harness(fixture, {
    sign: () =>
      new Promise((resolve) => {
        finishSign = resolve;
      }),
  });
  await session.connect();
  await session.check();
  session.disclose(true);
  const signing = session.sign();
  session.walletChanged();
  finishSign(fixture.holderSignature);
  await signing;
  assert.equal(session.read().signature, undefined);
  const next = harness(fixture, {
    submit: async () => {
      next.session.walletChanged();
      return fixture.transactionHash;
    },
  });
  await ready(next.session);
  await next.session.submit();
  assert.equal(next.session.read().wallet, undefined);
  assert.equal(next.session.read().transaction.hash, fixture.transactionHash);
  assert.throws(
    () => next.session.loadBundle(JSON.stringify(fixture.bundle)),
    /Reconcile/,
  );
  await next.session.confirm();
  assert.equal(next.session.read().transaction.outcome, 'confirmed');
});

test('uncertain confirmation preserves hash, blocks replacement and retries reconciliation', async () => {
  const fixture = await createFixture();
  let attempts = 0;
  const { session } = harness(fixture, {
    wait: async () => {
      if (++attempts === 1) throw new Error('RPC offline');
      return fixture.receipt;
    },
  });
  await ready(session);
  await session.submit();
  await session.confirm();
  assert.equal(session.read().transaction.hash, fixture.transactionHash);
  assert.equal(session.read().transaction.outcome, 'unresolved');
  assert.throws(
    () => session.loadDeployment(JSON.stringify(fixture.deployment)),
    /Reconcile/,
  );
  await session.confirm();
  assert.equal(session.read().receipt, fixture.receipt);
});

test('a changed amount cannot be imported against the old proof and permit bindings', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture);
  for (const amount of ['999', '1001']) {
    const changed = {
      ...fixture.bundle,
      request: { ...fixture.bundle.request, amount },
    };
    assert.throws(() => session.loadBundle(JSON.stringify(changed)), /invalid/);
  }
  assert.equal(session.read().bundle.request.amount, '1000');
});

test('transfer conversion uses exact milligrams, permits divisions and rejects rounding', () => {
  assert.equal(parseTransferGrams('0.001'), '1');
  assert.equal(parseTransferGrams('0.500'), '500');
  assert.equal(formatGrams('1000'), '1.000');
  for (const amount of [
    '0',
    '-1',
    '1.0001',
    '1e3',
    '1,5',
    ' 1',
    '01',
    '9223372036854775.808',
  ])
    assert.throws(() => parseTransferGrams(amount));
});

test('submission uncertainty without a hash blocks resending and can reconcile a wallet hash', async () => {
  const fixture = await createFixture();
  let sends = 0;
  const { session } = harness(fixture, {
    submit: async () => {
      sends++;
      throw new IssuanceClientError('transaction_uncertain');
    },
  });
  await ready(session);
  await session.submit();
  assert.equal(session.read().unknownSubmission, 'issuance');
  assert.equal(session.read().transaction, undefined);
  await session.submit();
  assert.equal(sends, 1);
  assert.throws(
    () => session.loadBundle(JSON.stringify(fixture.bundle)),
    /Reconcile/,
  );
  await session.recoverIssuanceHash('0x1234');
  assert.equal(session.read().unknownSubmission, 'issuance');
  assert.equal(session.read().transaction, undefined);
  await session.recoverIssuanceHash(fixture.transactionHash);
  assert.equal(session.read().transaction.outcome, 'confirmed');
  assert.equal(session.read().receipt, fixture.receipt);
});

for (const start of ['unknown', 'unresolved']) {
  test(`issuance ${start} recovery authenticates candidates before replacing the retained reference`, async () => {
    const fixture = await createFixture();
    const originalHash = `0x${'dd'.repeat(32)}`;
    const wrongHash = `0x${'bb'.repeat(32)}`;
    const unavailableHash = `0x${'cc'.repeat(32)}`;
    const waits = [];
    let finishWait;
    let sends = 0;
    const { session } = harness(fixture, {
      submit: async () => {
        sends++;
        if (start === 'unknown')
          throw new IssuanceClientError('transaction_uncertain');
        return originalHash;
      },
      wait: async (bundle, signature, hash) => {
        assert.equal(bundle, originalBundle);
        assert.equal(signature, fixture.holderSignature);
        waits.push(hash);
        if (hash === wrongHash)
          throw new IssuanceClientError('issuance_mismatch');
        if (hash !== fixture.transactionHash)
          throw new IssuanceClientError('transaction_uncertain');
        return new Promise((resolve) => {
          finishWait = () => resolve(fixture.receipt);
        });
      },
    });
    const originalBundle = session.read().bundle;
    await ready(session);
    await session.submit();
    if (start === 'unresolved') await session.confirm();
    const original = session.read().transaction;
    const unknown = session.read().unknownSubmission;
    // Reconciliation must use the reader and signed terms captured before send.
    session.setProvider(undefined);
    assert.equal(session.read().signature, undefined);
    for (const candidate of [wrongHash, '0x1234', unavailableHash]) {
      await session.recoverIssuanceHash(candidate);
      assert.equal(session.read().transaction, original);
      assert.equal(session.read().unknownSubmission, unknown);
      assert.equal(session.read().receipt, undefined);
      assert.ok(session.read().error);
      assert.throws(
        () => session.loadBundle(JSON.stringify(fixture.bundle)),
        /Reconcile/,
      );
    }
    const recovering = session.recoverIssuanceHash(fixture.transactionHash);
    assert.equal(session.read().transaction, original);
    assert.equal(session.read().unknownSubmission, unknown);
    assert.equal(session.read().busy, 'confirming');
    // A further provider change cannot invalidate an authenticated historical outcome.
    session.setProvider({
      request() {
        throw new Error('replacement provider must not read');
      },
    });
    finishWait();
    await recovering;
    assert.deepEqual(session.read().transaction, {
      hash: fixture.transactionHash,
      outcome: 'confirmed',
    });
    assert.equal(session.read().unknownSubmission, undefined);
    assert.equal(session.read().receipt, fixture.receipt);
    assert.equal(session.read().error, undefined);
    assert.deepEqual(waits, [
      ...(start === 'unresolved' ? [originalHash] : []),
      wrongHash,
      unavailableHash,
      fixture.transactionHash,
    ]);
    assert.equal(sends, 1);
    const confirmed = session.read().transaction;
    await session.recoverIssuanceHash(wrongHash);
    assert.equal(session.read().transaction, confirmed);
    assert.equal(session.read().receipt, fixture.receipt);
    assert.equal(waits.at(-1), fixture.transactionHash);
  });

  test(`issuance ${start} recovery cannot settle an original attempt from another reverted call`, async () => {
    const fixture = await createFixture();
    const originalHash = `0x${'dd'.repeat(32)}`;
    const successHash = `0x${'ee'.repeat(32)}`;
    const successReceipt = {
      ...fixture.receipt,
      transaction: { ...fixture.receipt.transaction, hash: successHash },
    };
    let originalAvailable = false;
    const { session } = harness(fixture, {
      submit: async () => {
        if (start === 'unknown')
          throw new IssuanceClientError('transaction_uncertain');
        return originalHash;
      },
      wait: async (bundle, signature, hash) => {
        assert.equal(bundle, originalBundle);
        assert.equal(signature, fixture.holderSignature);
        if (hash === successHash) return successReceipt;
        throw new IssuanceClientError(
          hash === originalHash && !originalAvailable
            ? 'transaction_uncertain'
            : 'transaction_reverted',
        );
      },
    });
    const originalBundle = session.read().bundle;
    await ready(session);
    await session.submit();
    if (start === 'unresolved') await session.confirm();
    const original = session.read().transaction;
    const unknown = session.read().unknownSubmission;
    session.setProvider(undefined);
    // Exact request calldata may be copied into another sender/nonce's reverted call.
    await session.recoverIssuanceHash(fixture.transactionHash);
    assert.equal(session.read().transaction, original);
    assert.equal(session.read().unknownSubmission, unknown);
    assert.equal(session.read().receipt, undefined);
    assert.equal(
      session.read().error,
      new IssuanceClientError('issuance_recovery_unresolved').message,
    );
    assert.throws(
      () => session.loadDeployment(JSON.stringify(fixture.deployment)),
      /Reconcile/,
    );
    if (start === 'unknown') {
      // A successful canonical issuance does settle the logical exact request.
      await session.recoverIssuanceHash(successHash);
      assert.deepEqual(session.read().transaction, {
        hash: successHash,
        outcome: 'confirmed',
      });
      assert.equal(session.read().receipt, successReceipt);
    } else {
      // The retained original submitted hash identifies this attempt's own revert.
      originalAvailable = true;
      await session.recoverIssuanceHash(originalHash);
      assert.deepEqual(session.read().transaction, {
        hash: originalHash,
        outcome: 'reverted',
      });
      assert.equal(session.read().receipt, undefined);
      assert.equal(
        session.read().error,
        new IssuanceClientError('transaction_reverted').message,
      );
    }
    assert.equal(session.read().unknownSubmission, undefined);
    session.loadDeployment(JSON.stringify(fixture.deployment));
  });
}

test('issuance preflight unavailability does not claim a wallet broadcast and permits a checked retry', async () => {
  const fixture = await createFixture();
  let attempts = 0;
  const { session } = harness(fixture, {
    submit: async () => {
      if (++attempts === 1)
        throw new IssuanceClientError('issuance_preflight_unavailable');
      return fixture.transactionHash;
    },
  });
  await ready(session);
  await session.submit();
  assert.equal(session.read().unknownSubmission, undefined);
  assert.equal(session.read().transaction, undefined);
  assert.equal(
    session.read().error,
    new IssuanceClientError('issuance_preflight_unavailable').message,
  );
  await session.recoverIssuanceHash(fixture.transactionHash);
  assert.equal(session.read().transaction, undefined);
  await ready(session);
  await session.submit();
  await session.confirm();
  assert.equal(attempts, 2);
  assert.equal(session.read().receipt, fixture.receipt);
});

test('explicit no-send acknowledgement invalidates prior checks before allowing another attempt', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture, {
    submit: async () => {
      throw new IssuanceClientError('transaction_uncertain');
    },
  });
  await ready(session);
  await session.submit();
  session.acknowledgeNotSent();
  assert.equal(session.read().unknownSubmission, undefined);
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().signature, undefined);
  assert.equal(session.read().simulation, 'unchecked');
});

for (const format of [
  'ultratokenizer.deployment.v1',
  'ultratokenizer.deployment.v2',
]) {
  test(`${format} HTS association records the client hash and waits for its outcome`, async () => {
    const fixture = await createFixture();
    if (format === 'ultratokenizer.deployment.v2')
      fixture.deployment = {
        ...fixture.deployment,
        format,
        backend: { kind: 'hts' },
      };
    const calls = [];
    const intent = tokenIntent(fixture, { kind: 'association' });
    const { session } = harness(fixture, {
      prepareTokenTransaction: async (operation, expectedAccount) => {
        assert.deepEqual(operation, { kind: 'association' });
        assert.equal(expectedAccount, intent.account);
        calls.push('prepare');
        return intent;
      },
      sendTokenTransaction: async (candidate) => {
        assert.equal(candidate, intent);
        assert.equal(session.read().tokenIntent, intent);
        calls.push('send');
        return fixture.transactionHash;
      },
      waitTokenTransaction: async (hash, candidate) => {
        assert.equal(candidate, intent);
        calls.push(hash);
      },
    });
    await session.connect();
    await session.associate();
    assert.deepEqual(session.read().tokenTransaction, {
      hash: fixture.transactionHash,
      kind: 'association',
      outcome: 'pending',
    });
    await session.associate();
    assert.deepEqual(calls, ['prepare', 'send']);
    await session.confirmToken();
    assert.equal(session.read().tokenTransaction.outcome, 'confirmed');
    assert.deepEqual(calls, ['prepare', 'send', fixture.transactionHash]);
  });
}

test('ATS association is rejected before constructing or invoking a client', async () => {
  const fixture = await createAtsFixture();
  let clientCreations = 0;
  const session = createIssuanceSession(() => {
    clientCreations++;
    throw new Error('ATS association must never reach the client');
  });
  session.setProvider({ request() {} });
  session.loadDeployment(JSON.stringify(fixture.deployment));
  session.loadBundle(JSON.stringify(fixture.bundle));
  await session.associate();
  assert.equal(clientCreations, 0);
  assert.equal(
    session.read().error,
    new IssuanceClientError('unsupported_operation').message,
  );
  assert.equal(session.read().tokenTransaction, undefined);
  assert.equal(session.read().unknownSubmission, undefined);
  assert.equal(session.read().bundle.request.amount, '1000');
});

test('ATS fractional transfers retain the client hash through uncertain confirmation and block resending', async () => {
  const fixture = await createAtsFixture();
  const transfers = [];
  let confirmations = 0;
  const { session } = harness(fixture, {
    prepareTokenTransaction: async (operation, expectedAccount) => {
      assert.equal(expectedAccount, fixture.bundle.request.recipient);
      assert.equal(operation.kind, 'transfer');
      transfers.push({
        recipient: operation.recipient,
        amount: operation.milligrams,
      });
      return tokenIntent(fixture, operation);
    },
    sendTokenTransaction: async (intent) => {
      assert.equal(intent.milligrams, '125');
      assert.equal(session.read().tokenIntent, intent);
      return fixture.transactionHash;
    },
    waitTokenTransaction: async (hash, intent) => {
      assert.equal(hash, fixture.transactionHash);
      assert.equal(intent, session.read().tokenIntent);
      if (++confirmations === 1) throw new Error('RPC unavailable');
    },
  });
  await ready(session);
  await session.submit();
  await session.confirm();
  assert.equal(session.read().receipt.request.amount, '1000');
  const recipient = '0x9999999999999999999999999999999999999999';
  const amount = parseTransferGrams('0.125');
  await session.transfer(recipient, amount);
  assert.deepEqual(session.read().tokenTransaction, {
    hash: fixture.transactionHash,
    kind: 'transfer',
    outcome: 'pending',
  });
  await session.confirmToken();
  assert.equal(session.read().tokenTransaction.outcome, 'unresolved');
  assert.equal(session.read().tokenTransaction.hash, fixture.transactionHash);
  assert.throws(
    () => session.loadDeployment(JSON.stringify(fixture.deployment)),
    /Reconcile/,
  );
  await session.transfer(recipient, amount);
  assert.deepEqual(transfers, [{ recipient, amount: '125' }]);
  await session.confirmToken();
  assert.equal(session.read().tokenTransaction.outcome, 'confirmed');
  assert.equal(session.read().bundle.request.amount, '1000');
});

test('ATS transfer uncertainty without a hash blocks another wallet call', async () => {
  const fixture = await createAtsFixture();
  let sends = 0;
  const { session } = harness(fixture, {
    sendTokenTransaction: async () => {
      sends++;
      throw new IssuanceClientError('transaction_uncertain');
    },
  });
  await session.connect();
  await session.transfer(fixture.bundle.request.recipient, '1');
  assert.equal(session.read().unknownSubmission, 'transfer');
  assert.equal(session.read().tokenTransaction, undefined);
  await session.transfer(fixture.bundle.request.recipient, '1');
  assert.equal(sends, 1);
  assert.throws(
    () => session.loadBundle(JSON.stringify(fixture.bundle)),
    /Reconcile/,
  );
});

for (const kind of ['association', 'transfer']) {
  test(`${kind} recovery preserves original client, account and intent through wallet/provider changes`, async () => {
    const fixture = await createFixture();
    const operation =
      kind === 'association'
        ? { kind }
        : { kind, recipient: fixture.policy.issuerAddress, milligrams: '125' };
    const intent = tokenIntent(fixture, operation);
    const candidateHash = `0x${'bb'.repeat(32)}`;
    let sends = 0;
    const waits = [];
    const { session } = harness(fixture, {
      prepareTokenTransaction: async (_operation, expectedAccount) => {
        assert.deepEqual(_operation, operation);
        assert.equal(expectedAccount, intent.account);
        return intent;
      },
      sendTokenTransaction: async (candidate) => {
        assert.equal(candidate, intent);
        assert.equal(session.read().tokenIntent, intent);
        sends++;
        session.walletChanged();
        throw new IssuanceClientError('transaction_uncertain');
      },
      waitTokenTransaction: async (hash, candidate) => {
        assert.equal(candidate, intent);
        waits.push(hash);
        if (hash !== fixture.transactionHash)
          throw new IssuanceClientError('issuance_mismatch');
      },
    });
    await session.connect();
    if (kind === 'association') await session.associate();
    else await session.transfer(operation.recipient, operation.milligrams);
    assert.equal(session.read().unknownSubmission, kind);
    assert.equal(session.read().wallet, undefined);
    assert.equal(session.read().tokenIntent, intent);
    assert.throws(
      () => session.loadDeployment(JSON.stringify(fixture.deployment)),
      /Reconcile/,
    );
    session.setProvider(undefined);
    await session.recoverTokenHash(candidateHash);
    assert.equal(session.read().unknownSubmission, kind);
    assert.equal(session.read().tokenTransaction, undefined);
    assert.equal(session.read().tokenIntent, intent);
    await session.recoverTokenHash(fixture.transactionHash);
    assert.equal(session.read().unknownSubmission, undefined);
    assert.equal(session.read().tokenTransaction.outcome, 'confirmed');
    assert.equal(session.read().tokenTransaction.hash, fixture.transactionHash);
    assert.deepEqual(waits, [candidateHash, fixture.transactionHash]);
    assert.equal(sends, 1);
  });
}

for (const kind of ['association', 'transfer']) {
  test(`${kind} lost-hash recovery records an authenticated revert without claiming no broadcast`, async () => {
    const fixture = await createFixture();
    let sends = 0;
    const { session } = harness(fixture, {
      sendTokenTransaction: async () => {
        sends++;
        throw new IssuanceClientError('transaction_uncertain');
      },
      waitTokenTransaction: async (hash, intent) => {
        assert.equal(hash, fixture.transactionHash);
        assert.equal(intent.kind, kind);
        throw new IssuanceClientError('transaction_reverted');
      },
    });
    await session.connect();
    if (kind === 'association') await session.associate();
    else await session.transfer(fixture.policy.issuerAddress, '125');
    assert.equal(session.read().unknownSubmission, kind);
    session.setProvider(undefined);
    await session.recoverTokenHash(fixture.transactionHash);
    assert.equal(session.read().unknownSubmission, undefined);
    assert.deepEqual(session.read().tokenTransaction, {
      hash: fixture.transactionHash,
      kind,
      outcome: 'reverted',
    });
    assert.equal(session.read().tokenIntent.kind, kind);
    assert.equal(sends, 1);
    session.loadDeployment(JSON.stringify(fixture.deployment));
  });
}

test('a token preparation failure does not create an unknown broadcast or a token attempt', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture, {
    prepareTokenTransaction: async () => {
      throw new IssuanceClientError('transaction_uncertain');
    },
  });
  await session.connect();
  await session.transfer(fixture.policy.issuerAddress, '125');
  assert.equal(session.read().unknownSubmission, undefined);
  assert.equal(session.read().tokenIntent, undefined);
  assert.equal(session.read().tokenTransaction, undefined);
  assert.equal(calls.includes('send-token'), false);
  session.loadDeployment(JSON.stringify(fixture.deployment));
});

test('a send preflight outage permits a fresh check without claiming that a wallet broadcast occurred', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture, {
    sendTokenTransaction: async () => {
      throw new IssuanceClientError('token_preflight_unavailable');
    },
  });
  await session.connect();
  await session.transfer(fixture.policy.issuerAddress, '125');
  assert.equal(session.read().unknownSubmission, undefined);
  assert.equal(session.read().tokenTransaction, undefined);
  assert.equal(session.read().tokenIntent.milligrams, '125');
  assert.equal(
    session.read().error,
    new IssuanceClientError('token_preflight_unavailable').message,
  );
  session.loadDeployment(JSON.stringify(fixture.deployment));
});

for (const change of ['account', 'provider']) {
  test(`${change} changes during token preparation prevent the send`, async () => {
    const fixture = await createFixture();
    let finishPreparation;
    const { session, calls } = harness(fixture, {
      prepareTokenTransaction: (operation) =>
        new Promise((resolve) => {
          finishPreparation = () => resolve(tokenIntent(fixture, operation));
        }),
    });
    await session.connect();
    const preparing = session.transfer(fixture.policy.issuerAddress, '125');
    if (change === 'account') session.walletChanged();
    else session.setProvider({ request() {} });
    finishPreparation();
    await preparing;
    assert.equal(session.read().wallet, undefined);
    assert.equal(session.read().tokenIntent, undefined);
    assert.equal(session.read().unknownSubmission, undefined);
    assert.equal(calls.includes('send-token'), false);
  });
}

test('a returned token hash and original client survive a provider change; failed correction preserves the hash', async () => {
  const fixture = await createFixture();
  let attempts = 0;
  const wrongHash = `0x${'bb'.repeat(32)}`;
  const { session } = harness(fixture, {
    sendTokenTransaction: async () => {
      session.setProvider(undefined);
      return fixture.transactionHash;
    },
    waitTokenTransaction: async (hash, intent) => {
      assert.equal(intent.milligrams, '125');
      if (++attempts === 1) throw new Error('RPC unavailable');
      if (hash !== fixture.transactionHash)
        throw new IssuanceClientError('issuance_mismatch');
    },
  });
  await session.connect();
  await session.transfer(fixture.policy.issuerAddress, '125');
  await session.confirmToken();
  assert.equal(session.read().tokenTransaction.outcome, 'unresolved');
  await session.recoverTokenHash(wrongHash);
  assert.equal(session.read().tokenTransaction.hash, fixture.transactionHash);
  assert.equal(session.read().tokenTransaction.outcome, 'unresolved');
  await session.confirmToken();
  assert.equal(session.read().tokenTransaction.outcome, 'confirmed');
});

test('token actions require a displayed wallet and wait for unresolved issuance', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  await session.transfer(fixture.policy.issuerAddress, '125');
  assert.equal(calls.includes('prepare-token'), false);
  await ready(session);
  await session.submit();
  await session.associate();
  await session.transfer(fixture.policy.issuerAddress, '125');
  assert.equal(calls.includes('prepare-token'), false);
});

for (const kind of ['issuance', 'transfer', 'association']) {
  test(`${kind} malformed recovery hashes get specific guidance without reading or changing the attempt`, async () => {
    const fixture = await createFixture();
    let reads = 0;
    const { session } = harness(fixture, {
      submit: async () => {
        throw new IssuanceClientError('transaction_uncertain');
      },
      sendTokenTransaction: async () => {
        throw new IssuanceClientError('transaction_uncertain');
      },
      wait: async () => {
        reads++;
        return fixture.receipt;
      },
      waitTokenTransaction: async () => {
        reads++;
      },
    });
    if (kind === 'issuance') {
      await ready(session);
      await session.submit();
    } else {
      await session.connect();
      if (kind === 'transfer')
        await session.transfer(fixture.policy.issuerAddress, '125');
      else await session.associate();
    }
    const prior = session.read();
    for (const hash of ['0x1234', `0x${'00'.repeat(32)}`, '', null, {}]) {
      if (kind === 'issuance') await session.recoverIssuanceHash(hash);
      else await session.recoverTokenHash(hash);
      assert.match(
        session.read().error,
        /full nonzero 32-byte transaction hash/,
      );
      assert.equal(session.read().unknownSubmission, prior.unknownSubmission);
      assert.equal(session.read().transaction, prior.transaction);
      assert.equal(session.read().tokenIntent, prior.tokenIntent);
    }
    assert.equal(reads, 0);
  });
}

for (const outcome of ['confirmed', 'reverted']) {
  test(`reimporting a bundle clears ${outcome} token status and its retained intent`, async () => {
    const fixture = await createFixture();
    const { session } = harness(fixture, {
      waitTokenTransaction: async () => {
        if (outcome === 'reverted')
          throw new IssuanceClientError('transaction_reverted');
      },
    });
    await session.connect();
    await session.transfer(fixture.policy.issuerAddress, '125');
    await session.confirmToken();
    assert.equal(session.read().tokenTransaction.outcome, outcome);
    // Even reimporting the same bundle starts a new presentation session.
    session.loadBundle(JSON.stringify(fixture.bundle));
    assert.equal(session.read().tokenTransaction, undefined);
    assert.equal(session.read().tokenIntent, undefined);
    assert.equal(session.read().balanceMg, undefined);
    await session.confirmToken();
    assert.equal(session.read().tokenTransaction, undefined);
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flushLateReply = () => new Promise((resolve) => setImmediate(resolve));

for (const operation of ['checking', 'simulating', 'refreshing']) {
  for (const late of ['result', 'error']) {
    test(`${operation} deadline allows a new check and ignores the expired ${late}`, async (t) => {
      const fixture = await createFixture();
      const original = deferred();
      const replacement = deferred();
      let armed = false;
      let reads = 0;
      const method = {
        checking: 'validate',
        simulating: 'simulate',
        refreshing: 'balance',
      }[operation];
      const { session } = harness(fixture, {
        [method]: () => {
          if (!armed) return Promise.resolve();
          reads++;
          return reads === 1 ? original.promise : replacement.promise;
        },
      });
      await ready(session);
      armed = true;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const check = () =>
        operation === 'checking'
          ? session.check()
          : operation === 'simulating'
            ? session.simulate()
            : session.refreshBalance();
      const expired = check();
      t.mock.timers.tick(120_000);
      await expired;
      assert.equal(session.read().busy, undefined);
      assert.equal(session.read().pendingOperation, undefined);
      assert.equal(session.read().unknownSubmission, undefined);
      assert.match(session.read().error, /read-only check timed out/i);
      const retry = check();
      assert.equal(reads, 2);
      const beforeLateReply = session.read();
      if (late === 'result') original.resolve(900n);
      else original.reject(new Error('Expired read must not reach the UI'));
      await flushLateReply();
      assert.deepEqual(session.read(), beforeLateReply);
      replacement.resolve(125n);
      await retry;
      assert.equal(session.read().busy, undefined);
      assert.equal(session.read().error, undefined);
      if (operation === 'checking')
        assert.equal(session.read().sourceProof, 'accepted');
      if (operation === 'simulating')
        assert.equal(session.read().simulation, 'passed');
      if (operation === 'refreshing')
        assert.equal(session.read().balanceMg, 125n);
      assert.equal(session.read().transaction, undefined);
      session.dispose();
    });
  }
}

for (const operation of ['connecting', 'signing']) {
  test(`${operation} deadline retains the prompt lock and discards its late approval`, async (t) => {
    const fixture = await createFixture();
    const reply = deferred();
    let armed = false;
    let prompts = 0;
    const wallet = {
      address: fixture.bundle.request.recipient,
      chainId: '296',
    };
    const result =
      operation === 'connecting' ? wallet : fixture.holderSignature;
    const { session, calls } = harness(fixture, {
      [operation === 'connecting' ? 'connect' : 'sign']: () => {
        if (!armed) return Promise.resolve(result);
        prompts++;
        return reply.promise;
      },
    });
    await ready(session);
    armed = true;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const prompt = () =>
      operation === 'connecting' ? session.connect() : session.sign();
    const pending = prompt();
    t.mock.timers.tick(120_000);
    await pending;
    assert.equal(session.read().pendingOperation, operation);
    assert.equal(session.read().unknownSubmission, undefined);
    const snapshot = session.read();
    const previousCalls = [...calls];
    await prompt();
    await session.check();
    await session.submit();
    session.acknowledgeNotSent();
    assert.equal(prompts, 1);
    assert.deepEqual(calls, previousCalls);
    assert.deepEqual(session.read(), snapshot);
    assert.throws(
      () => session.loadBundle(JSON.stringify(fixture.bundle)),
      /Reconcile/,
    );
    reply.resolve(result);
    await flushLateReply();
    assert.equal(session.read().pendingOperation, undefined);
    if (operation === 'signing')
      assert.equal(session.read().signature, undefined);
    assert.match(session.read().error, /delayed check finished/i);
    session.dispose();
  });
}

for (const kind of ['issuance', 'association', 'transfer']) {
  test(`${kind} transaction decline retains the attempt and blocks a new action`, async () => {
    const fixture = await createFixture();
    let sends = 0;
    const decline = async () => {
      sends++;
      throw new IssuanceClientError('transaction_declined');
    };
    const { session } = harness(fixture, {
      submit: decline,
      sendTokenTransaction: decline,
    });
    await ready(session);
    const send = () =>
      kind === 'issuance'
        ? session.submit()
        : kind === 'association'
          ? session.associate()
          : session.transfer(fixture.bundle.request.recipient, '1');
    await send();
    assert.equal(session.read().unknownSubmission, kind);
    assert.match(session.read().error, /reported a transaction rejection/);
    const intent = session.read().tokenIntent;
    await send();
    assert.equal(sends, 1);
    assert.equal(session.read().tokenIntent, intent);
    if (kind === 'issuance')
      await session.recoverIssuanceHash(fixture.transactionHash);
    else await session.recoverTokenHash(fixture.transactionHash);
    assert.equal(session.read().unknownSubmission, undefined);
    assert.equal(
      (kind === 'issuance'
        ? session.read().transaction
        : session.read().tokenTransaction
      ).outcome,
      'confirmed',
    );
  });

  for (const late of ['hash', 'rejection', 'different-hash']) {
    test(`${kind} deadline preserves recovery and a late ${late} cannot unlock another wallet call`, async (t) => {
      const fixture = await createFixture();
      const entered = deferred();
      const reply = deferred();
      let sends = 0;
      const pending = () => {
        sends++;
        entered.resolve();
        return reply.promise;
      };
      const { session } = harness(fixture, {
        submit: pending,
        sendTokenTransaction: pending,
      });
      await ready(session);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const call =
        kind === 'issuance'
          ? session.submit()
          : kind === 'association'
            ? session.associate()
            : session.transfer(fixture.bundle.request.recipient, '1');
      await entered.promise;
      t.mock.timers.tick(120_000);
      await call;
      assert.equal(session.read().busy, undefined);
      assert.ok(session.read().pendingOperation);
      assert.equal(session.read().unknownSubmission, kind);
      session.acknowledgeNotSent();
      assert.equal(session.read().unknownSubmission, kind);
      assert.throws(
        () => session.loadBundle(JSON.stringify(fixture.bundle)),
        /Reconcile/,
      );
      await session.transfer(fixture.bundle.request.recipient, '1');
      assert.equal(sends, 1);
      session.walletChanged();
      session.setProvider({
        request() {
          throw new Error('Use the captured reader');
        },
      });
      if (kind === 'issuance')
        await session.recoverIssuanceHash(fixture.transactionHash);
      else await session.recoverTokenHash(fixture.transactionHash);
      assert.equal(
        (kind === 'issuance'
          ? session.read().transaction
          : session.read().tokenTransaction
        ).outcome,
        'confirmed',
      );
      // Even a reconciled hash cannot cancel the still-open provider call.
      assert.ok(session.read().pendingOperation);
      if (late === 'rejection')
        reply.reject(new IssuanceClientError('transaction_declined'));
      else
        reply.resolve(
          late === 'hash' ? fixture.transactionHash : `0x${'ab'.repeat(32)}`,
        );
      await flushLateReply();
      assert.equal(session.read().pendingOperation, undefined);
      assert.equal(session.read().unknownSubmission, undefined);
      assert.equal(
        (kind === 'issuance'
          ? session.read().transaction
          : session.read().tokenTransaction
        ).outcome,
        late === 'different-hash' ? 'unresolved' : 'confirmed',
      );
      assert.equal(sends, 1);
      session.dispose();
    });
  }
}

test('a late wallet hash cannot clear a newer recovery operation busy state', async (t) => {
  const fixture = await createFixture();
  const reply = deferred();
  const recovery = deferred();
  const { session } = harness(fixture, {
    submit: () => reply.promise,
    wait: () => recovery.promise,
  });
  await ready(session);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = session.submit();
  t.mock.timers.tick(120_000);
  await call;
  const confirming = session.recoverIssuanceHash(fixture.transactionHash);
  assert.equal(session.read().busy, 'confirming');
  reply.resolve(fixture.transactionHash);
  await flushLateReply();
  assert.equal(session.read().busy, 'confirming');
  assert.equal(session.read().transaction.hash, fixture.transactionHash);
  assert.equal(session.read().pendingOperation, undefined);
  recovery.resolve(fixture.receipt);
  await confirming;
  assert.equal(session.read().transaction.outcome, 'confirmed');
  assert.equal(session.read().busy, undefined);
});

for (const kind of ['issuance', 'association', 'transfer']) {
  for (const recoveredOutcome of ['confirmed', 'reverted']) {
    test(`${kind} ${recoveredOutcome} recovery cannot overwrite a conflicting wallet hash returned during verification`, async (t) => {
      const fixture = await createFixture();
      const lateHash = `0x${'bb'.repeat(32)}`;
      assert.notEqual(lateHash, fixture.transactionHash);
      const entered = deferred();
      const reply = deferred();
      const recovery = deferred();
      let sends = 0;
      const pending = () => {
        sends++;
        entered.resolve();
        return reply.promise;
      };
      const originalReceipt = {
        ...fixture.receipt,
        transaction: { ...fixture.receipt.transaction, hash: lateHash },
      };
      const wait = (hash) => {
        if (hash === fixture.transactionHash) return recovery.promise;
        assert.equal(hash, lateHash);
        return Promise.resolve(originalReceipt);
      };
      const { session } = harness(fixture, {
        submit: pending,
        sendTokenTransaction: pending,
        wait: (_bundle, _signature, hash) => wait(hash),
        waitTokenTransaction: (hash) => wait(hash),
      });
      await ready(session);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const send = () =>
        kind === 'issuance'
          ? session.submit()
          : kind === 'association'
            ? session.associate()
            : session.transfer(fixture.policy.issuerAddress, '125');
      const call = send();
      await entered.promise;
      t.mock.timers.tick(120_000);
      await call;
      const confirming =
        kind === 'issuance'
          ? session.recoverIssuanceHash(fixture.transactionHash)
          : session.recoverTokenHash(fixture.transactionHash);
      const current = () =>
        kind === 'issuance'
          ? session.read().transaction
          : session.read().tokenTransaction;
      reply.resolve(lateHash);
      await flushLateReply();
      assert.equal(current().hash, lateHash);
      assert.equal(session.read().busy, 'confirming');
      if (recoveredOutcome === 'confirmed') recovery.resolve(fixture.receipt);
      else recovery.reject(new IssuanceClientError('transaction_reverted'));
      await confirming;
      assert.equal(current().hash, lateHash);
      assert.equal(current().outcome, 'unresolved');
      assert.equal(session.read().receipt, undefined);
      assert.equal(session.read().unknownSubmission, undefined);
      assert.equal(session.read().pendingOperation, undefined);
      assert.match(session.read().error, /different hash while recovery/);
      assert.throws(
        () => session.loadBundle(JSON.stringify(fixture.bundle)),
        /Reconcile/,
      );
      await send();
      assert.equal(sends, 1);
      // Reconciliation still uses the original attempt and its retained hash.
      if (kind === 'issuance') await session.confirm();
      else await session.confirmToken();
      assert.equal(current().hash, lateHash);
      assert.equal(current().outcome, 'confirmed');
      if (kind === 'issuance')
        assert.equal(session.read().receipt, originalReceipt);
      session.dispose();
    });
  }
}

test('expired token preparation cannot resume into a late wallet send', async (t) => {
  const fixture = await createFixture();
  const preparation = deferred();
  const { session, calls } = harness(fixture, {
    prepareTokenTransaction: () => preparation.promise,
  });
  await session.connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = session.transfer(fixture.bundle.request.recipient, '1');
  t.mock.timers.tick(120_000);
  await call;
  assert.equal(session.read().unknownSubmission, undefined);
  assert.equal(session.read().pendingOperation, 'transferring');
  preparation.resolve(
    tokenIntent(fixture, {
      kind: 'transfer',
      recipient: fixture.bundle.request.recipient,
      milligrams: '1',
    }),
  );
  await flushLateReply();
  assert.equal(calls.includes('send-token'), false);
  assert.equal(session.read().tokenIntent, undefined);
  assert.equal(session.read().pendingOperation, undefined);
});

for (const code of ['issuance_preflight_unavailable', 'rpc_chain_mismatch']) {
  test(`a delayed ${code} clears uncertainty without inventing a transaction`, async (t) => {
    const fixture = await createFixture();
    const reply = deferred();
    const { session } = harness(fixture, { submit: () => reply.promise });
    await ready(session);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const call = session.submit();
    t.mock.timers.tick(120_000);
    await call;
    assert.equal(session.read().unknownSubmission, 'issuance');
    const error = new IssuanceClientError(code);
    reply.reject(error);
    await flushLateReply();
    assert.equal(session.read().pendingOperation, undefined);
    assert.equal(session.read().unknownSubmission, undefined);
    assert.equal(session.read().transaction, undefined);
    assert.equal(session.read().error, error.message);
    assert.doesNotThrow(() =>
      session.loadDeployment(JSON.stringify(fixture.deployment)),
    );
    session.dispose();
  });
}

test('disposing during token preparation prevents a later wallet call', async () => {
  const fixture = await createFixture();
  const preparation = deferred();
  const { session, calls } = harness(fixture, {
    prepareTokenTransaction: () => preparation.promise,
  });
  await session.connect();
  const call = session.transfer(fixture.bundle.request.recipient, '1');
  session.dispose();
  preparation.resolve(
    tokenIntent(fixture, {
      kind: 'transfer',
      recipient: fixture.bundle.request.recipient,
      milligrams: '1',
    }),
  );
  await call;
  assert.equal(calls.includes('send-token'), false);
});

test('RPC chain mismatch does not recover as a wallet chain mismatch', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture, {
    connect: async () => {
      throw new IssuanceClientError('rpc_chain_mismatch');
    },
  });
  let calls = 0;
  session.setProvider({
    request: async () => {
      calls++;
      throw new Error('No wallet recovery expected');
    },
  });
  await session.connect();
  assert.match(session.read().error, /configured RPC serves a different chain/);
  assert.equal(calls, 0);
  session.dispose();
});

test('wallet error code accessors are never invoked by network switching', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture);
  let getters = 0;
  session.setProvider({
    request: async () => {
      throw Object.defineProperty({}, 'code', {
        get() {
          getters++;
          throw new Error('Untrusted getter');
        },
      });
    },
  });
  await session.connect();
  await session.switchToTestnet();
  assert.equal(getters, 0);
  assert.match(session.read().error, /could not add or switch/);
  session.dispose();
});

function preparedFrom(fixture) {
  return {
    request: fixture.bundle.request,
    sourceId: fixture.deployment.auditPolicy.sourceId,
    signerFingerprint: fixture.deployment.auditPolicy.sourceSignerFingerprint,
    policyTermsHash: `0x${'01'.repeat(32)}`,
    rightsTermsHash: `0x${'02'.repeat(32)}`,
  };
}

test('document request approval is reused after proof acceptance without a second signing prompt', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  await session.connect();
  await session.prepareRequest(preparedFrom(fixture));
  assert.equal(session.read().bundle, undefined);
  assert.equal(session.read().sourceProof, 'unchecked');
  session.disclose(true);
  await session.signPreparedRequest();
  assert.equal(session.read().signature, fixture.holderSignature);
  assert.equal(session.read().sourceProof, 'unchecked');
  await session.submit();
  assert.ok(!calls.includes('submit'));
  await session.acceptPreparedBundle(fixture.bundle);
  assert.equal(session.read().signature, fixture.holderSignature);
  assert.equal(session.read().sourceProof, 'accepted');
  await session.simulate();
  await session.submit();
  assert.deepEqual(calls, [
    'prepare-request',
    'sign-request',
    'accept-prepared',
    'simulate',
    'submit',
  ]);
  assert.equal(session.read().transaction.hash, fixture.transactionHash);
});

test('prepared signing requires explicit disclosure and rejected proof never enables mint', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture, {
    acceptPreparedBundle: async () => {
      throw new IssuanceClientError('invalid_proof');
    },
  });
  await session.connect();
  await session.prepareRequest(preparedFrom(fixture));
  await session.signPreparedRequest();
  assert.ok(!calls.includes('sign-request'));
  session.disclose(true);
  await session.signPreparedRequest();
  await session.acceptPreparedBundle(fixture.bundle);
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().bundle, undefined);
  await session.submit();
  assert.ok(!calls.includes('submit'));
});

test('prepared bundle cannot replace the signed request with a different canonical digest', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  await session.connect();
  const prepared = preparedFrom(fixture);
  prepared.request = {
    ...prepared.request,
    nonce: String(BigInt(prepared.request.nonce) + 1n),
  };
  await session.prepareRequest(prepared);
  session.disclose(true);
  await session.signPreparedRequest();
  await session.acceptPreparedBundle(fixture.bundle);
  assert.ok(!calls.includes('accept-prepared'));
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().bundle, undefined);
  assert.match(session.read().error, /exact expected issuance/);
});

test('provider, wallet and deployment changes invalidate prepared document authorizations', async () => {
  for (const change of [
    'wallet',
    'provider',
    'deployment',
    'bundle',
    'clear',
  ]) {
    const fixture = await createFixture();
    const { session } = harness(fixture);
    await session.connect();
    await session.prepareRequest(preparedFrom(fixture));
    session.disclose(true);
    await session.signPreparedRequest();
    if (change === 'wallet') session.walletChanged();
    if (change === 'provider') session.setProvider({ request() {} });
    if (change === 'deployment')
      session.loadDeployment(JSON.stringify(fixture.deployment));
    if (change === 'bundle') session.loadBundle(JSON.stringify(fixture.bundle));
    if (change === 'clear') session.clearPreparedRequest();
    assert.equal(session.read().preparedRequest, undefined, change);
    assert.equal(session.read().signature, undefined, change);
    assert.equal(session.read().sourceProof, 'unchecked', change);
  }
});

test('late document authorization cannot survive a wallet account change', async () => {
  const fixture = await createFixture();
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session } = harness(fixture, { signRequest: () => pending });
  await session.connect();
  await session.prepareRequest(preparedFrom(fixture));
  session.disclose(true);
  const signing = session.signPreparedRequest();
  session.walletChanged();
  finish(fixture.holderSignature);
  await signing;
  assert.equal(session.read().preparedRequest, undefined);
  assert.equal(session.read().signature, undefined);
});

test('document replacement and bundle acceptance cannot erase an unresolved wallet submission', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture, {
    submit: async () => {
      throw new IssuanceClientError('transaction_uncertain');
    },
  });
  await ready(session);
  await session.submit();
  for (const replace of [
    () => session.prepareRequest(preparedFrom(fixture)),
    () => session.clearPreparedRequest(),
    () => session.acceptPreparedBundle(fixture.bundle),
  ])
    assert.throws(replace, /Reconcile/);
  assert.equal(session.read().unknownSubmission, 'issuance');
});

test('preparation reports a paused Gate without treating the document as proof accepted', async () => {
  const fixture = await createFixture();
  const { session } = harness(fixture, {
    prepareRequest: async (prepared) => ({ prepared, gatePaused: true }),
  });
  await session.connect();
  await session.prepareRequest(preparedFrom(fixture));
  assert.equal(session.read().preparedGatePaused, true);
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().bundle, undefined);
  session.walletChanged();
  assert.equal(session.read().preparedGatePaused, undefined);
});

test('restoring public approval after refresh preserves the exact signature without marking proof accepted', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  session.clearPreparedRequest();
  await session.connect();
  await session.restorePreparedRequest(
    preparedFrom(fixture),
    fixture.holderSignature,
  );
  assert.equal(session.read().signature, fixture.holderSignature);
  assert.equal(session.read().preparedGatePaused, true);
  assert.equal(session.read().disclosed, true);
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.deepEqual(calls, ['restore-request']);
  await session.acceptPreparedBundle(fixture.bundle);
  assert.equal(session.read().sourceProof, 'accepted');
  assert.deepEqual(calls, ['restore-request', 'accept-prepared']);
});

test('untrusted persisted approval and wallet changes cannot restore an accepted signature', async () => {
  const fixture = await createFixture();
  const rejected = harness(fixture, {
    restorePreparedRequest: async () => {
      throw new IssuanceClientError('invalid_signature');
    },
  });
  await rejected.session.connect();
  await rejected.session.restorePreparedRequest(
    preparedFrom(fixture),
    fixture.holderSignature,
  );
  assert.equal(rejected.session.read().signature, undefined);
  assert.equal(rejected.session.read().preparedRequest, undefined);
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const delayed = harness(fixture, { restorePreparedRequest: () => pending });
  await delayed.session.connect();
  const restoring = delayed.session.restorePreparedRequest(
    preparedFrom(fixture),
    fixture.holderSignature,
  );
  delayed.session.walletChanged();
  finish({
    prepared: preparedFrom(fixture),
    signature: fixture.holderSignature,
    gatePaused: false,
  });
  await restoring;
  assert.equal(delayed.session.read().signature, undefined);
  assert.equal(delayed.session.read().preparedRequest, undefined);
});

test('submitted bundle restoration confirms only the retained historical intent without new signing or proof acceptance', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture, {
    wait: async (bundle, signature, hash) => {
      calls.push('historical-wait');
      assert.deepEqual(bundle, fixture.bundle);
      assert.equal(signature, fixture.holderSignature.toLowerCase());
      assert.equal(hash, fixture.transactionHash);
      return fixture.receipt;
    },
  });
  await session.restoreIssuedBundle(
    fixture.bundle,
    fixture.holderSignature,
    fixture.transactionHash,
  );
  assert.equal(session.read().transaction.outcome, 'confirmed');
  assert.equal(session.read().receipt, fixture.receipt);
  assert.equal(session.read().sourceProof, 'unchecked');
  assert.equal(session.read().signature, undefined);
  assert.equal(session.read().simulation, 'unchecked');
  assert.deepEqual(calls, ['historical-wait']);
  await session.submit();
  assert.deepEqual(calls, ['historical-wait']);
});

test('a wrong restoration hash retains an unresolved intent and can recover without enabling another send', async () => {
  const fixture = await createFixture();
  const wrongHash = `0x${'98'.repeat(32)}`;
  const { session, calls } = harness(fixture, {
    wait: async (_bundle, _signature, hash) => {
      calls.push('historical-wait');
      if (hash === wrongHash)
        throw new IssuanceClientError('issuance_mismatch');
      return fixture.receipt;
    },
  });
  await session.restoreIssuedBundle(
    fixture.bundle,
    fixture.holderSignature,
    wrongHash,
  );
  assert.deepEqual(session.read().transaction, {
    hash: wrongHash,
    outcome: 'unresolved',
  });
  assert.equal(session.read().receipt, undefined);
  assert.throws(() => session.clearPreparedRequest(), /Reconcile/);
  await session.submit();
  assert.deepEqual(calls, ['historical-wait']);
  await session.recoverIssuanceHash(fixture.transactionHash);
  assert.equal(session.read().transaction.outcome, 'confirmed');
  assert.equal(session.read().transaction.hash, fixture.transactionHash);
  assert.equal(session.read().sourceProof, 'unchecked');
});

test('submitted restoration rejects malformed public inputs before a historical RPC call', async () => {
  const fixture = await createFixture();
  const { session, calls } = harness(fixture);
  for (const restore of [
    () =>
      session.restoreIssuedBundle(
        {
          ...fixture.bundle,
          request: { ...fixture.bundle.request, amount: '1' },
        },
        fixture.holderSignature,
        fixture.transactionHash,
      ),
    () =>
      session.restoreIssuedBundle(
        fixture.bundle,
        '0x01',
        fixture.transactionHash,
      ),
    () =>
      session.restoreIssuedBundle(
        fixture.bundle,
        fixture.holderSignature,
        '0x00',
      ),
  ])
    assert.throws(restore, IssuanceClientError);
  assert.deepEqual(calls, []);
  assert.equal(session.read().transaction, undefined);
});
