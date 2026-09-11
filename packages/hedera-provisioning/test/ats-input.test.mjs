import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { bytesToHex, encodeDeployData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EthereumTransactionData, PrivateKey } from '@hiero-ledger/sdk';
import { verifyBuild } from '../../../contracts/ats/scripts/verify-build.mjs';
import { prepareHfsCreation } from '../src/creation.mjs';

const artifactRoot = process.env.ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS;
await test(
  'current ATS initializer and adapter creation bytes survive signed HFS hydration',
  {
    skip: artifactRoot
      ? false
      : 'Run check:ats:hfs after the pinned ATS build.',
  },
  async (t) => {
    const { artifacts } = await verifyBuild({
      buildRoot: resolve(artifactRoot),
    });
    const profile = artifacts.AtsGateProfile;
    assert.deepEqual(profile.bytecode.linkReferences, {});
    // Synthetic constructor addresses: this test checks actual artifact transport,
    // not deployment graph admission or contract execution (covered separately).
    const pins = Array.from({ length: 14 }, (_, index) => ({
      target: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      codeHash: keccak256(`0x${(index + 1).toString(16).padStart(2, '0')}`),
    }));
    const data = encodeDeployData({
      abi: profile.abi,
      bytecode: profile.bytecode.object,
      args: [
        pins[0].target,
        pins.slice(0, 10),
        pins.slice(10),
        artifacts.AtsGateMintAdapter.bytecode.object,
      ],
    });
    assert.equal((data.length - 2) / 2, 31759);
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
    const signed = await account.signTransaction({
      type: 'eip1559',
      chainId: 296,
      nonce: 0,
      data,
      gas: 15000000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 0n,
      value: 0n,
    });
    const plan = await prepareHfsCreation(signed, {
      purpose: 'test',
      chainId: '296',
      sender: account.address,
      nonce: '0',
      creationHash: keccak256(data),
      maxGas: '15000000',
      maxFeePerGasWei: '1000000000',
      maxTotalGasFeeWei: '15000000000000000',
    });
    const key = PrivateKey.fromStringECDSA('02'.repeat(32));
    const native = (step) => ({
      payer: '0.0.1001',
      node: '0.0.3',
      maxFeeTinybar: '200000000',
      transactionId: `0.0.1001@1789090000.${String(step + 1).padStart(9, '0')}`,
    });
    const chunks = [
      plan.createFile({
        ...native(0),
        publicKey: key.publicKey.toStringDer(),
        expiresAt: '1789176400',
      }).contents,
    ];
    for (let index = 1; index < plan.summary.fileChunks; index++) {
      chunks.push(plan.appendFile(index, '0.0.2001', native(index)).contents);
    }
    const stored = Buffer.concat(chunks);
    const create = plan.createContract('0.0.2001', stored, {
      ...native(plan.summary.fileChunks),
      maxGasAllowanceTinybar: '0',
    });
    const restored = EthereumTransactionData.fromBytes(create.ethereumData);
    assert.equal(restored.callData.length, 0);
    restored.callData = Buffer.from(stored.toString('ascii'), 'hex');
    assert.equal(bytesToHex(restored.toBytes()), signed);
    t.diagnostic(
      `Actual ATS input: ${plan.summary.creationBytes} bytes; HFS ASCII hex: ${plan.summary.fileBytes} bytes in ${plan.summary.fileChunks} chunks. Offline hydration only.`,
    );
  },
);
