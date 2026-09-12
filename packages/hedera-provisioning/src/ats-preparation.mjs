import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  toHex,
  zeroAddress,
} from 'viem';
import { verifyBuild } from '../../../contracts/ats/scripts/verify-build.mjs';
import { planAtsGraph } from './ats-graph.mjs';
import { graphCreationData } from './ats-creation.mjs';

async function localEvm() {
  // No dev keys, inherited RPC settings, fork, or external signing provider.
  const process = spawn(
    'anvil',
    [
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--accounts',
      '0',
      '--chain-id',
      '296',
      '--hardfork',
      'cancun',
      '--gas-limit',
      '30000000',
      '--disable-default-create2-deployer',
      '--no-cors',
      '--color',
      'never',
    ],
    {
      env: { PATH: globalThis.process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let failed = false;
  process.on('error', () => {
    failed = true;
  });
  process.stderr.resume();
  process.stdout.on('data', (bytes) => {
    if (output.length < 16000) output += bytes.toString('utf8');
  });
  async function close() {
    if (process.exitCode === null && !failed) {
      const stopped = once(process, 'exit');
      process.kill('SIGTERM');
      await stopped;
    }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = output.match(/Listening on 127\.0\.0\.1:([0-9]+)/)?.[1];
    if (port && process.exitCode === null) {
      const transport = http(`http://127.0.0.1:${port}`, {
        retryCount: 0,
        timeout: 15000,
      });
      return {
        rpc: createPublicClient({ transport, pollingInterval: 10 }),
        wallet: createWalletClient({ transport }),
        close,
      };
    }
    if (failed || process.exitCode !== null) break;
    await setTimeout(50);
  }
  await close();
  throw Error('A fresh local Anvil process could not start.');
}

/** Execute exact constructors in a fresh local EVM using public identities only.
 * This measures linked runtimes/immutables, not Hedera fees or chain admission.
 */
export async function prepareAtsGraph({
  planInput,
  sender,
  governor,
  startNonce,
}) {
  sender = getAddress(sender);
  governor = getAddress(governor);
  assert.ok(
    sender !== zeroAddress && governor !== zeroAddress && sender !== governor,
  );
  assert.match(startNonce, /^(?:0|[1-9][0-9]{0,15})$/);
  assert.ok(BigInt(startNonce) + 16n <= BigInt(Number.MAX_SAFE_INTEGER));
  const inventory = await planAtsGraph(planInput);
  const { artifacts, manifestSha256 } = await verifyBuild(
    planInput.buildRoot ? { buildRoot: planInput.buildRoot } : undefined,
  );
  assert.equal(manifestSha256, inventory.manifestSha256);
  const local = await localEvm();
  try {
    const { rpc, wallet } = local;
    assert.equal(await rpc.getChainId(), 296);
    await rpc.request({
      method: 'anvil_setBalance',
      params: [sender, toHex(10n ** 25n)],
    });
    await rpc.request({
      method: 'anvil_setNonce',
      params: [sender, toHex(BigInt(startNonce))],
    });
    await rpc.request({ method: 'anvil_impersonateAccount', params: [sender] });
    const deployed = {};
    const creations = [];
    for (const step of inventory.topLevelCreations) {
      const artifact = artifacts[step.name];
      const nonce = BigInt(startNonce) + BigInt(step.index);
      const address = getContractAddress({ from: sender, nonce });
      const data = graphCreationData({
        name: step.name,
        artifacts,
        deployed,
        governor,
        facetOrder: inventory.profileConstructorFacetOrder,
        libraryOrder: inventory.profileConstructorLibraryOrder,
      });
      assert.equal((data.length - 2) / 2, step.creationInputBytes);
      assert.equal(await rpc.getCode({ address }), undefined);
      const hash = await wallet.sendTransaction({
        account: sender,
        chain: null,
        nonce: Number(nonce),
        data,
        gas: 30000000n,
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      assert.equal(
        receipt.status,
        'success',
        `${step.name} constructor failed locally.`,
      );
      assert.equal(getAddress(receipt.contractAddress), address);
      const runtime = await rpc.getCode({ address });
      assert.ok(runtime && runtime !== '0x');
      assert.equal(runtime.length, artifact.deployedBytecode.object.length);
      const value = {
        name: step.name,
        nonce: nonce.toString(),
        address,
        data,
        creationHash: keccak256(data),
        runtime,
        runtimeHash: keccak256(runtime),
        localGasUsed: receipt.gasUsed.toString(),
        transport:
          (data.length - 2) / 2 > 24 * 1024 ? 'hfs_required' : 'inline',
        maxFundingTinybar: step.maxFundingTinybar,
      };
      deployed[step.name] = value;
      creations.push(value);
    }
    const profile = deployed.AtsGateProfile.address;
    const children = [];
    for (const [
      index,
      name,
    ] of inventory.profileConstructorChildren.entries()) {
      const address = getContractAddress({
        from: profile,
        nonce: BigInt(index + 1),
      });
      const getter = {
        BusinessLogicResolver: 'resolver',
        AtsGateMintAdapter: 'adapter',
        ResolverProxy: 'token',
      }[name];
      assert.equal(
        await rpc.readContract({
          address: profile,
          abi: artifacts.AtsGateProfile.abi,
          functionName: getter,
        }),
        address,
      );
      const runtime = await rpc.getCode({ address });
      assert.ok(
        runtime &&
          runtime.length === artifacts[name].deployedBytecode.object.length,
      );
      children.push({
        name,
        address,
        runtime,
        runtimeHash: keccak256(runtime),
      });
    }
    assert.equal(
      await rpc.readContract({
        address: deployed.IssuanceGate.address,
        abi: artifacts.IssuanceGate.abi,
        functionName: 'governor',
      }),
      governor,
    );
    assert.equal(
      await rpc.readContract({
        address: deployed.IssuanceGate.address,
        abi: artifacts.IssuanceGate.abi,
        functionName: 'paused',
      }),
      true,
    );
    const plan = {
      format: 'ultratokenizer.ats-prepared-graph.v1',
      purpose: 'test',
      chainId: '296',
      manifestSha256,
      inventoryPlanSha256: inventory.planSha256,
      sender,
      governor,
      startNonce,
      creations,
      children,
      budget: inventory.budget,
      signed: false,
      chainGraphAdmitted: false,
      gasEvidence: 'local-evm-execution-only',
    };
    return {
      ...plan,
      planSha256: createHash('sha256')
        .update(JSON.stringify(plan))
        .digest('hex'),
    };
  } finally {
    await local.close();
  }
}
