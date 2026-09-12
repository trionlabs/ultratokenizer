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
const upload = async (page, label, value) => {
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
  await page.getByLabel(label, { exact: true }).setInputFiles({
    name: 'synthetic-backend-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
};

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
  const connect = page.locator('.header-wallet');
  const tokenWorkspace = page.locator('.transfer-stage');
  await expect(associate).toHaveCount(0);
  await expect(connect).toHaveText('Connect wallet');
  await expect(connect).toBeDisabled();
  await page.getByRole('link', { name: 'Transfer', exact: true }).click();
  await expect(tokenWorkspace).toContainText(
    'Send any amount in 0.001 g units.',
  );

  const invalid = structuredClone(ats.deployment);
  delete invalid.backend.admission;
  await upload(page, 'Import deployment configuration', invalid);
  await expect(page.locator('.activity-rail .inline-error')).toContainText(
    'An independent, complete deployment configuration is required.',
  );
  await expect(connect).toBeDisabled();
  await expect(associate).toHaveCount(0);
  await expect(page.locator('.session-list')).toContainText('Not loaded');

  for (const deployment of [
    hts.deployment,
    {
      ...hts.deployment,
      format: 'ultratokenizer.deployment.v2',
      backend: { kind: 'hts' },
    },
  ]) {
    await upload(page, 'Import deployment configuration', deployment);
    // Existing holders can connect before supplying any new issuance claim.
    await expect(connect).toBeVisible();
    await expect(connect).toBeEnabled();
    await upload(page, 'Import issuance bundle', hts.bundle);
    await expect(page.locator('.activity-rail .inline-error')).toHaveCount(0);
    await expect(associate).toBeVisible();
    await expect(associate).toBeDisabled();
    await expect(tokenWorkspace).toContainText(
      'chain checks whether association is needed',
    );
    await expect(page.locator('.technical-details')).toContainText(
      'HTS · native token',
    );
    await expect(page.locator('.session-list')).toContainText('Hedera testnet');
    await expect(page.locator('.session-list')).toContainText('1.000 g XAU');
  }

  await upload(page, 'Import deployment configuration', ats.deployment);
  await upload(page, 'Import issuance bundle', ats.bundle);
  await expect(page.locator('.activity-rail .inline-error')).toHaveCount(0);
  await expect(associate).toHaveCount(0);
  await expect(tokenWorkspace).toContainText(
    'Transfers use the connected wallet.',
  );
  await expect(tokenWorkspace).not.toContainText('has not associated');
  await expect(tokenWorkspace).not.toContainText('HTS association');
  await expect(page.locator('.technical-details')).toContainText(
    'ATS · EVM token',
  );
  await expect(page.locator('.session-list')).toContainText('1.000 g XAU');
  await expect(
    page.locator('.engine-stage input[inputmode="decimal"]'),
  ).toHaveCount(0);
  await page.getByLabel('Transfer amount (g)', { exact: true }).fill('0.125');
  await expect(
    page.getByLabel('Transfer amount (g)', { exact: true }),
  ).toHaveValue('0.125');
  await expect(page.locator('.session-list')).toContainText('1.000 g XAU');
  await expect(page.getByRole('button', { name: 'Mint 1.000 g' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Review transfer in wallet' }),
  ).toBeDisabled();
  await expect(page.locator('.transaction-card')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Verify evidence' }),
  ).toHaveCount(0);

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
  await expect(page.locator('.activity-rail .inline-error')).toBeVisible();
  await expect(associate).toHaveCount(0);
  await expect(page.locator('.technical-details')).toContainText(
    'ATS · EVM token',
  );
  await expect(page.locator('.session-list')).toContainText('1.000 g XAU');

  await page.setViewportSize({ width: 320, height: 640 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
  assert.deepEqual(blockedRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    'Backend browser checks passed: empty, invalid ATS, v1 HTS, v2 HTS, ATS imports; no RPC or wallet calls.',
  );
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
    for (const failure of ['lost-hash', 'decline', 'pending']) {
      await exerciseTokenRecovery({
        browser,
        base,
        fixture: hts,
        tokenAbi: HTS_TOKEN_ABI,
        screenshots,
        kind,
        failure,
      });
    }
  }
} finally {
  await browser.close();
}
