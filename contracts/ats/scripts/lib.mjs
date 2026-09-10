import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sha3 from 'js-sha3';

export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const repositoryRoot = resolve(packageRoot, '../..');
export const defaultBuildRoot = join(packageRoot, 'build');
export const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');
export const keccak256 = (value) => `0x${sha3.keccak_256(value)}`;
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const readJson = async (path) =>
  JSON.parse(await readFile(path, 'utf8'));
export const artifactFormat = 'ultratokenizer.solidity-artifact.v1';
export const manifestFormat = 'ultratokenizer.ats-build.v1';
export const testManifestFormat = 'ultratokenizer.ats-test-build.v1';
export const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function nativeTarget(
  expected,
  platform = process.platform,
  arch = process.arch,
) {
  const key =
    platform === 'darwin' && (arch === 'x64' || arch === 'arm64')
      ? 'darwin-universal'
      : platform === 'linux' && arch === 'x64'
        ? 'linux-x64'
        : undefined;
  assert.ok(
    key && expected.platforms[key],
    'ATS native compiler supports Linux x64 and macOS x64/arm64 only.',
  );
  return expected.platforms[key];
}

export function safeRelative(path) {
  assert.equal(typeof path, 'string');
  assert.match(path, /^[a-zA-Z0-9_./-]+$/);
  assert.ok(
    !path.startsWith('/') &&
      path
        .split('/')
        .every((part) => part !== '..' && part !== '' && part !== '.'),
  );
  return path;
}

export async function filesUnder(directory) {
  const result = [];
  async function visit(path, prefix) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(
        !entry.isSymbolicLink(),
        `Unexpected symlink: ${prefix}${entry.name}`,
      );
      if (entry.isDirectory())
        await visit(join(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) result.push(`${prefix}${entry.name}`);
    }
  }
  await visit(directory, '');
  return result.sort(compareText);
}

export async function readConfiguration(repo = repositoryRoot) {
  const base = join(repo, 'contracts/ats');
  const config = await readJson(join(base, 'build-config.json'));
  assert.equal(config.format, 'ultratokenizer.ats-build-config.v1');
  assert.equal(
    config.upstreamCommit,
    'be4f860e408ec5b1a24d12feb6f872aabff69319',
  );
  assert.equal(config.targets.length, 19);
  assert.equal(new Set(config.targets.map((target) => target.name)).size, 19);
  assert.deepEqual(config.testTargets, [
    {
      name: 'GateStateOnlyVerifier',
      source: 'test/GateStateOnlyVerifier.sol',
      compiler: 'main',
    },
  ]);
  assert.ok(
    config.targets.every(
      (target) =>
        target.name !== 'GateStateOnlyVerifier' &&
        !target.source.startsWith('test/'),
    ),
  );
  const foundry = (await readFile(join(repo, 'contracts/foundry.toml'), 'utf8'))
    .split('[profile.default]')[1]
    .split('\n[')[0];
  for (const expression of [
    /solc_version\s*=\s*"0\.8\.30"/,
    /evm_version\s*=\s*"paris"/,
    /optimizer\s*=\s*true/,
    /optimizer_runs\s*=\s*200/,
    /via_ir\s*=\s*true/,
  ])
    assert.match(
      foundry,
      expression,
      'Main compiler settings require deliberate ATS build review.',
    );
  return config;
}

export async function verifyVendor(repo = repositoryRoot) {
  const base = join(repo, 'contracts/ats');
  const lock = await readJson(join(base, 'source-lock.json'));
  assert.equal(lock.format, 'ultratokenizer.ats-source-lock.v1');
  assert.equal(
    lock.upstream.commit,
    'be4f860e408ec5b1a24d12feb6f872aabff69319',
  );
  const entries = [...lock.sources, ...lock.licenses];
  assert.equal(
    new Set(entries.map((entry) => entry.path)).size,
    entries.length,
  );
  assert.deepEqual(
    (await filesUnder(join(base, 'vendor'))).map((path) => `vendor/${path}`),
    entries.map((entry) => entry.path).sort(compareText),
    'Vendor inventory drift',
  );
  for (const entry of entries) {
    assert.ok(safeRelative(entry.path).startsWith('vendor/'));
    const bytes = await readFile(join(base, entry.path));
    assert.equal(
      sha256(bytes),
      entry.sha256,
      `Vendor source drift: ${entry.path}`,
    );
    if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes);
  }
  return lock;
}

export async function mainSources(repo = repositoryRoot) {
  const sources = {};
  async function visit(source) {
    safeRelative(source);
    assert.ok(source.startsWith('src/'));
    if (sources[source]) return;
    const content = await readFile(join(repo, 'contracts', source), 'utf8');
    sources[source] = { content };
    for (const match of content.matchAll(
      /import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;/g,
    )) {
      assert.ok(
        match[1].startsWith('.'),
        'Main build accepts only actual local source imports.',
      );
      await visit(posix.normalize(posix.join(posix.dirname(source), match[1])));
    }
  }
  await visit('src/IssuanceGate.sol');
  await visit('src/AtsGateMintAdapter.sol');
  return Object.fromEntries(
    Object.entries(sources).sort(([a], [b]) => compareText(a, b)),
  );
}

export function adapterPinSource(creation) {
  assert.match(creation, /^0x[0-9a-fA-F]+$/);
  return `// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\n\nlibrary AdapterArtifactPin {\n    bytes32 internal constant CREATION_HASH = ${keccak256(Buffer.from(creation.slice(2), 'hex'))};\n}\n`;
}

export async function sourceInventory(
  repo = repositoryRoot,
  { tests = false } = {},
) {
  const base = join(repo, 'contracts/ats');
  const lock = await verifyVendor(repo);
  const main = await mainSources(repo);
  const paths = [
    'contracts/foundry.toml',
    ...Object.keys(main).map((path) => `contracts/${path}`),
    ...[
      'package.json',
      'package-lock.json',
      'build-config.json',
      'source-lock.json',
      'src/AtsGateProfile.sol',
    ].map((path) => `contracts/ats/${path}`),
    ...(await filesUnder(join(base, 'scripts'))).map(
      (path) => `contracts/ats/scripts/${path}`,
    ),
    ...[...lock.sources, ...lock.licenses].map(
      (entry) => `contracts/ats/${entry.path}`,
    ),
    ...(tests ? ['contracts/ats/test/GateStateOnlyVerifier.sol'] : []),
  ].sort(compareText);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: sha256(await readFile(join(repo, path))),
    })),
  );
}

export function compiler(packageName, expected) {
  const require = createRequire(join(packageRoot, 'package.json'));
  const solc = require(packageName);
  assert.equal(solc.version(), expected.version, 'Compiler version drift');
  return { solc, soljson: require.resolve(`${packageName}/soljson.js`) };
}

export function artifactOf(output, target, selectedCompiler, settings) {
  const compiled = output.contracts?.[target.source]?.[target.name];
  assert.ok(
    compiled?.evm?.bytecode?.object,
    `Missing compiler output: ${target.name}`,
  );
  return {
    format: artifactFormat,
    name: target.name,
    source: target.source,
    compiler: selectedCompiler,
    settings,
    abi: compiled.abi,
    metadata: JSON.parse(compiled.metadata),
    bytecode: {
      object: `0x${compiled.evm.bytecode.object}`,
      linkReferences: compiled.evm.bytecode.linkReferences,
    },
    deployedBytecode: {
      object: `0x${compiled.evm.deployedBytecode.object}`,
      linkReferences: compiled.evm.deployedBytecode.linkReferences,
      immutableReferences:
        compiled.evm.deployedBytecode.immutableReferences ?? {},
    },
    methodIdentifiers: compiled.evm.methodIdentifiers,
  };
}

export function runtimeLinks(artifacts) {
  const links = [];
  for (const [owner, artifact] of Object.entries(artifacts)) {
    for (const libraries of Object.values(
      artifact.deployedBytecode.linkReferences,
    )) {
      for (const [library, offsets] of Object.entries(libraries)) {
        assert.ok(
          artifacts[library],
          `Missing recursive library artifact: ${library}`,
        );
        for (const offset of offsets) {
          assert.equal(offset.length, 20);
          links.push({ owner, library, offset: offset.start });
        }
      }
    }
  }
  return links.sort(
    (a, b) => compareText(a.owner, b.owner) || a.offset - b.offset,
  );
}
