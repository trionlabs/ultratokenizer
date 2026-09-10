import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  compiler,
  nativeTarget,
  packageRoot,
  readConfiguration,
  sha256,
} from './lib.mjs';

const name = process.argv[2];
assert.ok(name === 'main' || name === 'ats');
const config = await readConfiguration();
const expected = config.compilers[name];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (expected.kind === 'native') {
  const target = nativeTarget(expected);
  const binary = join(packageRoot, 'compilers', target.file);
  assert.equal(
    sha256(await readFile(binary)),
    target.sha256,
    'ATS compiler binary drift; run compiler:fetch if absent.',
  );
  assert.ok(
    execFileSync(binary, ['--version'], { encoding: 'utf8' }).includes(
      `Version: ${expected.version}.`,
    ),
  );
  const code = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--standard-json'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(Buffer.concat(chunks));
  });
  assert.equal(code, 0, 'Native ATS compiler failed.');
} else {
  const loaded = compiler(expected.package, expected);
  assert.equal(
    sha256(await readFile(loaded.soljson)),
    expected.soljsonSha256,
    'Compiler binary drift',
  );
  process.stdout.write(
    loaded.solc.compile(Buffer.concat(chunks).toString('utf8')),
  );
}
