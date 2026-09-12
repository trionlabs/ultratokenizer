import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { verifyBuild } from '../../../contracts/ats/scripts/verify-build.mjs';
import { planAtsGraph } from '../src/ats-graph.mjs';

const artifactRoot = process.env.ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS;

await test(
  'verified ATS graph orders every direct creation and bounds the aggregate reserve offline',
  { skip: artifactRoot ? false : 'Run after the pinned ATS build.' },
  async () => {
    const buildRoot = resolve(artifactRoot);
    const { manifestSha256 } = await verifyBuild({ buildRoot });
    const names = [
      'ClearingReadOps',
      'ScheduledTasksDispatchOps',
      'ScheduledTasksOps',
      'TokenCoreOps',
      'AccessControlFacet',
      'AllowanceFacet',
      'BalanceTrackerFacet',
      'CapFacet',
      'ControlListFacet',
      'CoreFacet',
      'InitializerFacet',
      'MintFacet',
      'PartitionsFacet',
      'TransferFacet',
      'IssuanceGate',
      'AtsGateProfile',
    ];
    const input = {
      buildRoot,
      expectedManifestSha256: manifestSha256,
      maxFundingTinybarByCreation: Object.fromEntries(
        names.map((name) => [name, '100000000']),
      ),
      totalBudgetTinybar: '1600000000',
    };
    const plan = await planAtsGraph(input);
    assert.equal(plan.topLevelCreations.length, 16);
    assert.equal(plan.topLevelCreations.at(-1).name, 'AtsGateProfile');
    assert.deepEqual(plan.profileConstructorChildren, [
      'BusinessLogicResolver',
      'AtsGateMintAdapter',
      'ResolverProxy',
    ]);
    assert.deepEqual(plan.profileConstructorFacetOrder, [
      'AccessControlFacet',
      'InitializerFacet',
      'CoreFacet',
      'CapFacet',
      'PartitionsFacet',
      'MintFacet',
      'TransferFacet',
      'BalanceTrackerFacet',
      'AllowanceFacet',
      'ControlListFacet',
    ]);
    assert.deepEqual(plan.profileConstructorLibraryOrder, [
      'TokenCoreOps',
      'ClearingReadOps',
      'ScheduledTasksOps',
      'ScheduledTasksDispatchOps',
    ]);
    assert.equal(plan.budget.reservedMaximum, '1600000000');
    assert.deepEqual(
      plan.topLevelCreations
        .filter((step) => step.transport === 'hfs_required')
        .map((step) => step.name),
      ['AtsGateProfile'],
    );
    for (const step of plan.topLevelCreations) {
      assert.ok(
        step.dependencies.every(
          (name) =>
            plan.topLevelCreations.findIndex(
              (candidate) => candidate.name === name,
            ) < step.index,
        ),
      );
    }
    assert.equal(plan.planSha256, (await planAtsGraph(input)).planSha256);
    await assert.rejects(
      planAtsGraph({ ...input, totalBudgetTinybar: '1599999999' }),
    );
    await assert.rejects(
      planAtsGraph({ ...input, expectedManifestSha256: '0'.repeat(64) }),
    );
    await assert.rejects(
      planAtsGraph({
        ...input,
        maxFundingTinybarByCreation: {
          ...input.maxFundingTinybarByCreation,
          GateStateOnlyVerifier: '1',
        },
      }),
    );
  },
);
