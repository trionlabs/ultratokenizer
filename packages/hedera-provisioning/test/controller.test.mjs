import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileAppendTransaction,
  FileContentsQuery,
  FileCreateTransaction,
  EthereumTransaction,
  PrivateKey,
  Transaction,
  TransactionId,
} from '@hiero-ledger/sdk';
import { proto } from '@hiero-ledger/proto';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import {
  initializeHfsController,
  advanceHfsController,
} from '../src/controller.mjs';

// Real SDK/viem signing with public test keys; all consensus and query outcomes
// below are intercepted fixtures and do not demonstrate a live deployment.
const evm = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const key = PrivateKey.fromStringECDSA('02'.repeat(32));
const data = `0x${'60006000'.repeat(600)}`;
const signed = await evm.signTransaction({
  type: 'eip1559',
  chainId: 296,
  nonce: 3,
  data,
  gas: 100000n,
  maxFeePerGas: 1000000001n,
  maxPriorityFeePerGas: 0n,
  value: 0n,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ut-hfs-controller-'));
  return {
    journalPath: join(directory, 'fixture.hfs-controller.jsonl'),
    input: {
      deploymentId: '11'.repeat(32),
      signedTransaction: signed,
      creationPolicy: {
        purpose: 'test',
        chainId: '296',
        sender: evm.address,
        nonce: '3',
        creationHash: keccak256(data),
        maxGas: '100000',
        maxFeePerGasWei: '1000000001',
        maxTotalGasFeeWei: '100000000100000',
      },
      payer: '0.0.1001',
      node: '0.0.3',
      publicKey: key.publicKey.toStringDer(),
      fileLifetimeSeconds: '86400',
      fees: {
        fileCreateMaxFeeTinybar: '100000000',
        fileAppendMaxFeeTinybar: '200000000',
        readbackMaxFeeTinybar: '100000000',
        readbackPaymentTinybar: '50000',
        ethereumMaxFeeTinybar: '300000000',
        maxGasAllowanceTinybar: '400000000',
        totalBudgetTinybar: '1500000000',
      },
    },
  };
}
async function events(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
}
function idPath(id) {
  return id.replace('@', '-').replace(/\.([0-9]{9})$/, '-$1');
}
function network(t) {
  const observed = new Map();
  const state = {
    contents: null,
    nativeCalls: 0,
    queryCalls: 0,
    signatures: 0,
    lostNativeResponse: false,
    mirrorUnavailable: false,
    wrongContents: false,
    changedEntity: false,
    result: 'SUCCESS',
  };
  t.mock.method(Transaction.prototype, 'execute', async function (client) {
    assert.equal(client.ledgerId.toString(), 'testnet');
    assert.equal(client.isTransportSecurity(), true);
    assert.equal(client.operatorAccountId, null);
    assert.equal(this.maxAttempts, 1);
    assert.equal(key.publicKey.verifyTransaction(this), true);
    let name;
    let entityId;
    if (this instanceof FileCreateTransaction) {
      assert.equal(state.contents, null);
      state.contents = Buffer.from(this.contents);
      name = 'FILECREATE';
      entityId = '0.0.2001';
    } else if (this instanceof FileAppendTransaction) {
      assert.equal(this.fileId.toString(), '0.0.2001');
      state.contents = Buffer.concat([state.contents, this.contents]);
      name = 'FILEAPPEND';
      entityId = '0.0.2001';
    } else {
      assert.ok(
        this instanceof EthereumTransaction,
        'Query payment must never execute as a standalone transfer',
      );
      assert.equal(this.callDataFileId.toString(), '0.0.2001');
      assert.equal(state.contents.toString('ascii'), data.slice(2));
      name = 'ETHEREUMTRANSACTION';
      entityId = '0.0.3001';
    }
    state.nativeCalls += 1;
    const nativeHash = Buffer.from(await this.getTransactionHash());
    const nativeId = this.transactionId.toString();
    observed.set(idPath(nativeId), {
      transaction_id: idPath(nativeId),
      transaction_hash: nativeHash.toString('base64'),
      name,
      node: '0.0.3',
      nonce: 0,
      scheduled: false,
      consensus_timestamp: `${Math.floor(Date.now() / 1000)}.${String(state.nativeCalls).padStart(9, '0')}`,
      result: state.result,
      entity_id: state.result === 'SUCCESS' ? entityId : null,
    });
    if (state.lostNativeResponse) {
      state.lostNativeResponse = false;
      throw Error('Synthetic response lost after acceptance');
    }
    return {
      transactionId: this.transactionId,
      transactionHash: nativeHash,
      getReceipt: async () => ({ status: 'SUCCESS' }),
    };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(
      url.startsWith(
        'https://testnet.mirrornode.hedera.com/api/v1/transactions/',
      ),
    );
    assert.equal(options.redirect, 'error');
    const entry = observed.get(url.split('/').at(-1));
    return Response.json({
      transactions:
        state.mirrorUnavailable || !entry
          ? []
          : [
              {
                ...entry,
                ...(state.changedEntity ? { entity_id: '0.0.9999' } : {}),
              },
            ],
    });
  });
  t.mock.method(
    FileContentsQuery.prototype,
    'execute',
    async function (client) {
      state.queryCalls += 1;
      await this._beforeExecute(client);
      const request = await this._makeRequestAsync();
      const payment = Transaction.fromBytes(
        proto.Transaction.encode(
          request.fileGetContents.header.payment,
        ).finish(),
      );
      assert.equal(
        payment.transactionId.toString(),
        this.paymentTransactionId.toString(),
      );
      assert.equal(key.publicKey.verifyTransaction(payment), true);
      const contents = state.wrongContents
        ? Buffer.from(state.contents.toString('ascii'), 'hex')
        : state.contents;
      // Empty scalar header fields are legal protobuf defaults (OK/ANSWER_ONLY).
      return this._mapResponse(
        proto.Response.decode(
          proto.Response.encode({
            fileGetContents: {
              header: {},
              fileContents: { fileID: { fileNum: '2001' }, contents },
            },
          }).finish(),
        ),
      );
    },
  );
  state.signer = async (bytes) => {
    state.signatures += 1;
    return key.sign(bytes);
  };
  return state;
}

await test('recovered native failure retains its status and never authorizes another signature', async (t) => {
  const args = await fixture();
  const wire = network(t);
  wire.result = 'INSUFFICIENT_TX_FEE';
  wire.mirrorUnavailable = true;
  const initialized = await initializeHfsController(args);
  const input = {
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: wire.signer,
  };
  assert.equal((await advanceHfsController(input)).kind, 'unresolved');
  wire.mirrorUnavailable = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await advanceHfsController(input);
    assert.equal(result.kind, 'failed');
    assert.equal(result.status, 'INSUFFICIENT_TX_FEE');
    assert.equal(result.completedSteps, 0);
    assert.equal(result.fileId, null);
  }
  assert.equal(wire.signatures, 1);
  assert.equal(wire.nativeCalls, 1);
});

await test('durable controller completes ordered ASCII HFS creation with one reservation per operation and read-only completed recovery', async (t) => {
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  assert.equal(initialized.totalSteps, 5);
  assert.deepEqual(initialized.budget, {
    unit: 'tinybar',
    nativeMaximumFees: '900000000',
    readbackTransfer: '50000',
    senderGasMaximum: '10001',
    payerGasAllowance: '400000000',
    abortGasCushion: '100000000',
    maximumFundingEnvelope: '1400060001',
    totalLimit: '1500000000',
    settledCostKnown: false,
  });
  let result;
  const signer = async (bytes) => {
    const retained = await events(args.journalPath);
    assert.equal(
      retained.at(-1).body.kind,
      'attempt',
      'Aggregate admission must be durable before each signer',
    );
    return wire.signer(bytes);
  };
  for (let step = 0; step < initialized.totalSteps; step += 1) {
    result = await advanceHfsController({
      journalPath: args.journalPath,
      expectedPlanSha256: initialized.planSha256,
      signer,
    });
    assert.equal(
      result.kind,
      step === initialized.totalSteps - 1
        ? 'deployment_observed'
        : 'step_succeeded',
      JSON.stringify({ step, result }),
    );
    assert.equal(result.completedSteps, step + 1);
  }
  assert.equal(
    result.reservedMaximumTinybar,
    initialized.budget.maximumFundingEnvelope,
  );
  assert.equal(result.contractId, '0.0.3001');
  assert.equal(result.chainGraphAdmitted, false);
  assert.equal(wire.nativeCalls, 4);
  assert.equal(wire.queryCalls, 1);
  assert.equal(wire.signatures, 5);
  assert.equal(
    (
      await advanceHfsController({
        journalPath: args.journalPath,
        expectedPlanSha256: initialized.planSha256,
      })
    ).kind,
    'deployment_observed',
  );
  assert.equal(wire.nativeCalls, 4);
  assert.equal(wire.queryCalls, 1);
  assert.equal(wire.signatures, 5);
  const attempts = (await events(args.journalPath))
    .filter((entry) => entry.body.kind === 'attempt')
    .map((entry) => entry.body);
  assert.equal(new Set(attempts.map((entry) => entry.transactionId)).size, 5);
  assert.equal(new Set(attempts.map((entry) => entry.journalName)).size, 5);
  await assert.rejects(initializeHfsController(args));
});

await test('ambiguous native submission uses only exact original recovery without another reservation or signature', async (t) => {
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  const options = {
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: wire.signer,
  };
  assert.equal((await advanceHfsController(options)).kind, 'step_succeeded');
  wire.lostNativeResponse = true;
  const first = await advanceHfsController(options);
  assert.equal(first.kind, 'unresolved');
  assert.equal(first.reservedMaximumTinybar, '300000000');
  wire.mirrorUnavailable = true;
  assert.equal((await advanceHfsController(options)).kind, 'unresolved');
  wire.mirrorUnavailable = false;
  const recovered = await advanceHfsController({
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
  });
  assert.equal(recovered.kind, 'step_recovered');
  assert.equal(recovered.reservedMaximumTinybar, first.reservedMaximumTinybar);
  assert.equal(wire.nativeCalls, 2);
  assert.equal(wire.signatures, 2);
});

await test('crash before signing or after native success cannot allocate a replacement operation', async (t) => {
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  const originalGenerate = TransactionId.generate.bind(TransactionId);
  let generated = 0;
  t.mock.method(TransactionId, 'generate', function (...values) {
    generated += 1;
    return originalGenerate.apply(this, values);
  });
  assert.equal(
    (
      await advanceHfsController({
        journalPath: args.journalPath,
        expectedPlanSha256: initialized.planSha256,
        signer: async () => {
          throw Error('Signing device unavailable');
        },
      })
    ).kind,
    'unresolved',
  );
  const recovered = await advanceHfsController({
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: wire.signer,
  });
  assert.equal(recovered.kind, 'unresolved');
  assert.equal(recovered.reservedMaximumTinybar, '100000000');
  assert.equal(generated, 1);
  assert.equal(wire.nativeCalls, 0);
  assert.equal(wire.signatures, 0);

  const second = await fixture();
  const secondInitial = await initializeHfsController(second);
  const probe = await open(
    join(tmpdir(), `ut-controller-write-${process.pid}-${Date.now()}`),
    'wx',
    0o600,
  );
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.write;
  let dropped = false;
  const write = t.mock.method(
    prototype,
    'write',
    async function (buffer, offset, length) {
      const value = JSON.parse(buffer.toString('utf8'));
      if (!dropped && value.body?.kind === 'observed') {
        dropped = true;
        throw Error('Controller observation not persisted');
      }
      return originalWrite.call(this, buffer, offset, length);
    },
  );
  await assert.rejects(
    advanceHfsController({
      journalPath: second.journalPath,
      expectedPlanSha256: secondInitial.planSha256,
      signer: wire.signer,
    }),
  );
  write.mock.restore();
  const fixed = await advanceHfsController({
    journalPath: second.journalPath,
    expectedPlanSha256: secondInitial.planSha256,
  });
  assert.equal(fixed.kind, 'step_recovered');
  assert.equal(wire.nativeCalls, 1);
  assert.equal(wire.signatures, 1);
});

await test('budget, location, plan drift and changed prior entity fail before a later signing attempt', async (t) => {
  const insufficient = await fixture();
  insufficient.input.fees.totalBudgetTinybar = '1400060000';
  await assert.rejects(initializeHfsController(insufficient));
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  await assert.rejects(
    advanceHfsController({
      journalPath: args.journalPath,
      expectedPlanSha256: 'aa'.repeat(32),
      signer: wire.signer,
    }),
  );
  const copy = join(
    tmpdir(),
    `ut-controller-copy-${process.pid}-${Date.now()}.jsonl`,
  );
  await copyFile(args.journalPath, copy);
  await assert.rejects(
    advanceHfsController({
      journalPath: copy,
      expectedPlanSha256: initialized.planSha256,
      signer: wire.signer,
    }),
  );
  const options = {
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: wire.signer,
  };
  assert.equal((await advanceHfsController(options)).kind, 'step_succeeded');
  wire.changedEntity = true;
  await assert.rejects(advanceHfsController(options));
  assert.equal(wire.nativeCalls, 1);
  assert.equal(wire.signatures, 1);
  wire.changedEntity = false;
  const original = await readFile(args.journalPath, 'utf8');
  await writeFile(args.journalPath, original.slice(0, -1));
  await assert.rejects(advanceHfsController(options));
  assert.equal(wire.nativeCalls, 1);
});

await test('wrong paid readback contents stay unresolved and Ethereum submission is never attempted', async (t) => {
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  const options = {
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: wire.signer,
  };
  for (let step = 0; step < 3; step += 1) {
    const result = await advanceHfsController(options);
    assert.equal(
      result.kind,
      'step_succeeded',
      JSON.stringify({ step, result }),
    );
  }
  wire.wrongContents = true;
  const first = await advanceHfsController(options);
  assert.equal(first.kind, 'unresolved');
  assert.equal(first.reservedMaximumTinybar, '600050000');
  wire.wrongContents = false;
  assert.equal((await advanceHfsController(options)).kind, 'unresolved');
  assert.equal(wire.queryCalls, 1);
  assert.equal(wire.nativeCalls, 3);
  assert.equal(wire.signatures, 4);
});

await test('concurrent advances retain one step reservation and one signer invocation', async (t) => {
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: async (bytes) => {
      await wait;
      return wire.signer(bytes);
    },
  };
  const first = advanceHfsController(options);
  const second = advanceHfsController(options);
  release();
  const settled = await Promise.allSettled([first, second]);
  assert.equal(
    settled.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    settled.filter((value) => value.status === 'rejected').length,
    1,
  );
  assert.equal(wire.nativeCalls, 1);
  assert.equal(wire.signatures, 1);
  assert.equal(
    (await events(args.journalPath)).filter(
      (entry) => entry.body.kind === 'attempt',
    ).length,
    1,
  );
});

await test('saved paid readback survives a controller observation crash and does not pay for another query', async (t) => {
  const args = await fixture();
  const wire = network(t);
  const initialized = await initializeHfsController(args);
  const options = {
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
    signer: wire.signer,
  };
  for (let index = 0; index < 3; index += 1)
    assert.equal((await advanceHfsController(options)).kind, 'step_succeeded');
  const probe = await open(
    join(tmpdir(), `ut-controller-readback-write-${process.pid}-${Date.now()}`),
    'wx',
    0o600,
  );
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.write;
  const write = t.mock.method(
    prototype,
    'write',
    async function (buffer, offset, length) {
      const value = JSON.parse(buffer.toString('utf8'));
      if (value.body?.kind === 'observed' && value.body.step === 3)
        throw Error('Controller lost the completed readback observation');
      return originalWrite.call(this, buffer, offset, length);
    },
  );
  await assert.rejects(advanceHfsController(options));
  write.mock.restore();
  const recovered = await advanceHfsController({
    journalPath: args.journalPath,
    expectedPlanSha256: initialized.planSha256,
  });
  assert.equal(recovered.kind, 'step_recovered');
  assert.equal(recovered.reservedMaximumTinybar, '600050000');
  assert.equal(wire.queryCalls, 1);
  assert.equal(wire.signatures, 4);
  assert.equal(
    (await advanceHfsController(options)).kind,
    'deployment_observed',
  );
  assert.equal(wire.queryCalls, 1);
  assert.equal(wire.nativeCalls, 4);
  assert.equal(wire.signatures, 5);
});
