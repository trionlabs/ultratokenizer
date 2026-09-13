import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localApiProxy, snapshotBuild } from '../scripts/preview-demo.mjs';

test('document API proxy is loopback-only and preserves browser origin', () => {
  assert.equal(localApiProxy(undefined), undefined);
  assert.deepEqual(localApiProxy('4175'), {
    '/api': { target: 'http://127.0.0.1:4175', changeOrigin: false },
  });
  for (const value of ['https://example.org', '80', '65536', '-1', '1.5', ''])
    assert.throws(() => localApiProxy(value), /api-port/);
});

test('preview snapshots survive replacement builds and refuse incomplete or linked builds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-demo-test-'));
  const source = join(directory, 'build');
  const scratch = join(directory, 'scratch');
  try {
    await mkdir(source);
    await assert.rejects(snapshotBuild(source, scratch), /index\.html/);
    await writeFile(
      join(source, 'index.html'),
      '<script src="old.js"></script>',
    );
    await writeFile(join(source, 'old.js'), 'window.ready = true;');
    const snapshot = await snapshotBuild(source, scratch);
    assert.equal((await lstat(snapshot)).mode & 0o777, 0o700);

    await rm(source, { recursive: true });
    await mkdir(source);
    await writeFile(
      join(source, 'index.html'),
      '<script src="new.js"></script>',
    );
    await writeFile(join(source, 'new.js'), 'window.ready = false;');
    assert.equal(
      await readFile(join(snapshot, 'index.html'), 'utf8'),
      '<script src="old.js"></script>',
    );
    assert.equal(
      await readFile(join(snapshot, 'old.js'), 'utf8'),
      'window.ready = true;',
    );
    assert.deepEqual((await readdir(snapshot)).sort(), [
      'index.html',
      'old.js',
    ]);

    await symlink(join(source, 'new.js'), join(source, 'linked.js'));
    await assert.rejects(snapshotBuild(source, scratch), /symlinks/);
    await rm(join(source, 'linked.js'));
    await symlink(snapshot, join(source, 'linked-directory'));
    await assert.rejects(snapshotBuild(source, scratch), /symlinks/);
    await symlink(source, join(directory, 'linked-build'));
    await assert.rejects(
      snapshotBuild(join(directory, 'linked-build'), scratch),
      /symlinks/,
    );
    assert.equal((await readdir(scratch)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
