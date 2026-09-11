import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PrivateKey,
  Transaction,
  EthereumTransactionData,
} from '@hiero-ledger/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, keccak256, recoverTransactionAddress } from 'viem';
import { prepareHfsCreation } from '../src/creation.mjs';

// Public synthetic test signers; never used for a funded account.
const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const nativeKey = PrivateKey.fromStringECDSA('02'.repeat(32));
const data = `0x${'60006000'.repeat(8000)}`;
const transaction = {
  type: 'eip1559',
  chainId: 296,
  nonce: 3,
  data,
  gas: 14_500_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 0n,
  value: 0n,
};
const policy = {
  purpose: 'test',
  chainId: '296',
  sender: account.address,
  nonce: '3',
  creationHash: keccak256(data),
  maxGas: '15000000',
  maxFeePerGasWei: '2000000000',
  maxTotalGasFeeWei: '30000000000000000',
};
const native = {
  payer: '0.0.1001',
  node: '0.0.3',
  transactionId: '0.0.1001@1789090000.000000001',
  maxFeeTinybar: '200000000',
};
const signed = await account.signTransaction(transaction);

await test('real SDK file chunks preserve the exact signed creation input and sender', async () => {
  const prepared = await prepareHfsCreation(signed, policy);
  assert.equal(prepared.summary.creationBytes, 32000);
  assert.equal(prepared.summary.fileBytes, 64000);
  const create = prepared.createFile({
    ...native,
    publicKey: nativeKey.publicKey.toStringDer(),
    expiresAt: '1789176400',
  });
  assert.ok(create.isFrozen());
  assert.equal(create.maxAttempts, 1);
  const contents = [create.contents];
  for (let index = 1; index < prepared.summary.fileChunks; index++) {
    const append = prepared.appendFile(index, '0.0.2001', {
      ...native,
      transactionId: `0.0.1001@1789090000.${String(index + 1).padStart(9, '0')}`,
    });
    assert.equal(append.getRequiredChunks(), 1);
    assert.equal(append.maxAttempts, 1);
    contents.push(append.contents);
  }
  const stored = Buffer.concat(contents);
  assert.equal(stored.toString('ascii'), data.slice(2));
  const execute = prepared.createContract('0.0.2001', stored, {
    ...native,
    maxGasAllowanceTinybar: '200000000',
  });
  assert.equal(execute.callDataFileId.toString(), '0.0.2001');
  const stripped = EthereumTransactionData.fromBytes(execute.ethereumData);
  assert.equal(stripped.callData.length, 0);
  stripped.callData = Buffer.from(stored.toString('ascii'), 'hex');
  const reconstructed = bytesToHex(stripped.toBytes());
  assert.equal(reconstructed, signed);
  assert.equal(
    await recoverTransactionAddress({ serializedTransaction: reconstructed }),
    account.address,
  );
  await execute.sign(nativeKey);
  const restored = Transaction.fromBytes(execute.toBytes());
  assert.equal(
    bytesToHex(restored.ethereumData),
    bytesToHex(execute.ethereumData),
  );
  assert.equal(restored.callDataFileId.toString(), '0.0.2001');
});

await test('rejects wrong source, sender, nonce, chain, value and fee envelope before preparing writes', async () => {
  for (const changes of [
    { chainId: 295 },
    { to: account.address },
    { nonce: 4 },
    { value: 1n },
    { gas: 15_000_001n },
    { maxFeePerGas: 2_000_000_001n },
    { data: `${data}00` },
  ]) {
    await assert.rejects(
      prepareHfsCreation(
        await account.signTransaction({ ...transaction, ...changes }),
        policy,
      ),
    );
  }
  await assert.rejects(
    prepareHfsCreation(signed, { ...policy, purpose: 'production' }),
  );
  await assert.rejects(
    prepareHfsCreation(signed, { ...policy, sender: `0x${'11'.repeat(20)}` }),
  );
  await assert.rejects(
    prepareHfsCreation(signed, { ...policy, maxTotalGasFeeWei: '1' }),
  );
});

await test('does not reconstruct with raw binary, incomplete, prefixed, changed or duplicated HFS contents', async () => {
  const prepared = await prepareHfsCreation(signed, policy);
  const expected = Buffer.from(data.slice(2), 'ascii');
  for (const bytes of [
    Buffer.from(data.slice(2), 'hex'),
    expected.subarray(1),
    Buffer.from(data),
    Buffer.concat([expected, expected]),
    Buffer.from('00' + data.slice(4)),
  ]) {
    assert.throws(() =>
      prepared.createContract('0.0.2001', bytes, {
        ...native,
        maxGasAllowanceTinybar: '200000000',
      }),
    );
  }
  assert.throws(() => prepared.appendFile(0, '0.0.2001', native));
  assert.throws(() =>
    prepared.appendFile(prepared.summary.fileChunks, '0.0.2001', native),
  );
  assert.throws(() =>
    prepared.createFile({
      ...native,
      payer: '0.0.1002',
      publicKey: nativeKey.publicKey.toStringDer(),
      expiresAt: '1789176400',
    }),
  );
});

await test('rejects mutable native inputs without invoking getters or accepting unsafe expiry', async () => {
  const prepared = await prepareHfsCreation(signed, policy);
  let reads = 0;
  const getter = {
    get() {
      reads += 1;
      return reads === 1 ? '1' : '-1';
    },
    enumerable: true,
  };
  const create = {
    ...native,
    publicKey: nativeKey.publicKey.toStringDer(),
    expiresAt: '1789176400',
  };
  Object.defineProperty(create, 'maxFeeTinybar', getter);
  assert.throws(() => prepared.createFile(create));
  const execute = { ...native, maxGasAllowanceTinybar: '0' };
  Object.defineProperty(execute, 'maxGasAllowanceTinybar', getter);
  assert.throws(() =>
    prepared.createContract(
      '0.0.2001',
      Buffer.from(data.slice(2), 'ascii'),
      execute,
    ),
  );
  assert.equal(reads, 0);
  assert.throws(() =>
    prepared.createFile({
      ...native,
      publicKey: nativeKey.publicKey.toStringDer(),
      expiresAt: '1',
    }),
  );
  assert.throws(() =>
    prepared.appendFile(1, '0.0.2001', { ...native, unused: true }),
  );
});
