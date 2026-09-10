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
