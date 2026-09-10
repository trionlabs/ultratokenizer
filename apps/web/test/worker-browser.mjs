// Production browser checks. Test fixtures never provide a runtime success fallback.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { loadModule } from './helpers.mjs';
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173/';
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const fixture = await createFixture();
const oldSample = await readFile(
  new URL('./fixtures/sample-receipt-v1.json', import.meta.url),
);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
  headless: true,
});
const upload = (page, label, value, filename = 'input.json') =>
  page.getByLabel(label, { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
  });
const noOverflow = async (page) =>
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  const workerUrls = [];
  const rpcCalls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => workerUrls.push(worker.url()));
  await page.addInitScript(
    ({ address }) => {
      window.workerStats = { created: 0, terminated: 0 };
      window.cspViolations = [];
      window.walletCalls = [];
      document.addEventListener('securitypolicyviolation', (event) =>
        window.cspViolations.push(event.violatedDirective),
      );
      const BrowserWorker = window.Worker;
      window.Worker = class extends BrowserWorker {
        constructor(...args) {
          super(...args);
          window.workerStats.created++;
        }
        terminate() {
          window.workerStats.terminated++;
          return super.terminate();
        }
      };
      window.ethereum = {
        async request({ method }) {
          window.walletCalls.push(method);
          if (method === 'eth_requestAccounts' || method === 'eth_accounts')
            return [address];
          if (method === 'eth_chainId') return '0x128';
          throw new Error(`Unexpected wallet method ${method}`);
        },
      };
    },
    { address: fixture.bundle.request.recipient },
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === '/rpc-test') {
      const input = route.request().postDataJSON();
      const reply = (request) => {
        rpcCalls.push(request.method);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'eth_chainId' ? '0x128' : '0x',
        };
      };
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          Array.isArray(input) ? input.map(reply) : reply(input),
        ),
      });
    }
    return route.continue();
  });

  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('heading', { name: 'A right. A new form.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Issue full claim' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Connect', exact: true }),
  ).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
  assert.deepEqual(rpcCalls, []);
  await expect(page.getByRole('button', { name: 'Try a sample' })).toHaveCount(
    0,
  );
  assert.match(
    await page
      .locator('meta[http-equiv="content-security-policy"]')
      .getAttribute('content'),
    /script-src 'self' 'sha256-/,
  );
  await mkdir(new URL('../../../.scratch/web-qa/', import.meta.url), {
    recursive: true,
  });
  await page.screenshot({
    path: new URL(
      '../../../.scratch/web-qa/issuance-desktop.png',
      import.meta.url,
    ).pathname,
    fullPage: true,
  });

  const deployment = {
    ...fixture.deployment,
    rpcUrl: new URL('rpc-test', base).href,
  };
  await upload(page, 'Import deployment configuration', deployment);
  await upload(page, 'Import issuance bundle', fixture.bundle);
  await expect(page.locator('.claim-quantity')).toHaveText('1.000g');
  await expect(
    page.locator('.issuance-controls input[inputmode="decimal"]'),
  ).toHaveCount(0);
  assert.deepEqual(rpcCalls, []);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.issuance-controls .inline-error')).toContainText(
    'do not match',
  );
  assert(rpcCalls.includes('eth_getCode'));
  await expect(
    page.getByRole('button', { name: 'Sign request', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.transaction-card')).toHaveCount(0);
  assert(
    !(await page.evaluate(() => window.walletCalls)).includes(
      'eth_sendTransaction',
    ),
  );

  await page.setViewportSize({ width: 320, height: 640 });
  await noOverflow(page);
  await page.screenshot({
    path: new URL(
      '../../../.scratch/web-qa/issuance-mobile.png',
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.goto(new URL('verify/', base).href, { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('heading', { name: 'A receipt. A closer look.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check receipt offline' }),
  ).toBeDisabled();
  await upload(page, 'Choose issuance receipt JSON', fixture.receipt);
  await expect(
    page.getByRole('button', { name: 'Check receipt offline' }),
  ).toBeDisabled();
  await upload(page, 'Choose independent audit policy JSON', fixture.policy);
  const rpcBeforeAudit = rpcCalls.length;
  await page.getByRole('button', { name: 'Check receipt offline' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Checks completed · history incomplete',
    }),
  ).toBeVisible();
  await expect(
    page
      .locator('.audit-checks > div')
      .filter({ has: page.getByText('Holder eoa signature', { exact: true }) }),
  ).toContainText('Verified');
  await expect(
    page
      .locator('.audit-checks > div')
      .filter({ has: page.getByText('Proof cryptography', { exact: true }) }),
  ).toContainText('Unverified');
  assert.equal(rpcCalls.length, rpcBeforeAudit);
  assert.equal(workerUrls.length, 1);
  assert.match(workerUrls[0], /receipt\.worker-.*\.js$/);
  await noOverflow(page);
  await page.screenshot({
    path: new URL('../../../.scratch/web-qa/verify-mobile.png', import.meta.url)
      .pathname,
    fullPage: true,
  });

  // The dedicated worker also validates direct messages that bypass client preflight.
  const directReplies = await page.evaluate(async (url) => {
    const worker = new Worker(url, { type: 'module' });
    const replies = [];
    try {
      for (const data of [
        { type: 'verify-issuance-v1', id: 1001, text: '{}', policyText: null },
        { type: 'verify-issuance-v1', id: 1002, text: null, policyText: '{}' },
      ]) {
        replies.push(
          await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Direct worker input check timed out')),
              5000,
            );
            worker.onmessage = ({ data: reply }) => {
              clearTimeout(timer);
              resolve(reply);
            };
            worker.onerror = () => {
              clearTimeout(timer);
              reject(new Error('Direct worker failed'));
            };
            worker.postMessage(data);
          }),
        );
      }
      return replies;
    } finally {
      worker.terminate();
    }
  }, workerUrls[0]);
  assert.deepEqual(directReplies, [
    { id: 1001, ok: false, code: 'invalid_policy' },
    { id: 1002, ok: false, code: 'invalid_receipt' },
  ]);

  // An explicit online request reaches the configured RPC, but an unresolved
  // verifier block still cannot promote proof cryptography to verified.
  const onlineToggle = page.getByRole('checkbox', {
    name: /Enable an online proof check/,
  });
  await onlineToggle.check();
  await page.getByLabel('Proof verifier RPC URL').fill(deployment.rpcUrl);
  assert.equal(rpcCalls.length, rpcBeforeAudit);
  await page
    .getByRole('button', { name: 'Check receipt + online proof' })
    .click();
  await expect(page.locator('.audit-report-heading')).toContainText(
    'Explicit online proof check',
  );
  assert(rpcCalls.length > rpcBeforeAudit);
  await expect(
    page
      .locator('.audit-checks > div')
      .filter({ has: page.getByText('Proof cryptography', { exact: true }) }),
  ).toContainText('Unverified');
  await onlineToggle.uncheck();

  const changed = {
    ...fixture.receipt,
    request: { ...fixture.receipt.request, amount: '1001' },
  };
  await upload(page, 'Choose issuance receipt JSON', changed);
  await page.getByRole('button', { name: 'Check receipt offline' }).click();
  await expect(
    page.getByRole('heading', { name: 'Receipt checks failed' }),
  ).toBeVisible();
  await upload(page, 'Choose issuance receipt JSON', oldSample);
  await page.getByRole('button', { name: 'Check receipt offline' }).click();
  await expect(page.locator('.receipt-read-error')).toContainText(
    'Sample receipts are not accepted',
  );
  await expect(page.locator('.audit-report')).toHaveCount(0);
  await upload(
    page,
    'Choose issuance receipt JSON',
    Buffer.alloc(256 * 1024 + 1, ' '),
  );
  await expect(page.locator('.receipt-read-error')).toContainText('256 KB');

  // An actual busy worker is terminated by cancellation; no UI-thread fallback.
  const hangWorker = (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'while (true) {}',
    });
  await page.route('**/receipt.worker-*.js', hangWorker);
  await upload(page, 'Choose issuance receipt JSON', fixture.receipt);
  await page.getByRole('button', { name: 'Check receipt offline' }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel verification' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel verification' }).click();
  await expect(page.locator('.receipt-read-error')).toContainText('cancelled');
  await expect(
    page.getByRole('button', { name: 'Check receipt offline' }),
  ).toBeFocused();
  await expect(page.locator('.audit-report')).toHaveCount(0);
  await page.unroute('**/receipt.worker-*.js', hangWorker);
  await page.getByRole('button', { name: 'Check receipt offline' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Checks completed · history incomplete',
    }),
  ).toBeVisible();
  const stats = await page.evaluate(() => window.workerStats);
  assert.equal(stats.created, stats.terminated);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(errors, []);

  const unsupported = await browser.newPage();
  await unsupported.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  await unsupported.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error('unsupported');
      }
    };
  });
  await unsupported.goto(base);
  await upload(unsupported, 'Import deployment configuration', deployment);
  await upload(unsupported, 'Import issuance bundle', fixture.bundle);
  await expect(
    unsupported.getByText(/No injected wallet detected/),
  ).toBeVisible();
  await expect(
    unsupported.getByRole('button', { name: 'Connect', exact: true }),
  ).toBeDisabled();
  await expect(
    unsupported.getByRole('button', { name: 'Issue full claim' }),
  ).toBeDisabled();
  await unsupported.goto(new URL('verify/', base).href);
  await upload(unsupported, 'Choose issuance receipt JSON', fixture.receipt);
  await upload(
    unsupported,
    'Choose independent audit policy JSON',
    fixture.policy,
  );
  await unsupported
    .getByRole('button', { name: 'Check receipt offline' })
    .click();
  await expect(unsupported.locator('.receipt-read-error')).toContainText(
    'could not start',
  );
  console.log(
    'Real client fail-closed boundary, missing wallet, fixed quantity, independent worker audit, EOA signatures, explicit RPC opt-in, incomplete proof/history, tampering, sample rejection, size limits, cancellation/focus/retry, CSP and 320px layout passed. No live issuance was performed.',
  );
} finally {
  await browser.close();
}
