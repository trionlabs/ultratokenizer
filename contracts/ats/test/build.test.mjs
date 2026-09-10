import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  defaultBuildRoot,
  nativeTarget,
  readConfiguration,
  repositoryRoot,
} from '../scripts/lib.mjs';
import { verifyBuild } from '../scripts/verify-build.mjs';

async function temporaryBuild(t) {
  const original = await verifyBuild();
  const repoRoot = await mkdtemp(join(tmpdir(), 'ultratokenizer-ats-build-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const buildRoot = join(repoRoot, 'contracts/ats/build');
  const paths = new Set(
    [...original.manifest.inputs, ...original.testManifest.inputs].map(
      (entry) => entry.path,
    ),
  );
  for (const path of paths) {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true });
    await cp(join(repositoryRoot, path), join(repoRoot, path));
  }
  await mkdir(buildRoot, { recursive: true });
  for (const path of [
    'manifest.json',
    'test-manifest.json',
    'artifacts',
    'test-artifacts',
  ])
    await cp(join(defaultBuildRoot, path), join(buildRoot, path), {
      recursive: true,
    });
  return { repoRoot, buildRoot, original };
}

await test('current normal-source build closes the production graph and separates the test verifier', async () => {
  const result = await verifyBuild();
  assert.equal(result.manifest.artifacts.length, 19);
  assert.equal(result.manifest.runtimeLinks.length, 15);
  assert.deepEqual(Object.keys(result.testArtifacts), [
    'GateStateOnlyVerifier',
  ]);
  assert.equal(result.artifacts.GateStateOnlyVerifier, undefined);
  assert.ok(
    result.manifest.inputs.some(
      (entry) => entry.path === 'contracts/src/IssuanceGate.sol',
    ),
  );
  assert.ok(
    result.manifest.inputs.some(
      (entry) => entry.path === 'contracts/src/AtsGateMintAdapter.sol',
    ),
  );
  assert.ok(
    result.manifest.inputs.every((entry) => !entry.path.startsWith('work/')),
  );
});

await test('changed upstream source is rejected before any artifact can be trusted', async (t) => {
  const fixture = await temporaryBuild(t);
  const entry = fixture.original.manifest.inputs.find(
    (entry) => entry.path.includes('/vendor/') && entry.path.endsWith('.sol'),
  );
  assert.ok(entry);
  await writeFile(
    join(fixture.repoRoot, entry.path),
    `${await readFile(join(fixture.repoRoot, entry.path), 'utf8')}\n// changed\n`,
  );
  await assert.rejects(verifyBuild(fixture), /Vendor source drift/);
});

await test('a missing transitive source or library artifact never falls back to cached success', async (t) => {
  for (const kind of ['source', 'artifact'])
    await t.test(kind, async (child) => {
      const fixture = await temporaryBuild(child);
      const path =
        kind === 'source'
          ? join(
              fixture.repoRoot,
              'contracts/ats/vendor/packages/ats/contracts/contracts/domain/orchestrator/ClearingReadOps.sol',
            )
          : join(fixture.buildRoot, 'artifacts/ClearingReadOps.json');
      await rm(path);
      await assert.rejects(verifyBuild(fixture), /inventory drift/);
    });
});

await test('changed current Gate source invalidates an older otherwise intact build', async (t) => {
  const fixture = await temporaryBuild(t);
  const path = join(fixture.repoRoot, 'contracts/src/IssuanceGate.sol');
  await writeFile(
    path,
    `${await readFile(path, 'utf8')}\n// fresh main source revision\n`,
  );
  await assert.rejects(verifyBuild(fixture), /input\/source drift/);
});

await test('artifact mutation and removed manifests are rejected', async (t) => {
  for (const kind of ['artifact', 'manifest'])
    await t.test(kind, async (child) => {
      const fixture = await temporaryBuild(child);
      if (kind === 'artifact') {
        const path = join(
          fixture.buildRoot,
          'artifacts/AtsGateMintAdapter.json',
        );
        await writeFile(path, `${await readFile(path, 'utf8')} `);
        await assert.rejects(verifyBuild(fixture), /Artifact drift/);
      } else {
        await rm(join(fixture.buildRoot, 'manifest.json'));
        await assert.rejects(verifyBuild(fixture), { code: 'ENOENT' });
      }
    });
});

await test('native compiler targets are explicit and reject unsupported platforms', async () => {
  const config = await readConfiguration();
  assert.equal(
    nativeTarget(config.compilers.ats, 'darwin', 'arm64').sha256,
    nativeTarget(config.compilers.ats, 'darwin', 'x64').sha256,
  );
  assert.equal(
    nativeTarget(config.compilers.ats, 'linux', 'x64').sha256,
    '9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25',
  );
  assert.throws(() => nativeTarget(config.compilers.ats, 'linux', 'arm64'));
  assert.throws(() => nativeTarget(config.compilers.ats, 'win32', 'x64'));
});
