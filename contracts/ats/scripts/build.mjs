import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adapterPinSource,
  artifactOf,
  compareText,
  defaultBuildRoot,
  json,
  mainSources,
  manifestFormat,
  packageRoot,
  readConfiguration,
  runtimeLinks,
  sha256,
  sourceInventory,
  testManifestFormat,
  verifyVendor,
} from './lib.mjs';

const config = await readConfiguration();
const lock = await verifyVendor();
const inputs = await sourceInventory();
const testInputs = await sourceInventory(undefined, { tests: true });

await mkdir(defaultBuildRoot, { recursive: true });
// Only this package's reproducible generated output is replaced. No historical work/ evidence is read or written.
for (const path of [
  'manifest.json',
  'test-manifest.json',
  'artifacts',
  'test-artifacts',
])
  await rm(join(defaultBuildRoot, path), { force: true, recursive: true });
await mkdir(join(defaultBuildRoot, 'artifacts'));
await mkdir(join(defaultBuildRoot, 'test-artifacts'));

const warnings = [];
async function compile(name, sources, targets) {
  const settings = { ...config.compilers[name].settings, outputSelection: {} };
  for (const target of targets) {
    settings.outputSelection[target.source] ??= {};
    settings.outputSelection[target.source][target.name] = [
      'abi',
      'metadata',
      'evm.bytecode',
      'evm.deployedBytecode',
      'evm.methodIdentifiers',
    ];
  }
  process.stdout.write(
    `Compiling ${name}: ${Object.keys(sources).length} source units, ${targets.length} selected artifacts, ${config.compilers[name].version}\n`,
  );
  const input = JSON.stringify({ language: 'Solidity', sources, settings });
  await writeFile(
    join(defaultBuildRoot, `${name}-${targets[0].name}.input.json`),
    input,
  );
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(packageRoot, 'scripts/compile.mjs'), name],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (bytes) => stdout.push(bytes));
    child.stderr.on('data', (bytes) => stderr.push(bytes));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString('utf8'))
        : reject(
            new Error(
              `Compiler ${name} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`,
            ),
          ),
    );
    child.stdin.end(input);
  });
  const output = JSON.parse(raw);
  const errors = (output.errors ?? []).filter(
    (entry) => entry.severity === 'error',
  );
  if (errors.length)
    throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  warnings.push(
    ...(output.errors ?? []).map((entry) => ({
      compiler: name,
      severity: entry.severity,
      code: entry.errorCode,
      message: entry.formattedMessage,
    })),
  );
  return Object.fromEntries(
    targets.map((target) => [
      target.name,
      artifactOf(
        output,
        target,
        config.compilers[name].version,
        config.compilers[name].settings,
      ),
    ]),
  );
}

const mainTargets = config.targets.filter(
  (target) => target.compiler === 'main',
);
const artifacts = await compile('main', await mainSources(), mainTargets);
const generatedPin = adapterPinSource(
  artifacts.AtsGateMintAdapter.bytecode.object,
);
const atsSources = Object.fromEntries(
  await Promise.all(
    lock.sources.map(async (entry) => [
      entry.path,
      { content: await readFile(join(packageRoot, entry.path), 'utf8') },
    ]),
  ),
);
atsSources['src/AtsGateProfile.sol'] = {
  content: await readFile(join(packageRoot, 'src/AtsGateProfile.sol'), 'utf8'),
};
atsSources['src/generated/AdapterArtifactPin.sol'] = { content: generatedPin };
Object.assign(
  artifacts,
  await compile(
    'ats',
    atsSources,
    config.targets.filter((target) => target.compiler === 'ats'),
  ),
);
const testArtifacts = await compile(
  'main',
  {
    'test/GateStateOnlyVerifier.sol': {
      content: await readFile(
        join(packageRoot, 'test/GateStateOnlyVerifier.sol'),
        'utf8',
      ),
    },
  },
  config.testTargets,
);

async function emit(values, directory) {
  const records = [];
  for (const [name, artifact] of Object.entries(values).sort(([a], [b]) =>
    compareText(a, b),
  )) {
    const path = `${directory}/${name}.json`;
    const bytes = json(artifact);
    await writeFile(join(defaultBuildRoot, path), bytes);
    const record = {
      name,
      artifact: path,
      sha256: sha256(bytes),
      compiler: artifact.compiler,
      source: artifact.source,
      creationBytes: (artifact.bytecode.object.length - 2) / 2,
      runtimeBytes: (artifact.deployedBytecode.object.length - 2) / 2,
    };
    records.push(record);
    process.stdout.write(
      `${name}: creation ${record.creationBytes} bytes, runtime ${record.runtimeBytes} bytes${directory === 'test-artifacts' ? ' [TEST ONLY]' : ''}\n`,
    );
  }
  return records;
}
const records = await emit(artifacts, 'artifacts');
const testRecords = await emit(testArtifacts, 'test-artifacts');
const manifest = {
  format: manifestFormat,
  scope: 'synthetic-provisioning',
  upstreamCommit: config.upstreamCommit,
  atsPackageVersion: config.atsPackageVersion,
  compilers: config.compilers,
  inputs,
  generatedAdapterPinSha256: sha256(generatedPin),
  artifacts: records,
  runtimeLinks: runtimeLinks(artifacts),
  limits: [
    'No default addresses, issuer keys, verifier registration, deployment or SP1 success.',
    'Artifact hashes are build integrity records, not deployed runtime hashes or self-authenticating review.',
    'Local Cancun compilation does not establish Hedera deployment size, gas or opcode compatibility.',
  ],
};
assert.equal(
  manifest.runtimeLinks.length,
  15,
  'Reviewed linked-library surface changed',
);
await writeFile(join(defaultBuildRoot, 'warnings.json'), json(warnings));
await writeFile(join(defaultBuildRoot, 'manifest.json'), json(manifest));
await writeFile(
  join(defaultBuildRoot, 'test-manifest.json'),
  json({
    format: testManifestFormat,
    scope: 'test-only-no-proof-acceptance',
    productionManifestSha256: sha256(json(manifest)),
    inputs: testInputs,
    artifacts: testRecords,
  }),
);
process.stdout.write(
  `Built ${records.length} provisioning artifacts and ${testRecords.length} separate test artifact; ${manifest.runtimeLinks.length} runtime links.\n`,
);
