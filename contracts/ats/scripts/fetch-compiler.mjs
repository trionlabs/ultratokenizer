import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  nativeTarget,
  packageRoot,
  readConfiguration,
  sha256,
} from './lib.mjs';

const config = await readConfiguration();
const target = nativeTarget(config.compilers.ats);
const directory = join(packageRoot, 'compilers');
const path = join(directory, target.file);
await mkdir(directory, { recursive: true });
try {
  const current = await readFile(path);
  assert.equal(
    sha256(current),
    target.sha256,
    'Existing compiler hash mismatch; remove this generated cache file deliberately.',
  );
  process.stdout.write(`Pinned ATS compiler already present: ${target.file}\n`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(target.url, {
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `Compiler download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    sha256(bytes),
    target.sha256,
    'Downloaded compiler checksum mismatch.',
  );
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  process.stdout.write(
    `Fetched pinned ATS compiler: ${target.file}, ${bytes.length} bytes, SHA-256 ${target.sha256}\n`,
  );
}
