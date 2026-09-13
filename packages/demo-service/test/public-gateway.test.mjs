import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import worker, { handleGateway } from '../hosting/worker.mjs';
import { createPublicBridge } from '../hosting/bridge.mjs';
import { loadBridgeConfig } from '../hosting/config.mjs';
import { TOKEN_HEADER, MAX_PDF_BYTES } from '../hosting/policy.mjs';

const origin = 'https://demo.example.invalid';
const backend = 'https://backend.example.invalid';
const token = 'ab'.repeat(32); // Synthetic gateway credential, never a wallet key.
const job = '12'.repeat(32);
const env = {
  PUBLIC_ORIGIN: origin,
  DOCUMENT_SERVICE_ORIGIN: backend,
  DOCUMENT_GATEWAY_TOKEN: token,
  ASSETS: { fetch: async () => new Response('static') },
};
const bridgeOptions = {
  origin,
  token,
  port: 4176,
  upstreamPort: 4175,
  localOrigin: 'http://127.0.0.1:4173',
};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const request = (
  path,
  method = 'GET',
  body,
  type = 'application/json',
  headers = {},
) =>
  new Request(origin + path, {
    method,
    headers: { origin, 'content-type': type, ...headers },
    ...(body === undefined ? {} : { body }),
  });

async function invokeBridge(options, path, init = {}, extraHeaders = {}) {
  const server = createPublicBridge(options);
  const incoming = Readable.from(init.body ? [Buffer.from(init.body)] : []);
  Object.assign(incoming, {
    method: init.method ?? 'GET',
    url: path,
    headers: {
      host: '127.0.0.1:4176',
      ...Object.fromEntries(new Headers(init.headers)),
      ...extraHeaders,
    },
  });
  return new Promise((resolve, reject) => {
    let status;
    let headers;
    const outgoing = {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = nextHeaders;
      },
      end(body) {
        resolve(new Response(body, { status, headers }));
      },
    };
    Promise.resolve(server.listeners('request')[0](incoming, outgoing)).catch(
      reject,
    );
  });
}

await test('all supported routes cross both boundaries without changing signed bodies', async () => {
  const cases = [
    ['/api/health', 'GET'],
    ['/api/config', 'GET'],
    ['/api/documents', 'POST', '%PDF-1.7\n', 'application/pdf'],
    [
      '/api/jobs/prepare',
      'POST',
      '{"documentId":"synthetic","recipient":"holder"}',
    ],
    [
      `/api/jobs/${job}/start`,
      'POST',
      '{"holderSignature":"unchanged synthetic signature"}',
    ],
    [`/api/jobs/${job}`, 'GET'],
    [`/api/jobs/${job}/bundle`, 'GET'],
    [`/api/jobs/${job}/permit`, 'POST', '{"holderSignature":"same request"}'],
  ];
  for (const [path, method, body, type] of cases) {
    let reached = 0;
    const response = await handleGateway(
      request(path, method, body, type),
      env,
      (url, init) => {
        assert.equal(url, backend + path);
        assert.equal(init.headers.get(TOKEN_HEADER), token);
        return invokeBridge(
          {
            ...bridgeOptions,
            fetchImpl: async (localUrl, localInit) => {
              reached += 1;
              assert.equal(localUrl, 'http://127.0.0.1:4175' + path);
              assert.equal(
                localInit.headers.get('origin'),
                bridgeOptions.localOrigin,
              );
              assert.equal(localInit.headers.get(TOKEN_HEADER), null);
              assert.equal(localInit.method, method);
              assert.equal(
                localInit.body
                  ? new TextDecoder().decode(localInit.body)
                  : undefined,
                body,
              );
              return json({ accepted: true });
            },
          },
          path,
          init,
        );
      },
    );
    assert.equal(response.status, 200, path);
    assert.equal(reached, 1, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

await test('the gateway preserves service budget and holder-signature denials', async () => {
  for (const code of [
    'proof_budget_unavailable',
    'invalid_signature',
    'source_not_admitted',
  ]) {
    const response = await handleGateway(
      request(
        `/api/jobs/${job}/start`,
        'POST',
        '{"holderSignature":"invalid"}',
      ),
      env,
      async () =>
        json({ error: { code, message: 'Controlled service denial.' } }, 409),
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, code);
  }
});

await test('Cloudflare execution context is not used as an outbound fetch function', async () => {
  const response = await worker.fetch(request('/'), env, { waitUntil() {} });
  assert.equal(await response.text(), 'static');
});

await test('bridge bounds concurrent work without opening another upstream call', async () => {
  const pending = [];
  const server = createPublicBridge({
    ...bridgeOptions,
    fetchImpl: () => new Promise((resolve) => pending.push(resolve)),
  });
  const invoke = () => {
    const incoming = Readable.from([]);
    Object.assign(incoming, {
      method: 'GET',
      url: '/api/config',
      headers: {
        host: '127.0.0.1:4176',
        [TOKEN_HEADER]: token,
      },
    });
    return new Promise((resolve, reject) => {
      let status;
      Promise.resolve(
        server.listeners('request')[0](incoming, {
          writeHead(code) {
            status = code;
          },
          end() {
            resolve(status);
          },
        }),
      ).catch(reject);
    });
  };
  const active = Array.from({ length: 4 }, invoke);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4);
  assert.equal(await invoke(), 503);
  assert.equal(pending.length, 4);
  for (const resolve of pending) resolve(json({ ok: true }));
  assert.deepEqual(await Promise.all(active), [200, 200, 200, 200]);
  const next = invoke();
  await new Promise((resolve) => setImmediate(resolve));
  pending[4](json({ ok: true }));
  assert.equal(await next, 200);
});

await test('stalled upstream response ends with a bounded safe error', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const response = await invokeBridge(
      {
        ...bridgeOptions,
        timeoutMs: 20,
        fetchImpl: async () =>
          new Response(new ReadableStream({ start() {} }), {
            headers: { 'content-type': 'application/json' },
          }),
      },
      '/api/config',
      { headers: { [TOKEN_HEADER]: token } },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'service_unavailable');
  } finally {
    clearTimeout(keepAlive);
  }
});

await test('worker rejects cross-origin and unsupported API calls without contacting the bridge', async () => {
  const calls = [
    request('/api/config?file=secret'),
    request('/api/private'),
    request('/api/config', 'DELETE'),
    request('/api/documents', 'POST', 'pdf', 'application/pdf', {
      origin: 'https://other.invalid',
    }),
    request('/api/documents', 'POST', 'pdf', 'application/pdf', {
      'sec-fetch-site': 'cross-site',
    }),
    new Request(origin + '/api/documents', {
      method: 'POST',
      body: 'pdf',
      headers: { 'content-type': 'application/pdf' },
    }),
  ];
  for (const req of calls) {
    const response = await handleGateway(req, env, () =>
      assert.fail('must not reach backend'),
    );
    assert.ok(response.status >= 400);
  }
  assert.equal(await (await handleGateway(request('/'), env)).text(), 'static');
});

await test('bridge requires the gateway secret and exact loopback Host', async () => {
  for (const headers of [
    {},
    { [TOKEN_HEADER]: '00'.repeat(32) },
    { [TOKEN_HEADER]: token, host: 'attacker.invalid' },
    { [TOKEN_HEADER]: token + ', ' + token },
  ]) {
    const response = await invokeBridge(
      { ...bridgeOptions, fetchImpl: () => assert.fail('no upstream') },
      '/api/config',
      {},
      headers,
    );
    assert.equal(response.status, 403);
  }
});

await test('raw bridge paths cannot forward files, traversal, queries or other origins', async () => {
  for (const path of [
    '/.env',
    '/work/private.json',
    '/api/../api/config',
    '/api/%2e%2e/config',
    '/api/config?x=1',
    '//evil.invalid/api/config',
  ]) {
    const response = await invokeBridge(
      { ...bridgeOptions, fetchImpl: () => assert.fail('no upstream') },
      path,
      { headers: { [TOKEN_HEADER]: token } },
    );
    assert.ok(response.status >= 400, path);
  }
});

await test('request limits apply to streamed bytes and wrong media types', async () => {
  const calls = [
    request(
      '/api/documents',
      'POST',
      new Uint8Array(MAX_PDF_BYTES + 1),
      'application/pdf',
    ),
    request('/api/jobs/prepare', 'POST', 'x'.repeat(16 * 1024 + 1)),
    request('/api/documents', 'POST', 'email', 'message/rfc822'),
    request('/api/documents', 'POST', '', 'application/pdf'),
  ];
  for (const req of calls) {
    const response = await handleGateway(req, env, () =>
      assert.fail('must not forward'),
    );
    assert.ok(response.status >= 400);
  }
});

await test('browser credentials and spoofed gateway/Access headers never reach the origin', async () => {
  const response = await handleGateway(
    request('/api/config', 'GET', undefined, undefined, {
      cookie: 'browser cookie',
      authorization: 'browser auth',
      [TOKEN_HEADER]: 'spoof',
      'CF-Access-Client-Id': 'spoof',
      'CF-Access-Client-Secret': 'spoof',
    }),
    {
      ...env,
      ACCESS_CLIENT_ID: 'synthetic-id',
      ACCESS_CLIENT_SECRET: 'synthetic-secret',
    },
    async (_, init) => {
      assert.equal(init.headers.get('cookie'), null);
      assert.equal(init.headers.get('authorization'), null);
      assert.equal(init.headers.get(TOKEN_HEADER), token);
      assert.equal(init.headers.get('CF-Access-Client-Id'), 'synthetic-id');
      assert.equal(
        init.headers.get('CF-Access-Client-Secret'),
        'synthetic-secret',
      );
      return json({ ok: true }, 200, {
        'set-cookie': 'origin cookie',
        'x-private': 'private',
      });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-private'), null);
});

await test('invalid configuration, redirects and malformed upstream responses fail closed', async () => {
  for (const overrides of [
    { DOCUMENT_SERVICE_ORIGIN: origin },
    { DOCUMENT_SERVICE_ORIGIN: 'http://127.0.0.1:4175' },
    { DOCUMENT_SERVICE_ORIGIN: backend + '/other' },
    { DOCUMENT_GATEWAY_TOKEN: '' },
    { ACCESS_CLIENT_ID: 'id-only' },
  ]) {
    assert.equal(
      (
        await handleGateway(
          request('/api/config'),
          { ...env, ...overrides },
          () => assert.fail('no backend'),
        )
      ).status,
      503,
    );
  }
  for (const result of [
    new Response('', {
      status: 302,
      headers: { location: 'https://other.invalid/private' },
    }),
    new Response('private error text', { status: 500 }),
    new Response('not json', {
      headers: { 'content-type': 'application/json' },
    }),
    json({ data: 'x'.repeat(160 * 1024) }),
  ]) {
    const response = await handleGateway(
      request('/api/config'),
      env,
      async () => result,
    );
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private'));
  }
});

await test('private configuration binds service, deployment and a bounded document manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'public-gateway-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => {
    const bytes = JSON.stringify(value) + '\n';
    await writeFile(join(root, path), bytes, { mode: 0o600 });
    return createHash('sha256').update(bytes).digest('hex');
  };
  const deployment = { auditPolicy: { chainId: '296', policyVersion: '2' } };
  const manifest = { runs: Array.from({ length: 50 }, () => ({})) };
  const service = {
    format: 'ultratokenizer.demo-service.v1',
    origin: bridgeOptions.localOrigin,
    port: 4175,
    deploymentPath: 'deployment.json',
    manifestPath: 'manifest.json',
  };
  const config = {
    format: 'ultratokenizer.public-bridge.v1',
    publicOrigin: origin,
    port: 4176,
    serviceConfigPath: 'service.json',
    serviceConfigSha256: await write('service.json', service),
    deploymentSha256: await write('deployment.json', deployment),
    manifestSha256: await write('manifest.json', manifest),
    gatewayTokenPath: 'secret.json',
  };
  await write('secret.json', {
    format: 'ultratokenizer.gateway-secret.v1',
    token,
  });
  await write('bridge.json', config);
  assert.deepEqual(await loadBridgeConfig(root, 'bridge.json'), bridgeOptions);
  await write('service.json', { ...service, manifestPath: 'different.json' });
  await assert.rejects(loadBridgeConfig(root, 'bridge.json'));
  await write('service.json', service);
  await write('deployment.json', {
    auditPolicy: { chainId: '296', policyVersion: '1' },
  });
  await assert.rejects(loadBridgeConfig(root, 'bridge.json'));
  await write('deployment.json', deployment);
  await write('manifest.json', {
    runs: Array.from({ length: 51 }, () => ({})),
  });
  await assert.rejects(loadBridgeConfig(root, 'bridge.json'));
  await write('manifest.json', manifest);
  await chmod(join(root, 'secret.json'), 0o644);
  await assert.rejects(loadBridgeConfig(root, 'bridge.json'));
  await chmod(join(root, 'secret.json'), 0o600);
  await symlink(join(root, 'bridge.json'), join(root, 'link.json'));
  await assert.rejects(loadBridgeConfig(root, 'link.json'));
});
