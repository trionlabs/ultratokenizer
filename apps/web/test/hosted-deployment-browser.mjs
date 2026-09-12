import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers.mjs';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173/';
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const fixture = await createFixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
});
try {
  for (const scenario of ['ready', 'missing', 'invalid']) {
    const page = await browser.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.walletCalls = [];
      window.ethereum = {
        async request({ method }) {
          window.walletCalls.push(method);
          throw new Error('No wallet call expected');
        },
      };
    });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) {
        external.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/deployment.json')
        return route.fulfill({
          status: scenario === 'missing' ? 404 : 200,
          contentType: 'application/json',
          body:
            scenario === 'ready' ? JSON.stringify(fixture.deployment) : '{}',
        });
      return route.continue();
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await expect(
      page.getByRole('heading', { name: 'Proof first. Tokens next.' }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('MINT CONFIRMED');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (scenario === 'ready') {
      await expect(page.locator('.header-wallet')).toBeEnabled();
      await expect(page.locator('.activity-rail')).toContainText(
        'Hedera testnet',
      );
      const evidence = page.getByLabel('Import issuance bundle', {
        exact: true,
      });
      await expect(evidence).toBeEnabled();
      await evidence.setInputFiles({
        name: 'evidence.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(fixture.bundle)),
      });
      await expect(page.locator('.proof-object')).toHaveAttribute(
        'data-state',
        'loaded',
      );
      await expect(page.locator('.proof-sheet')).toContainText('1.000 g');
    } else {
      await expect(page.locator('.header-wallet')).toBeDisabled();
      await expect(
        page.getByLabel('Import issuance bundle', { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Check availability' }),
      ).toBeEnabled();
      await expect(page.locator('.stage-action')).toContainText(
        scenario === 'missing'
          ? 'Minting is not live yet'
          : 'Unable to connect',
      );
    }
    assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Hosted configuration: automatic load, missing/invalid fail-closed, no wallet or external calls.',
  );
} finally {
  await browser.close();
}
