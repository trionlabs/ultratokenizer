import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyBuild } from '../../../contracts/ats/scripts/verify-build.mjs';

const LIBRARIES = [
  'ClearingReadOps',
  'ScheduledTasksDispatchOps',
  'ScheduledTasksOps',
  'TokenCoreOps',
];
const FACETS = [
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
];
const TOP_LEVEL = [...LIBRARIES, ...FACETS, 'IssuanceGate', 'AtsGateProfile'];
const CHILDREN = [
  'BusinessLogicResolver',
  'AtsGateMintAdapter',
  'ResolverProxy',
];
const PROFILE_FACETS = [
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
];
const PROFILE_LIBRARIES = [
  'TokenCoreOps',
  'ClearingReadOps',
  'ScheduledTasksOps',
  'ScheduledTasksDispatchOps',
];
const HEX_32 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function exactRecord(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  assert.ok(keys.every((key) => typeof key === 'string'));
  assert.deepEqual(keys.sort(compareText), [...names].sort(compareText));
  return Object.fromEntries(
    names.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      assert.ok('value' in descriptor);
      return [name, descriptor.value];
    }),
  );
}

function tinybar(value) {
  assert.ok(typeof value === 'string' && DECIMAL.test(value));
  const result = BigInt(value);
  assert.ok(result > 0n && result <= (1n << 63n) - 1n);
  return result;
}

function links(artifact) {
  const found = new Set();
  for (const code of [artifact.bytecode, artifact.deployedBytecode]) {
    for (const names of Object.values(code.linkReferences)) {
      for (const name of Object.keys(names)) found.add(name);
    }
  }
  return [...found].sort(compareText);
}

/** Offline inventory and aggregate ceiling, not signed creations or chain admission. */
export async function planAtsGraph({
  expectedManifestSha256,
  maxFundingTinybarByCreation,
  totalBudgetTinybar,
  buildRoot,
}) {
  assert.ok(
    typeof expectedManifestSha256 === 'string' &&
      HEX_32.test(expectedManifestSha256),
  );
  const verified = await verifyBuild(buildRoot ? { buildRoot } : undefined);
  assert.equal(verified.manifestSha256, expectedManifestSha256);
  const { artifacts, manifest } = verified;
  assert.deepEqual(
    Object.keys(artifacts).sort(compareText),
    [...TOP_LEVEL, ...CHILDREN].sort(compareText),
  );
  assert.deepEqual(
    [...PROFILE_FACETS].sort(compareText),
    [...FACETS].sort(compareText),
  );
  assert.deepEqual(
    [...PROFILE_LIBRARIES].sort(compareText),
    [...LIBRARIES].sort(compareText),
  );
  const limits = exactRecord(maxFundingTinybarByCreation, TOP_LEVEL);
  const budget = tinybar(totalBudgetTinybar);
  const amounts = Object.fromEntries(
    TOP_LEVEL.map((name) => [name, tinybar(limits[name])]),
  );
  const reserved = Object.values(amounts).reduce(
    (sum, amount) => sum + amount,
    0n,
  );
  assert.ok(
    reserved <= budget,
    'ATS graph funding ceilings exceed the total budget.',
  );

  const remaining = new Set(TOP_LEVEL);
  const steps = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter((name) => {
        const dependencies =
          name === 'AtsGateProfile'
            ? [...LIBRARIES, ...FACETS, 'IssuanceGate']
            : links(artifacts[name]);
        assert.ok(
          dependencies.every((dependency) => TOP_LEVEL.includes(dependency)),
        );
        return dependencies.every((dependency) => !remaining.has(dependency));
      })
      .sort((a, b) => TOP_LEVEL.indexOf(a) - TOP_LEVEL.indexOf(b));
    assert.ok(ready.length, 'ATS graph has a missing or cyclic dependency.');
    const name = ready[0];
    const artifact = artifacts[name];
    const record = manifest.artifacts.find((item) => item.name === name);
    assert.ok(record);
    const dependencies =
      name === 'AtsGateProfile'
        ? [...LIBRARIES, ...FACETS, 'IssuanceGate']
        : links(artifact);
    steps.push({
      index: steps.length,
      name,
      dependencies,
      artifactSha256: record.sha256,
      creationTemplateBytes: record.creationBytes,
      runtimeTemplateBytes: record.runtimeBytes,
      transport:
        record.creationBytes > 24 * 1024 ? 'hfs_required' : 'inline_candidate',
      maxFundingTinybar: amounts[name].toString(),
    });
    remaining.delete(name);
  }
  assert.equal(steps.length, 16);
  assert.equal(steps.at(-1).name, 'AtsGateProfile');
  assert.equal(
    steps.filter((step) => step.transport === 'hfs_required').length,
    1,
  );
  const plan = {
    format: 'ultratokenizer.ats-graph-offline.v1',
    chainId: '296',
    manifestSha256: verified.manifestSha256,
    topLevelCreations: steps,
    profileConstructorChildren: CHILDREN,
    profileConstructorFacetOrder: PROFILE_FACETS,
    profileConstructorLibraryOrder: PROFILE_LIBRARIES,
    budget: {
      unit: 'tinybar',
      reservedMaximum: reserved.toString(),
      totalLimit: budget.toString(),
      settledCostKnown: false,
    },
    signedCreationsPrepared: false,
    chainGraphAdmitted: false,
  };
  return { ...plan, planSha256: sha256(JSON.stringify(plan)) };
}
