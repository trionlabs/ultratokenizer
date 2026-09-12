import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './helpers.mjs';

const { fetchHostedDeployment } = await loadModule(
  '../src/lib/application/hosted-deployment.ts',
);
const signal = () => new AbortController().signal;
const json = (body) =>
  new Response(body, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

test('hosted trust config uses one fixed same-origin URL without credentials, cache or redirects', async () => {
  const result = await fetchHostedDeployment(signal(), async (url, options) => {
    assert.equal(url, '/deployment.json');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return json('{"configuration":"parsed by the session"}');
  });
  assert.equal(result, '{"configuration":"parsed by the session"}');
});

test('missing operator configuration is distinct from an unavailable host', async () => {
  assert.equal(
    await fetchHostedDeployment(
      signal(),
      async () => new Response('', { status: 404 }),
    ),
    undefined,
  );
  await assert.rejects(
    fetchHostedDeployment(
      signal(),
      async () => new Response('', { status: 503 }),
    ),
  );
});

test('SPA HTML fallback and redirected responses are not configuration', async () => {
  await assert.rejects(
    fetchHostedDeployment(
      signal(),
      async () =>
        new Response('<html>fallback</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  const redirected = json('{}');
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(fetchHostedDeployment(signal(), async () => redirected));
});

test('stream bounds do not trust a missing or dishonest content length', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(33 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchHostedDeployment(
      signal(),
      async () =>
        new Response(body, {
          headers: {
            'content-type': 'application/json',
            'content-length': '2',
          },
        }),
    ),
    /too large/,
  );
  assert.equal(cancelled, true);
});

test('UTF-8 decoding is strict and preserves split multibyte characters', async () => {
  const bytes = new TextEncoder().encode('"€"');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    },
  });
  assert.equal(
    await fetchHostedDeployment(signal(), async () => json(body)),
    '"€"',
  );
  await assert.rejects(
    fetchHostedDeployment(signal(), async () => json(new Uint8Array([0xff]))),
  );
});

test('unmount or manual replacement aborts the hosted request', async () => {
  const controller = new AbortController();
  const request = fetchHostedDeployment(
    controller.signal,
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal.reason),
          { once: true },
        );
      }),
  );
  controller.abort();
  await assert.rejects(request);
});
