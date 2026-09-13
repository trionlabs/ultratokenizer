import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  loadModule,
  operatorUrl,
  openOperatorConfiguration,
} from './helpers.mjs';

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
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'service_unavailable',
              message: 'Unavailable fixture service',
            },
          }),
        });
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
      page.getByRole('heading', {
        name: 'Ownership Docs. Verifiably tokenized.',
      }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('ISSUANCE CONFIRMED');
    await expect(page.locator('.engine-label')).toHaveText(
      'Proof-gated issuance on Hedera ATS',
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByLabel('Import deployment configuration', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Operator configuration', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Institution', exact: true }),
    ).toHaveAttribute('href', '/institution/');
    await expect(
      page.getByRole('link', { name: 'Trust', exact: true }),
    ).toHaveAttribute('href', '/trust/');
    if (scenario === 'ready') {
      await expect(page.locator('.header-wallet')).toBeEnabled();
      await expect(page.locator('.live-footer')).toContainText(
        'Signed PDF → SP1 proof → Gate decision → Hedera ATS.',
      );
      await expect(page.locator('.activity-rail')).toContainText(
        'Hedera testnet',
      );
    } else {
      await expect(page.locator('.header-wallet')).toBeEnabled();
      await expect(page.locator('.activity-rail')).toHaveCount(0);
    }
    await expect(
      page.getByRole('button', { name: 'Upload signed PDF', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByLabel('Import issuance bundle', { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.flow-rail li')).toHaveCount(3);
    await expect(
      page.locator('.flow-rail [aria-current="step"]'),
    ).toContainText('Document');
    await expect(page.locator('.document-action')).not.toContainText('JSON');
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
    }
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
  const operator = await browser.newPage({
    viewport: { width: 320, height: 640 },
  });
  const operatorCalls = [];
  const operatorErrors = [];
  operator.on('pageerror', (error) => operatorErrors.push(error.message));
  await operator.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== new URL(base).origin ||
      route.request().method() !== 'GET'
    ) {
      operatorCalls.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/deployment.json')
      return route.fulfill({ status: 404 });
    return route.continue();
  });
  await operator.goto(operatorUrl(base), { waitUntil: 'networkidle' });
  await openOperatorConfiguration(operator);
  await expect(
    operator.getByRole('heading', { name: 'Use another deployment' }),
  ).toBeVisible();
  await expect(operator.locator('.setup-dialog')).not.toContainText(
    'No file chosen',
  );
  await expect(
    operator.getByRole('button', { name: 'Import deployment file' }),
  ).toBeVisible();
  const input = operator.getByLabel('Import deployment configuration', {
    exact: true,
  });
  await expect(input).toBeHidden();
  const [picker] = await Promise.all([
    operator.waitForEvent('filechooser'),
    operator.getByRole('button', { name: 'Import deployment file' }).click(),
  ]);
  await picker.setFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(operator.locator('.setup-dialog .inline-error')).toBeVisible();
  await expect(operator.locator('.stage-action .inline-error')).toHaveCount(0);
  await operator
    .getByRole('button', { name: 'Close operator configuration' })
    .click();
  await expect(
    operator.getByRole('button', {
      name: 'Operator configuration',
      exact: true,
    }),
  ).toBeFocused();
  await expect(operator.locator('.stage-action .inline-error')).toHaveCount(0);
  await openOperatorConfiguration(operator);
  await input.setInputFiles({
    name: 'approved-deployment.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture.deployment)),
  });
  await expect(operator.getByRole('dialog')).toHaveCount(0);
  await expect(operator.locator('#issuance-title')).toBeFocused();
  await expect(
    operator.getByLabel('Import issuance bundle', { exact: true }),
  ).toBeEnabled();
  assert(
    await operator.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(operatorCalls, []);
  assert.deepEqual(operatorErrors, []);
  await operator.close();
  const switching = await browser.newPage();
  const switchDeployment = {
    ...fixture.deployment,
    rpcUrl: new URL('rpc', base).href,
  };
  await switching.addInitScript((recipient) => {
    let chain = '0x1';
    let known = false;
    window.walletCalls = [];
    window.ethereum = {
      async request({ method }) {
        window.walletCalls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts')
          return [recipient];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') {
          if (!known) throw { code: 4902 };
          chain = '0x128';
          return null;
        }
        if (method === 'wallet_addEthereumChain') {
          known = true;
          return null;
        }
        throw new Error(`Unexpected wallet call: ${method}`);
      },
    };
  }, fixture.bundle.request.recipient);
  await switching.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/deployment.json')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(switchDeployment),
      });
    if (url.pathname === '/rpc') {
      const request = route.request().postDataJSON();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'eth_chainId' ? '0x128' : '0x',
        }),
      });
    }
    return route.continue();
  });
  await switching.goto(base, { waitUntil: 'networkidle' });
  await switching.locator('.header-wallet').click();
  await expect(switching.locator('.header-wallet')).toHaveText(
    'Switch to testnet',
  );
  await switching.locator('.header-wallet').click();
  await expect(switching.locator('.header-wallet')).toHaveText(
    /0x[0-9A-Fa-f]{4}…/,
  );
  assert.deepEqual(
    (await switching.evaluate(() => window.walletCalls)).filter((method) =>
      method.startsWith('wallet_'),
    ),
    [
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ],
  );
  assert.equal(
    (await switching.evaluate(() => window.walletCalls)).some((method) =>
      method.startsWith('eth_send'),
    ),
    false,
  );
  await switching.close();
  const stalled = await browser.newPage();
  await stalled.route('**/_app/immutable/entry/start.*.js', (route) =>
    route.abort('failed'),
  );
  await stalled.goto(base, { waitUntil: 'networkidle' });
  await expect(stalled.locator('.direct-tab')).toContainText(
    'If this screen stays',
  );
  await expect(stalled.locator('#issuance-title')).toHaveText(
    'Ownership Docs. Verifiably tokenized.',
  );
  await expect(stalled.locator('.app-surface')).toHaveAttribute('inert', '');
  const retry = stalled.getByRole('link', {
    name: 'Open Ultratokenizer directly',
  });
  await expect(retry).toHaveAttribute('href', '?reload=1');
  const [recovered] = await Promise.all([
    stalled.waitForEvent('popup'),
    retry.click(),
  ]);
  await expect(
    recovered.getByRole('heading', {
      name: 'Ownership Docs. Verifiably tokenized.',
    }),
  ).toBeVisible();
  await recovered.close();
  await stalled.close();
  console.log(
    'Hosted configuration: automatic load, missing/invalid fail-closed, explicit wallet access only, failed-start recovery, no external calls.',
  );
} finally {
  await browser.close();
}
