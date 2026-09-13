// Production UI and clients with intercepted synthetic RPC. No real signing or broadcast.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toHex,
} from 'viem';
import { loadModule, dropFiles } from './helpers.mjs';

const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:4173/');
assert.equal(base.protocol, 'http:');
assert(['localhost', '127.0.0.1'].includes(base.hostname));
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const { GOVERNOR_ABI } = await loadModule(
  '../src/lib/application/institution-client.ts',
);
const { IDENTITY_ABI } = await loadModule(
  '../src/lib/application/discovery.ts',
);
const { ISSUANCE_GATE_ABI } = await loadModule(
  '../../../packages/issuance/src/abi.ts',
);
const fixture = await createFixture();
const policy = fixture.policy;
const abi = [...GOVERNOR_ABI, ...ISSUANCE_GATE_ABI];
const governor = fixture.bundle.request.recipient;
const blockHash = `0x${'ab'.repeat(32)}`;
const adapter = '0x5555555555555555555555555555555555555555';
const terms = `0x${'99'.repeat(32)}`;
const values = {
  governor,
  paused: true,
  issuerKeys: [
    policy.issuerAddress,
    BigInt(fixture.bundle.request.validUntil),
    false,
  ],
  policies: [1n, policy.sourceId, 1n, terms, false],
  rights: [policy.token, adapter, keccak256('0x60026000'), terms, false],
  backingPools: [1000n, 0n, 0n],
  programs: [
    policy.verifierAddress,
    policy.verifierCodeHash,
    policy.programVKey,
    2,
    false,
  ],
  sourceKeys: [policy.sourceSignerFingerprint, false],
};
const registry = {
  address: '0x7777777777777777777777777777777777777777',
  proxyCodeHash: keccak256('0x60036000'),
  implementation: '0x8888888888888888888888888888888888888888',
  implementationCodeHash: keccak256('0x60046000'),
  owner: governor,
};
const metadataText = JSON.stringify({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Synthetic issuer discovery service',
  registrations: [
    { agentId: 1, agentRegistry: `eip155:296:${registry.address}` },
  ],
  ultratokenizer: {
    format: 'ultratokenizer.discovery-dossier.v1',
    role: 'issuer',
    chainId: '296',
    gate: policy.gate,
    gateRuntimeHash: fixture.deployment.gateCodeHash,
    issuerId: policy.issuerId,
    sourceId: policy.sourceId,
    sourceKeyVersion: '1',
    sourceSignerFingerprint: policy.sourceSignerFingerprint,
    token: policy.token,
    termsHash: terms,
    policyVersion: '1',
    rightsVersion: '1',
    gateIsSoleMintAuthority: true,
    registryAssertionsAuthorizeIssuance: false,
    proposedPermitSigner: policy.issuerAddress,
  },
});
const discoveryIndex = {
  format: 'ultratokenizer.discovery.v1',
  chainId: '296',
  gate: policy.gate,
  issuerId: policy.issuerId,
  identityRegistry: registry,
  entries: [
    {
      role: 'issuer',
      agentId: '1',
      owner: policy.issuerAddress,
      wallet: policy.issuerAddress,
      metadataHash: keccak256(toHex(metadataText)),
    },
  ],
};
let validDiscovery = true;
let deploymentAvailable = false;
const browser = await chromium.launch({ headless: true });
const errors = [];
const unexpected = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ governor, hash }) => {
      window.sends = [];
      window.walletAccount = governor;
      window.ethereum = {
        async request({ method, params }) {
          if (method === 'eth_chainId') return '0x128';
          if (['eth_accounts', 'eth_requestAccounts'].includes(method))
            return [window.walletAccount];
          if (method === 'eth_sendTransaction') {
            window.sends.push(params[0]);
            return hash;
          }
          throw new Error(`Unexpected wallet method ${method}`);
        },
      };
    },
    { governor, hash: fixture.transactionHash },
  );
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === fixture.deployment.rpcUrl && request.method() === 'POST') {
      const call = request.postDataJSON();
      let result;
      if (call.method === 'eth_chainId') result = '0x128';
      else if (call.method === 'eth_getTransactionCount') result = '0x7';
      else if (call.method === 'eth_blockNumber') result = '0x64';
      else if (call.method === 'eth_getBlockByNumber')
        result = {
          number: '0x64',
          hash: blockHash,
          timestamp: '0x713fb300',
          transactions: [],
        };
      else if (call.method === 'eth_getCode')
        result =
          call.params[0].toLowerCase() === registry.address.toLowerCase()
            ? '0x60036000'
            : call.params[0].toLowerCase() ===
                registry.implementation.toLowerCase()
              ? '0x60046000'
              : call.params[0].toLowerCase() === policy.gate.toLowerCase()
                ? '0x60006000'
                : call.params[0].toLowerCase() === adapter.toLowerCase()
                  ? '0x60026000'
                  : '0x60016000';
      else if (call.method === 'eth_getStorageAt')
        result = `0x${'0'.repeat(24)}${registry.implementation.slice(2)}`;
      else if (call.method === 'eth_call') {
        if (
          call.params[0].to.toLowerCase() === registry.address.toLowerCase()
        ) {
          const decoded = decodeFunctionData({
            abi: IDENTITY_ABI,
            data: call.params[0].data,
          });
          const value =
            decoded.functionName === 'owner'
              ? governor
              : decoded.functionName === 'tokenURI'
                ? `data:application/json;base64,${Buffer.from(validDiscovery ? metadataText : '{}').toString('base64')}`
                : policy.issuerAddress;
          result = encodeFunctionResult({
            abi: IDENTITY_ABI,
            functionName: decoded.functionName,
            result: value,
          });
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result }),
          });
        }
        const decoded = decodeFunctionData({ abi, data: call.params[0].data });
        result =
          decoded.functionName in values
            ? encodeFunctionResult({
                abi,
                functionName: decoded.functionName,
                result: values[decoded.functionName],
              })
            : '0x';
      } else if (call.method === 'eth_getTransactionReceipt') {
        values.backingPools[0] = 2000n;
        result = {
          transactionHash: fixture.transactionHash,
          blockHash,
          blockNumber: '0x64',
          from: governor,
          to: policy.gate,
          status: '0x1',
          logs: [],
          transactionIndex: '0x0',
          type: '0x2',
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
        };
      } else if (call.method === 'eth_getTransactionByHash')
        result = {
          hash: fixture.transactionHash,
          blockHash,
          blockNumber: '0x64',
          from: governor,
          to: policy.gate,
          value: '0x0',
          nonce: '0x7',
          input: await page.evaluate(() => window.sends[0].data),
          transactionIndex: '0x0',
          type: '0x2',
          gas: '0x5208',
          chainId: '0x128',
        };
      else throw new Error(`Unexpected RPC ${call.method}`);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result }),
      });
    }
    if (url.origin !== base.origin) {
      unexpected.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/deployment.json' && !deploymentAvailable)
      return route.fulfill({ status: 404, body: 'Not configured' });
    if (url.pathname === '/deployment.json')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(fixture.deployment),
      });
    if (url.pathname === '/discovery.json')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(discoveryIndex),
      });
    return route.continue();
  });
  await page.goto(new URL('trust/', base).href);
  await expect(
    page.getByText(
      "The deployment operator has not published this site's configuration yet.",
      { exact: false },
    ),
  ).toBeVisible();
  deploymentAvailable = true;
  await page.getByRole('button', { name: 'Refresh chain state' }).click();
  await expect(
    page.getByText(
      "The deployment operator has not published this site's configuration yet.",
      { exact: false },
    ),
  ).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Follow the authority.' }),
  ).toBeVisible();
  await expect(
    page.getByText('Observed at block 100', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Matches application pins', { exact: false }).first(),
  ).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.sends), []);
  await expect(
    page.getByRole('heading', { name: 'Synthetic issuer discovery service' }),
  ).toBeVisible();
  await mkdir(new URL('../../../.scratch/web-qa/', import.meta.url), {
    recursive: true,
  });
  await page.screenshot({
    path: new URL('../../../.scratch/web-qa/trust-desktop.png', import.meta.url)
      .pathname,
    fullPage: true,
  });
  values.paused = false;
  values.backingPools = [1000n, 1000n, 0n];
  await page.getByRole('button', { name: 'Refresh chain state' }).click();
  await expect(
    page.getByText('No capacity remains for new reservations.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Configured authority is active', { exact: false }),
  ).toBeVisible();
  values.backingPools = [1000n, 0n, 0n];
  validDiscovery = false;
  await page.getByRole('button', { name: 'Refresh chain state' }).click();
  await expect(
    page.getByText('Discovery was not confirmed:', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('Observed at block 100', { exact: true }),
  ).toBeVisible();
  await page.goto(new URL('institution/', base).href);
  await expect(
    page.getByRole('heading', { name: 'Review. Authorize. Issue.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Connect wallet', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Claim proof export')).toBeEnabled();
  await dropFiles(page, 'Claim proof export', [
    {
      name: 'synthetic-claim-proof.json',
      content: JSON.stringify({
        status: 'verified_groth16_export',
        proofMode: 'groth16',
        zeroKnowledge: true,
        issuerAuthorityChecked: false,
        outerCircuitVersion: 'v6.1.0',
        proofBytes: `0x${'01'.repeat(356)}`,
        publicValues: fixture.bundle.publicValues,
        programVKey: policy.programVKey,
        request: fixture.bundle.request,
      }),
    },
  ]);
  await expect(
    page.getByText('synthetic-claim-proof.json', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('1.000 g', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Demo authority', exact: true })
    .click();
  await page
    .getByLabel('Dossier or review reference')
    .fill('synthetic-review-001');
  await page
    .getByLabel('I reviewed the issuer, source and terms separately.', {
      exact: false,
    })
    .check();
  await page.getByLabel('Total backing cap (g)').fill('2.000');
  await page.getByRole('button', { name: 'Review cap in wallet' }).click();
  await expect(
    page.getByText('The Gate transaction is confirmed.', { exact: true }),
  ).toBeVisible();
  assert.equal((await page.evaluate(() => window.sends)).length, 1);
  await expect(page.getByText('2.000 / 0.000 / 0.000 g')).toBeVisible();
  await page.screenshot({
    path: new URL(
      '../../../.scratch/web-qa/institution-desktop.png',
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: new URL(
      '../../../.scratch/web-qa/institution-mobile.png',
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.evaluate((address) => {
    window.walletAccount = address;
  }, policy.issuerAddress);
  await page.getByRole('button', { name: /^0x/ }).click();
  await page
    .getByLabel('I reviewed the issuer, source and terms separately.', {
      exact: false,
    })
    .check();
  await expect(
    page.getByRole('button', { name: 'Review cap in wallet' }),
  ).toBeDisabled();
  assert.equal((await page.evaluate(() => window.sends)).length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    'Institution/Trust browser checks passed: real client with synthetic RPC, role denial, exact cap dispatch/reconciliation and 320px layout. No live transactions.',
  );
} finally {
  await browser.close();
}
