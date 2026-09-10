import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  adapterPinSource,
  artifactFormat,
  compareText,
  defaultBuildRoot,
  filesUnder,
  keccak256,
  manifestFormat,
  readConfiguration,
  readJson,
  repositoryRoot,
  runtimeLinks,
  safeRelative,
  sha256,
  sourceInventory,
  testManifestFormat,
} from './lib.mjs';

/** Local build-integrity check. A fresh trusted compiler build/review, not this
 * manifest's self-reported hashes alone, authenticates source-to-bytecode provenance.
 */
export async function verifyBuild({
  repoRoot = repositoryRoot,
  buildRoot = defaultBuildRoot,
} = {}) {
  const config = await readConfiguration(repoRoot);
  const manifestBytes = await readFile(join(buildRoot, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.format, manifestFormat);
  assert.equal(manifest.scope, 'synthetic-provisioning');
  assert.equal(manifest.upstreamCommit, config.upstreamCommit);
  assert.equal(manifest.atsPackageVersion, config.atsPackageVersion);
  assert.deepEqual(manifest.compilers, config.compilers);
  assert.deepEqual(
    manifest.inputs,
    await sourceInventory(repoRoot),
    'Build input/source drift; rebuild from reviewed sources.',
  );
  const testManifest = await readJson(join(buildRoot, 'test-manifest.json'));
  assert.equal(testManifest.format, testManifestFormat);
  assert.equal(testManifest.scope, 'test-only-no-proof-acceptance');
  assert.equal(testManifest.productionManifestSha256, sha256(manifestBytes));
  assert.deepEqual(
    testManifest.inputs,
    await sourceInventory(repoRoot, { tests: true }),
  );

  async function artifactsFor(records, targets, directory) {
    assert.equal(
      new Set(records.map((record) => record.name)).size,
      targets.length,
    );
    assert.equal(records.length, targets.length);
    assert.deepEqual(
      records.map((record) => record.name).sort(compareText),
      targets.map((target) => target.name).sort(compareText),
    );
    assert.deepEqual(
      await filesUnder(join(buildRoot, directory)),
      records.map((record) => `${record.name}.json`).sort(compareText),
      'Artifact inventory drift',
    );
    const result = {};
    for (const record of records) {
      assert.equal(
        safeRelative(record.artifact),
        `${directory}/${record.name}.json`,
      );
      const bytes = await readFile(join(buildRoot, record.artifact));
      assert.equal(
        sha256(bytes),
        record.sha256,
        `Artifact drift: ${record.name}`,
      );
      const artifact = JSON.parse(bytes.toString('utf8'));
      const target = targets.find((target) => target.name === record.name);
      assert.equal(artifact.format, artifactFormat);
      assert.equal(artifact.name, target.name);
      assert.equal(artifact.source, target.source);
      assert.equal(
        artifact.compiler,
        config.compilers[target.compiler].version,
      );
      assert.deepEqual(
        artifact.settings,
        config.compilers[target.compiler].settings,
      );
      assert.equal(
        record.creationBytes,
        (artifact.bytecode.object.length - 2) / 2,
      );
      assert.equal(
        record.runtimeBytes,
        (artifact.deployedBytecode.object.length - 2) / 2,
      );
      result[record.name] = artifact;
    }
    return result;
  }
  const artifacts = await artifactsFor(
    manifest.artifacts,
    config.targets,
    'artifacts',
  );
  const testArtifacts = await artifactsFor(
    testManifest.artifacts,
    config.testTargets,
    'test-artifacts',
  );
  assert.deepEqual(manifest.runtimeLinks, runtimeLinks(artifacts));
  assert.equal(manifest.runtimeLinks.length, 15);
  const pin = adapterPinSource(artifacts.AtsGateMintAdapter.bytecode.object);
  assert.equal(manifest.generatedAdapterPinSha256, sha256(pin));
  assert.equal(
    artifacts.AtsGateProfile.metadata.sources[
      'src/generated/AdapterArtifactPin.sol'
    ].keccak256,
    keccak256(pin),
  );
  for (const artifact of Object.values(artifacts)) {
    assert.ok(
      !Object.keys(artifact.metadata.sources).some(
        (source) => source === 'test/GateStateOnlyVerifier.sol',
      ),
    );
  }
  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    artifacts,
    testManifest,
    testArtifacts,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await verifyBuild();
  process.stdout.write(
    `Verified ${result.manifest.artifacts.length} provisioning artifacts, ${result.testManifest.artifacts.length} test-only artifact and ${result.manifest.runtimeLinks.length} links against current sources.\n`,
  );
}
