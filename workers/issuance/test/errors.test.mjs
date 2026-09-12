import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleModule } from './helpers.mjs';

void test('external JSON rejects duplicate decoded names and preserves byte and UTF-8 limits', async () => {
  const bundled = await bundleModule('../src/errors.ts');
  const { readJson } = bundled.module;
  try {
    for (const input of [
      '{"outer":{"id":1,"id":2}}',
      '{"id":1,"\\u0069d":2}',
    ]) {
      await assert.rejects(readJson(new Response(input), 128), {
        code: 'invalid_request',
      });
    }
    assert.deepEqual(
      await readJson(new Response('{"left":{"id":1},"right":{"id":2}}'), 128),
      {
        left: { id: 1 },
        right: { id: 2 },
      },
    );
    await assert.rejects(readJson(new Response(new Uint8Array([0xff])), 128), {
      code: 'invalid_request',
    });
    await assert.rejects(readJson(new Response('{"id":1}'), 4), {
      code: 'payload_too_large',
    });
  } finally {
    await bundled.cleanup();
  }
});
