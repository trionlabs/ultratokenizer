import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Two injected synthetic wallets; no extension, RPC, signature or broadcast. */
export async function exerciseWalletDiscovery(browser, base) {
  const page = await browser.newPage();
  const origin = new URL(base).origin;
  const errors = [];
  const unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') {
      unexpected.push(request.method());
      return route.abort();
    }
    if (url.pathname === '/deployment.json')
      return route.fulfill({ status: 404, body: '' });
    if (url.pathname.startsWith('/api/'))
      return route.fulfill({
        status: 503,
        json: { error: { code: 'service_unavailable' } },
      });
    return route.continue();
  });
  await page.addInitScript(() => {
    window.walletCalls = [];
    const provider = (name, account) => ({
      async request({ method }) {
        window.walletCalls.push([name, method]);
        if (method === 'eth_requestAccounts')
          await new Promise((resolve) => {
            window.finishWalletConnection = resolve;
          });
        if (method === 'eth_accounts' || method === 'eth_requestAccounts')
          return [account];
        if (method === 'eth_chainId') return '0x128';
        throw new Error(`Unexpected synthetic wallet method ${method}`);
      },
      on() {},
      removeListener() {},
    });
    const alpha = provider(
      'Alpha',
      '0x1111111111111111111111111111111111111111',
    );
    const beta = provider('Beta', '0x2222222222222222222222222222222222222222');
    Object.defineProperty(window, 'ethereum', {
      configurable: false,
      get: () => alpha,
    });
    const announce = (uuid, name, wallet) =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: {
              uuid,
              name,
              rdns: `test.${name.toLowerCase()}`,
              icon: 'data:image/png;base64,AA==',
            },
            provider: wallet,
          },
        }),
      );
    const alphaId = '11111111-1111-4111-8111-111111111111';
    const betaId = '22222222-2222-4222-8222-222222222222';
    window.addEventListener('eip6963:requestProvider', () => {
      announce(alphaId, 'Alpha', alpha);
      announce(betaId, 'Beta', beta);
    });
    window.announceConflictingWallet = () => announce(betaId, 'Beta', alpha);
    window.announceLateWallet = () =>
      announce('33333333-3333-4333-8333-333333333333', 'Later', alpha);
  });
  try {
    await page.goto(base.href ?? base, { waitUntil: 'networkidle' });
    const connect = page.getByRole('button', {
      name: 'Connect wallet',
      exact: true,
    });
    const dialog = page.getByRole('dialog', { name: 'Connect a wallet' });
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(dialog).toBeHidden();
    assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await connect.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Alpha/ })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Beta/ })).toBeVisible();
      assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `wallet dialog fits ${width}px`,
      );
      const box = await dialog.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(connect).toBeFocused();
    }
    await connect.click();
    assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
    await dialog.getByRole('button', { name: /Beta/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.header-wallet')).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.walletCalls.filter(
              ([, method]) => method === 'eth_requestAccounts',
            ).length,
        ),
      )
      .toBe(1);
    await page.evaluate(() => {
      window.announceConflictingWallet();
      window.announceLateWallet();
    });
    await page.evaluate(() => window.finishWalletConnection());
    await expect(page.locator('.header-wallet')).toHaveText(/0x2222.*2222/);
    assert(
      (await page.evaluate(() => window.walletCalls)).every(
        ([name]) => name === 'Beta',
      ),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.walletCalls.filter(
            ([, method]) => method === 'eth_requestAccounts',
          ).length,
      ),
      1,
    );
    const beforeReopen = await page.evaluate(() => window.walletCalls.length);
    await page.locator('.header-wallet').click();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Close wallet selection' })
      .click();
    await expect(dialog).toBeHidden();
    assert.equal(
      await page.evaluate(() => window.walletCalls.length),
      beforeReopen,
    );
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(
        () => Object.getOwnPropertyDescriptor(window, 'ethereum').set,
      ),
      undefined,
    );
  } finally {
    await page.close();
  }
}
