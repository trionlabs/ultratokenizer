import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runJson, stopSubprocesses } from '../src/io.mjs';

await test('bounded child commands return structured output without inheriting arbitrary environment', async () => {
  process.env.ULTRATOKENIZER_TEST_SECRET = 'test-only';
  try {
    const value = await runJson(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({ inherited: process.env.ULTRATOKENIZER_TEST_SECRET !== undefined }))',
    ]);
    assert.deepEqual(value, { inherited: false });
  } finally {
    delete process.env.ULTRATOKENIZER_TEST_SECRET;
  }
});

await test('service shutdown terminates a pending native or requester child', async () => {
  const pending = runJson(process.execPath, [
    '-e',
    'setInterval(() => {}, 10000)',
  ]);
  const stopped = assert.rejects(pending, { code: 'preparation_failed' });
  stopSubprocesses();
  await stopped;
});

await test('only recognized unsigned observation transport errors are retryable', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'ut-observation-child-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const binary = join(folder, 'requester');
  const failWith = (message) =>
    writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '${message}' >&2\nexit 1\n`, {
      mode: 0o700,
    });
  await failWith('Recovered request status is unavailable; do not resubmit.');
  await assert.rejects(
    runJson(binary, ['recover-request'], { observation: true }),
    { code: 'proof_observation_unavailable' },
  );
  await assert.rejects(
    runJson(binary, ['submit-request'], { observation: true }),
    { code: 'preparation_failed' },
  );
  await failWith(
    'Recovered status does not bind the exact request or expected public values.',
  );
  await assert.rejects(
    runJson(binary, ['recover-request'], { observation: true }),
    { code: 'preparation_failed' },
  );
  await writeFile(binary, '#!/bin/sh\nprintf broken-json\n', { mode: 0o700 });
  await assert.rejects(
    runJson(binary, ['recover-request'], { observation: true }),
    { code: 'preparation_failed' },
  );
});
