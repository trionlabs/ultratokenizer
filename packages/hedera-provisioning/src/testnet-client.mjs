import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('@hiero-ledger/sdk/package.json');
const sdk = require(packagePath);
assert.equal(
  sdk.version,
  '2.88.0',
  'Review the SDK transport before changing its version.',
);
const entry = sdk.exports['.'].browser.import;
assert.equal(entry, './lib/browser.js');
// Select only the SDK's published browser entry. Global --conditions=browser
// also changes unrelated Node dependencies (including ethers/ws).
const { Client } = await import(
  pathToFileURL(resolve(dirname(packagePath), entry))
);

export function testnetClient() {
  return Client.forTestnet({ scheduleNetworkUpdate: false })
    .setTransportSecurity(true)
    .setMaxAttempts(1)
    .setRequestTimeout(15000);
}
