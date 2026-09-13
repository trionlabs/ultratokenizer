import test from 'node:test';
import assert from 'node:assert/strict';
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
