import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { decodeAbiParameters, getContractAddress, keccak256 } from 'viem';
import { verifyBuild } from '../../../contracts/ats/scripts/verify-build.mjs';
import { prepareAtsGraph } from '../src/ats-preparation.mjs';

const artifactRoot = process.env.ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS;
await test(
  'exact ATS graph materializes linked constructors and child runtimes without keys or test verifiers',
  {
    skip: artifactRoot
      ? false
      : 'Run check:ats:hfs after the pinned ATS build.',
  },
  async () => {
    const buildRoot = resolve(artifactRoot);
    const { manifestSha256, artifacts } = await verifyBuild({ buildRoot });
    const children = new Set([
      'BusinessLogicResolver',
      'AtsGateMintAdapter',
      'ResolverProxy',
    ]);
    const sender = '0x0000000000000000000000000000000000001234';
    const governor = '0x0000000000000000000000000000000000005678';
    const input = {
      planInput: {
        buildRoot,
        expectedManifestSha256: manifestSha256,
        maxFundingTinybarByCreation: Object.fromEntries(
          Object.keys(artifacts)
            .filter((name) => !children.has(name))
            .map((name) => [name, '200000000']),
        ),
        totalBudgetTinybar: '3200000000',
      },
      sender,
      governor,
      startNonce: '7',
    };
    const plan = await prepareAtsGraph(input);
    assert.equal(plan.creations.length, 16);
    assert.equal(plan.children.length, 3);
    assert.equal(plan.signed, false);
    assert.equal(plan.chainGraphAdmitted, false);
    assert.equal(plan.gasEvidence, 'local-evm-execution-only');
    const byName = Object.fromEntries(
      plan.creations.map((value) => [value.name, value]),
    );
    for (const [index, creation] of plan.creations.entries()) {
      assert.equal(
        creation.address,
        getContractAddress({ from: sender, nonce: 7n + BigInt(index) }),
      );
      assert.equal(keccak256(creation.data), creation.creationHash);
      assert.equal(keccak256(creation.runtime), creation.runtimeHash);
      assert.ok(BigInt(creation.localGasUsed) > 0n);
      for (const libraries of Object.values(
        artifacts[creation.name].deployedBytecode.linkReferences,
      )) {
        for (const [name, offsets] of Object.entries(libraries)) {
          for (const offset of offsets)
            assert.equal(
              creation.runtime
                .slice(2 + offset.start * 2, 2 + (offset.start + 20) * 2)
                .toLowerCase(),
              byName[name].address.slice(2).toLowerCase(),
            );
        }
      }
    }
    for (const name of [
      'ClearingReadOps',
      'ScheduledTasksDispatchOps',
      'ScheduledTasksOps',
      'TokenCoreOps',
    ]) {
      assert.equal(byName[name].runtime.slice(2, 4), '73');
      assert.equal(
        byName[name].runtime.slice(4, 44).toLowerCase(),
        byName[name].address.slice(2).toLowerCase(),
      );
    }
    const gate = byName.IssuanceGate;
    const args = `0x${gate.data.slice(artifacts.IssuanceGate.bytecode.object.length)}`;
    assert.deepEqual(decodeAbiParameters([{ type: 'address' }], args), [
      governor,
    ]);
    for (const locations of Object.values(
      artifacts.IssuanceGate.deployedBytecode.immutableReferences,
    )) {
      for (const offset of locations)
        assert.equal(
          gate.runtime
            .slice(2 + offset.start * 2, 2 + (offset.start + 32) * 2)
            .toLowerCase(),
          governor.slice(2).toLowerCase().padStart(64, '0'),
        );
    }
    assert.deepEqual(
      plan.creations
        .filter((value) => value.transport === 'hfs_required')
        .map((value) => value.name),
      ['AtsGateProfile'],
    );
    assert.equal((byName.AtsGateProfile.data.length - 2) / 2, 31759);
    assert.ok(BigInt(byName.AtsGateProfile.localGasUsed) < 16000000n);
    assert.deepEqual(await prepareAtsGraph(input), plan);
    await assert.rejects(prepareAtsGraph({ ...input, governor: sender }));
    await assert.rejects(
      prepareAtsGraph({ ...input, startNonce: '9007199254740991' }),
    );
  },
);
