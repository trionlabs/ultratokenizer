import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrowserRpcUrl, BrowserRpcError } from '../src/lib/browser-rpc.ts';
import { loadModule } from './helpers.mjs';
const { resolveEnsRecipient } = await loadModule('../src/lib/issuance.ts');
const { rpcUrl } = await loadModule('../../../packages/issuance/src/schema.ts');

test('browser RPC admission matches HTTPS and supported HTTP loopback CSP sources', () => {
  for (const value of [
    'https://rpc.example.invalid/',
    'https://[::1]:8545/',
    'http://localhost:8545/',
    'http://127.0.0.1:8545/',
  ]) {
    assert.equal(parseBrowserRpcUrl(value), value);
  }
  for (const value of [
    'http://[::1]:8545/',
    'http://[0:0:0:0:0:0:0:1]:8545/',
    'http://remote.invalid/',
    'https://user:password@rpc.invalid/',
    'https://rpc.invalid/#fragment',
    '',
    null,
    {},
  ]) {
    assert.throws(() => parseBrowserRpcUrl(value), BrowserRpcError);
  }
});

test('shared Node RPC admission retains HTTP IPv6 support', () => {
  assert.equal(rpcUrl('http://[::1]:8545/'), 'http://[::1]:8545/');
});

test('browser ENS wrapper rejects unsupported HTTP IPv6 before any fetch', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected network');
  };
  try {
    await assert.rejects(
      resolveEnsRecipient({
        name: 'alice.eth',
        chainId: '296',
        ethereumRpcUrl: 'http://[::1]:8545/',
      }),
      /Use HTTPS, or HTTP at localhost or 127\.0\.0\.1\./,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previous;
  }
});
