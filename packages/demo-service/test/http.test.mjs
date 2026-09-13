import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiServer } from '../src/http.mjs';
import { ServiceError } from '../src/io.mjs';

const origin = 'http://127.0.0.1:4173';
// Exercise the actual HTTP handler without binding a port or invoking network APIs.
async function invoke(
  service,
  { method = 'GET', path = '/api/health', headers = {}, body = '' } = {},
) {
  const server = createApiServer(service, { origin, port: 4175 });
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(request, {
    method,
    url: path,
    headers: { host: '127.0.0.1:4173', ...headers },
  });
  return new Promise((resolve, reject) => {
    let status;
    let responseHeaders;
    const reply = {
      writeHead(code, values) {
        status = code;
        responseHeaders = values;
      },
      end(value) {
        resolve({ status, headers: responseHeaders, body: JSON.parse(value) });
      },
    };
    Promise.resolve(server.listeners('request')[0](request, reply)).catch(
      reject,
    );
  });
}
await test('health never queries RPC or exposes configuration', async () => {
  const result = await invoke({
    config() {
      throw new Error('must not call');
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: 'local-demo-service' });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
});
await test('cross-origin, missing POST origin and rebound hosts are rejected', async () => {
  for (const headers of [
    { host: 'attacker.invalid' },
    { origin: 'https://attacker.invalid' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal((await invoke({}, { headers })).status, 403);
  }
  assert.equal(
    (
      await invoke(
        {},
        {
          method: 'POST',
          path: '/api/documents',
          headers: { 'content-type': 'application/pdf' },
          body: '%PDF-1.7\n',
        },
      )
    ).status,
    403,
  );
});
await test('authenticated same-origin PDF POST reaches intake', async () => {
  const result = await invoke(
    {
      document(bytes) {
        return { count: bytes.length };
      },
    },
    {
      method: 'POST',
      path: '/api/documents',
      headers: { origin, 'content-type': 'application/pdf' },
      body: '%PDF-1.7\n',
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 9);
});
await test('invalid JSON, duplicate fields and over-limit bodies fail before prepare', async () => {
  for (const body of [
    '{broken',
    '{"recipient":"a","recipient":"b"}',
    'x'.repeat(16385),
  ]) {
    const result = await invoke(
      {
        prepare() {
          assert.fail('must not call');
        },
      },
      {
        method: 'POST',
        path: '/api/jobs/prepare',
        headers: { origin, 'content-type': 'application/json' },
        body,
      },
    );
    assert.ok([400, 413].includes(result.status));
  }
});
await test('wrong content type, query paths and unknown routes are rejected', async () => {
  assert.equal(
    (
      await invoke(
        {},
        {
          method: 'POST',
          path: '/api/documents',
          headers: { origin, 'content-type': 'message/rfc822' },
          body: 'email',
        },
      )
    ).status,
    415,
  );
  assert.equal(
    (await invoke({}, { path: '/api/config?path=secret' })).status,
    400,
  );
  assert.equal((await invoke({}, { path: '/.env' })).status, 404);
});
await test('only safe error vocabulary reaches browser responses', async () => {
  const error = new Error('sensitive provider payload');
  let result = await invoke(
    {
      config() {
        throw error;
      },
    },
    { path: '/api/config' },
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'service_unavailable');
  assert.ok(!JSON.stringify(result).includes('sensitive'));
  result = await invoke(
    {
      config() {
        throw new ServiceError('proof_provider_unresolved');
      },
    },
    { path: '/api/config' },
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'proof_provider_unresolved');
});
