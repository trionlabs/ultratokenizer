// Run after `npm run build` and starting the local production preview:
// PREVIEW_URL=http://127.0.0.1:4173/ node test/backend-browser.mjs
// Synthetic import/recovery checks: all RPC is intercepted; no real wallet or transaction.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { loadModule } from './helpers.mjs';
import { exerciseTokenRecovery } from './fixtures/token-browser.mjs';
import { exerciseIssuanceRecovery } from './fixtures/issuance-browser.mjs';

const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:4173/');
assert.equal(base.protocol, 'http:');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const { createAtsFixture } = await loadModule('./fixtures/ats.ts');
const { getIssuerPermitDigest } = await loadModule(
  '../../../packages/domain/src/index.ts',
);
const { HTS_TOKEN_ABI, ISSUANCE_GATE_ABI, toIssueArgs } = await loadModule(
  '../../../packages/issuance/src/abi.ts',
);
const hts = await createFixture();
const ats = await createAtsFixture();
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
  headless: true,
});
const upload = (page, label, value) =>
  page.getByLabel(label, { exact: true }).setInputFiles({
    name: 'synthetic-backend-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  const blockedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin || route.request().method() !== 'GET') {
      blockedRequests.push({
        origin: url.origin,
        pathname: url.pathname,
        method: route.request().method(),
        type: route.request().resourceType(),
      });
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.walletCalls = [];
    window.ethereum = {
      async request({ method }) {
        window.walletCalls.push(method);
        throw new Error('Import-only checks must not request the wallet');
      },
    };
  });
  await page.goto(base.href, { waitUntil: 'networkidle' });
  const associate = page.getByRole('button', { name: 'Associate this token' });
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  const tokenWorkspace = page.locator('.token-workspace');
  await expect(associate).toHaveCount(0);
  await expect(connect).toBeDisabled();
  await expect(tokenWorkspace).toContainText(
    'Import a deployment to use its token.',
  );

  const invalid = structuredClone(ats.deployment);
  delete invalid.backend.admission;
  await upload(page, 'Import deployment configuration', invalid);
  await expect(page.locator('.issuance-controls .inline-error')).toContainText(
    'An independent, complete deployment configuration is required.',
  );
  await expect(connect).toBeDisabled();
  await expect(associate).toHaveCount(0);
  await expect(page.locator('.network-label')).toHaveText(
    'No deployment loaded',
  );

  for (const deployment of [
    hts.deployment,
    {
      ...hts.deployment,
      format: 'ultratokenizer.deployment.v2',
      backend: { kind: 'hts' },
    },
  ]) {
    await upload(page, 'Import deployment configuration', deployment);
    await upload(page, 'Import issuance bundle', hts.bundle);
    await expect(page.locator('.issuance-controls .inline-error')).toHaveCount(
      0,
    );
    await expect(associate).toBeVisible();
    await expect(associate).toBeDisabled();
    await expect(tokenWorkspace).toContainText(
      'HTS association and transfers are separate wallet transactions.',
    );
    await expect(tokenWorkspace).toContainText(
      'connected wallet has not associated',
    );
    await expect(page.locator('.technical-details')).toContainText(
      'HTS · native token',
    );
    await expect(page.locator('.network-label')).toHaveText(
      'Hedera testnet · 296',
    );
    await expect(page.locator('.wallet-row')).toContainText(
      `Claim recipient · ${hts.bundle.request.recipient}`,
    );
    await expect(page.locator('.claim-quantity')).toHaveText('1.000g');
  }

  await upload(page, 'Import deployment configuration', ats.deployment);
  await upload(page, 'Import issuance bundle', ats.bundle);
  await expect(page.locator('.issuance-controls .inline-error')).toHaveCount(0);
  await expect(associate).toHaveCount(0);
  await expect(tokenWorkspace).toContainText(
    'ATS token transfers are wallet transactions.',
  );
  await expect(tokenWorkspace).not.toContainText('has not associated');
  await expect(tokenWorkspace).not.toContainText('HTS association');
  await expect(page.locator('.technical-details')).toContainText(
    'ATS · EVM token',
  );
  await expect(page.locator('.claim-quantity')).toHaveText('1.000g');
  await expect(
    page.locator('.issuance-controls input[inputmode="decimal"]'),
  ).toHaveCount(0);
  await page.getByLabel('Transfer amount (g)', { exact: true }).fill('0.125');
  await expect(
    page.getByLabel('Transfer amount (g)', { exact: true }),
  ).toHaveValue('0.125');
  await expect(page.locator('.claim-quantity')).toHaveText('1.000g');
  await expect(
    page.getByRole('button', { name: 'Issue full claim' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Review transfer in wallet' }),
  ).toBeDisabled();
  await expect(page.locator('.transaction-card')).toHaveCount(0);
  await expect(page.locator('.check-row')).toContainText('Unchecked.');

  const screenshots = new URL('../../../.scratch/web-qa/', import.meta.url);
  await mkdir(screenshots, { recursive: true });
  await page.locator('.technical-details > summary').click();
  await page.screenshot({
    path: new URL('ats-backend-desktop.png', screenshots).pathname,
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 640 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: new URL('ats-backend-mobile.png', screenshots).pathname,
    fullPage: true,
  });

  // A rejected replacement cannot change an already imported backend or claim.
  await upload(page, 'Import deployment configuration', invalid);
  await expect(page.locator('.issuance-controls .inline-error')).toBeVisible();
  await expect(associate).toHaveCount(0);
  await expect(page.locator('.technical-details')).toContainText(
    'ATS · EVM token',
  );
  await expect(page.locator('.claim-quantity')).toHaveText('1.000g');

  await page.setViewportSize({ width: 320, height: 640 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
  // Existing optional web fonts remain blocked. They do not carry imported data;
  // any other external request or non-GET request fails this import-only test.
  assert.deepEqual(
    blockedRequests.filter(
      (request) =>
        request.origin !== 'https://fonts.googleapis.com' ||
        request.pathname !== '/css2' ||
        request.method !== 'GET' ||
        request.type !== 'stylesheet',
    ),
    [],
  );
  assert.deepEqual(errors, []);
  console.log(
    'Backend browser checks passed: empty, invalid ATS, v1 HTS, v2 HTS, ATS imports; no RPC or wallet calls.',
  );
  console.log(`Blocked optional font stylesheets: ${blockedRequests.length}.`);
  for (const start of ['unknown', 'unresolved']) {
    for (const outcome of ['confirmed', 'reverted']) {
      await exerciseIssuanceRecovery({
        browser,
        base,
        fixture: hts,
        gateAbi: ISSUANCE_GATE_ABI,
        toIssueArgs,
        permitDigest: getIssuerPermitDigest(
          hts.bundle.request,
          hts.bundle.permit,
        ),
        screenshots,
        start,
        outcome,
      });
    }
  }
  for (const kind of ['transfer', 'association']) {
    await exerciseTokenRecovery({
      browser,
      base,
      fixture: hts,
      tokenAbi: HTS_TOKEN_ABI,
      screenshots,
      kind,
    });
  }
} finally {
  await browser.close();
}
