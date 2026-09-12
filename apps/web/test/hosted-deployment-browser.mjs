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
    await page.addInitScript((recipient) => {
      window.walletCalls = [];
      window.ethereum = {
        async request({ method }) {
          window.walletCalls.push(method);
          if (method === 'eth_requestAccounts') return [recipient];
          if (method === 'eth_chainId') return '0x128';
          throw new Error(`Unexpected wallet call: ${method}`);
        },
      };
    }, fixture.bundle.request.recipient);
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
      await expect(page.locator('.header-wallet')).toBeEnabled();
      await expect(page.locator('.activity-rail')).toHaveCount(0);
      await expect(
        page.getByLabel('Import issuance bundle', { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator('.scene-kicker').first()).toContainText(
        'How issuance works',
      );
      await expect(
        page.locator('.flow-rail [aria-current="step"]'),
      ).toHaveCount(0);
      await expect(page.locator('.proof-sheet')).not.toContainText('— g');
      const retry = page.getByRole('button', { name: 'Try again' });
      if (scenario === 'missing') await expect(retry).toHaveCount(0);
      else await expect(retry).toBeEnabled();
      await expect(page.locator('.engine-stage .stage-action')).toContainText(
        scenario === 'missing'
          ? 'Gold issuance is not open yet'
          : 'Could not check issuance status',
      );
      await expect(
        page.getByRole('button', { name: 'Operator setup' }),
      ).toBeVisible();
    }
    assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
    if (scenario !== 'ready') {
      await page.locator('.header-wallet').click();
      await expect(page.locator('.header-wallet')).toHaveText(
        /0x[0-9A-Fa-f]{4}…/,
      );
      assert.deepEqual(await page.evaluate(() => window.walletCalls), [
        'eth_requestAccounts',
        'eth_chainId',
      ]);
      await expect(page.locator('.engine-stage .stage-action')).toContainText(
        scenario === 'missing'
          ? 'Gold issuance is not open yet'
          : 'Could not check issuance status',
      );
    }
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
  const stalled = await browser.newPage();
  await stalled.route('**/_app/immutable/entry/start.*.js', (route) =>
    route.abort('failed'),
  );
  await stalled.goto(base, { waitUntil: 'networkidle' });
  await expect(stalled.locator('.direct-tab')).toContainText(
    'If this screen stays',
  );
  await expect(
    stalled.getByRole('heading', { name: 'Proof first. Tokens next.' }),
  ).toHaveCount(0);
  const retry = stalled.getByRole('link', {
    name: 'Open Ultratokenizer directly',
  });
  await expect(retry).toHaveAttribute('href', '?reload=1');
  const [recovered] = await Promise.all([
    stalled.waitForEvent('popup'),
    retry.click(),
  ]);
  await expect(
    recovered.getByRole('heading', { name: 'Proof first. Tokens next.' }),
  ).toBeVisible();
  await recovered.close();
  await stalled.close();
  console.log(
    'Hosted configuration: automatic load, missing/invalid fail-closed, explicit wallet access only, failed-start recovery, no external calls.',
  );
} finally {
  await browser.close();
}
