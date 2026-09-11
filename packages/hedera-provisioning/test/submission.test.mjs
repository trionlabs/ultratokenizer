import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey, Transaction } from '@hiero-ledger/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { prepareHfsCreation } from '../src/creation.mjs';
import { submitHfsOnce, recoverHfsSubmission } from '../src/submission.mjs';

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const key = PrivateKey.fromStringECDSA('02'.repeat(32));
const data = '0x60006000';
const signed = await account.signTransaction({
  type: 'eip1559',
  chainId: 296,
  nonce: 3,
  data,
  gas: 100000n,
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 0n,
  value: 0n,
});
const builder = await prepareHfsCreation(signed, {
  purpose: 'test',
  chainId: '296',
  sender: account.address,
  nonce: '3',
  creationHash: keccak256(data),
  maxGas: '100000',
  maxFeePerGasWei: '1000000000',
  maxTotalGasFeeWei: '100000000000000',
});
const native = {
  payer: '0.0.1001',
  node: '0.0.3',
  transactionId: '0.0.1001@1789090000.000000001',
  maxFeeTinybar: '200000000',
};
async function input() {
  const directory = await mkdtemp(join(tmpdir(), 'ut-hfs-test-'));
  return {
    journalPath: join(directory, 'create.jsonl'),
    transaction: builder.createFile({
      ...native,
      publicKey: key.publicKey.toStringDer(),
      expiresAt: '1789176400',
    }),
    publicKey: key.publicKey.toStringDer(),
    signer: async (bytes) => key.sign(bytes),
  };
}
async function success(args, changes = {}) {
  const record = JSON.parse(
    (await readFile(args.journalPath, 'utf8')).split('\n')[0],
  );
  return Response.json({
    transactions: [
      {
        transaction_id: '0.0.1001-1789090000-000000001',
        transaction_hash: Buffer.from(record.nativeHash, 'hex').toString(
          'base64',
        ),
        name: 'FILECREATE',
        nonce: 0,
        scheduled: false,
        node: '0.0.3',
        consensus_timestamp: '1789090001.000000001',
        result: 'SUCCESS',
        entity_id: '0.0.2001',
        ...changes,
      },
    ],
  });
}

await test('persists exact signed native bytes before one dispatch and never signs or sends twice', async (t) => {
  const args = await input();
  const submit = t.mock.method(
    Transaction.prototype,
    'execute',
    async function (client) {
      assert.equal(client.ledgerId.toString(), 'testnet');
      assert.equal(client.isTransportSecurity(), true);
      assert.equal(client.operatorAccountId, null);
      assert.equal(this.maxAttempts, 1);
      const records = (await readFile(args.journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(records[1].kind, 'dispatch');
      assert.equal(
        records[0].signedBytes,
        Buffer.from(this.toBytes()).toString('base64'),
      );
      return {
        transactionId: this.transactionId,
        transactionHash: await this.getTransactionHash(),
      };
    },
  );
  const receipt = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(
      url,
      'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.1001-1789090000-000000001',
    );
    assert.equal(options.redirect, 'error');
    return success(args);
  });
  const first = await submitHfsOnce(args);
  assert.equal(first.status, 'SUCCESS');
  assert.equal(first.fileId, '0.0.2001');
  assert.equal((await stat(args.journalPath)).mode & 0o777, 0o600);
  let signedAgain = false;
  await assert.rejects(
    submitHfsOnce({
      ...args,
      signer: async () => {
        signedAgain = true;
        throw Error();
      },
    }),
  );
  assert.equal(signedAgain, false);
  assert.deepEqual(await recoverHfsSubmission(args.journalPath), first);
  assert.equal(submit.mock.callCount(), 1);
  assert.equal(receipt.mock.callCount(), 2);
});

await test('uncertain submission survives restart and recovery only queries the same recorded ID', async (t) => {
  const args = await input();
  const submit = t.mock.method(Transaction.prototype, 'execute', async () => {
    throw Error('transport lost');
  });
  const receipt = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(
      url,
      'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.1001-1789090000-000000001',
    );
    assert.equal(options.redirect, 'error');
    return success(args);
  });
  assert.equal((await submitHfsOnce(args)).kind, 'unresolved');
  assert.equal(receipt.mock.callCount(), 0);
  assert.equal(
    (await recoverHfsSubmission(args.journalPath)).status,
    'SUCCESS',
  );
  await assert.rejects(submitHfsOnce(args));
  assert.equal(submit.mock.callCount(), 1);
});

await test('unavailable receipt and malformed local recovery bytes never trigger a resubmission', async (t) => {
  const args = await input();
  const submit = t.mock.method(
    Transaction.prototype,
    'execute',
    async function () {
      return {
        transactionId: this.transactionId,
        transactionHash: await this.getTransactionHash(),
      };
    },
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('not found');
  });
  assert.equal((await submitHfsOnce(args)).kind, 'unresolved');
  assert.equal(
    (await recoverHfsSubmission(args.journalPath)).kind,
    'unresolved',
  );
  await writeFile(
    args.journalPath,
    (await readFile(args.journalPath, 'utf8')).slice(0, -1),
  );
  await assert.rejects(recoverHfsSubmission(args.journalPath));
  assert.equal(submit.mock.callCount(), 1);
});

await test('concurrent attempts and an invalid signer do not produce a second dispatch', async (t) => {
  const args = await input();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const submit = t.mock.method(
    Transaction.prototype,
    'execute',
    async function () {
      await wait;
      return {
        transactionId: this.transactionId,
        transactionHash: await this.getTransactionHash(),
      };
    },
  );
  t.mock.method(globalThis, 'fetch', async () => success(args));
  const first = submitHfsOnce(args);
  // The first operation can still be preparing; create_new lock permits one only.
  const second = submitHfsOnce(args);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(
    results.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  assert.equal(submit.mock.callCount(), 1);
  const invalid = await input();
  await assert.rejects(
    submitHfsOnce({ ...invalid, signer: async () => new Uint8Array(64) }),
  );
  assert.equal(submit.mock.callCount(), 1);
});

await test('matching ID with different signed body, child, scheduled, wrong operation or wrong node remains unresolved', async (t) => {
  const args = await input();
  t.mock.method(Transaction.prototype, 'execute', async () => {
    throw Error('transport lost');
  });
  assert.equal((await submitHfsOnce(args)).kind, 'unresolved');
  let mutation = {};
  t.mock.method(globalThis, 'fetch', async () => success(args, mutation));
  for (const changed of [
    { transaction_hash: Buffer.alloc(48).toString('base64') },
    { nonce: 1 },
    { scheduled: true },
    { name: 'FILEAPPEND' },
    { node: '0.0.4' },
    { entity_id: null },
    { transaction_id: '0.0.1001-1789090000-000000002' },
  ]) {
    mutation = changed;
    assert.equal(
      (await recoverHfsSubmission(args.journalPath)).kind,
      'unresolved',
    );
  }
});

await test('cached success cannot override fresh hash-bound mirror evidence', async (t) => {
  const args = await input();
  t.mock.method(Transaction.prototype, 'execute', async function () {
    return {
      transactionId: this.transactionId,
      transactionHash: await this.getTransactionHash(),
    };
  });
  let entity = '0.0.2001';
  t.mock.method(globalThis, 'fetch', async () =>
    success(args, { entity_id: entity }),
  );
  assert.equal((await submitHfsOnce(args)).fileId, entity);
  const records = (await readFile(args.journalPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  records[2].fileId = '0.0.9999';
  records[2].status = 'FORGED';
  await writeFile(
    args.journalPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  assert.equal((await recoverHfsSubmission(args.journalPath)).fileId, entity);
  entity = null;
  assert.equal(
    (await recoverHfsSubmission(args.journalPath)).kind,
    'unresolved',
  );
});

await test('signer cannot mutate the dispatched instance or increase retry attempts', async (t) => {
  const args = await input();
  const original = args.transaction;
  args.signer = async (bytes) => {
    original.setMaxAttempts(3);
    const signature = key.sign(bytes);
    bytes.fill(0);
    return signature;
  };
  t.mock.method(Transaction.prototype, 'execute', async function () {
    assert.notEqual(this, original);
    assert.equal(this.maxAttempts, 1);
    assert.equal(key.publicKey.verifyTransaction(this), true);
    return {
      transactionId: this.transactionId,
      transactionHash: await this.getTransactionHash(),
    };
  });
  t.mock.method(globalThis, 'fetch', async () => success(args));
  assert.equal((await submitHfsOnce(args)).status, 'SUCCESS');
});

await test('short journal writes are completed and zero progress aborts before dispatch', async (t) => {
  const args = await input();
  const probe = await open(
    join(tmpdir(), `ut-hfs-handle-${process.pid}-${Date.now()}`),
    'wx',
    0o600,
  );
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.write;
  let zero = false;
  t.mock.method(prototype, 'write', async function (buffer, offset, length) {
    if (zero) return { bytesWritten: 0, buffer };
    return originalWrite.call(this, buffer, offset, Math.min(length, 32));
  });
  const submit = t.mock.method(
    Transaction.prototype,
    'execute',
    async function () {
      const events = (await readFile(args.journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(
        events[0].signedBytes,
        Buffer.from(this.toBytes()).toString('base64'),
      );
      assert.equal(events[1].kind, 'dispatch');
      return {
        transactionId: this.transactionId,
        transactionHash: await this.getTransactionHash(),
      };
    },
  );
  t.mock.method(globalThis, 'fetch', async () => success(args));
  assert.equal((await submitHfsOnce(args)).status, 'SUCCESS');
  zero = true;
  await assert.rejects(submitHfsOnce(await input()));
  assert.equal(submit.mock.callCount(), 1);
});
