// Production browser QA using the web package's pinned development dependency.
// No app backend is needed. Bundled Chromium is the reproducible default.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173/';
const fixture = await readFile(
  new URL('./fixtures/sample-receipt-v1.json', import.meta.url),
);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 320, height: 640 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  const workerUrls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => workerUrls.push(worker.url()));
  await page.addInitScript(() => {
    window.workerStats = { created: 0, terminated: 0, posts: [] };
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      window.cspViolations.push(event.violatedDirective),
    );
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(...args) {
        super(...args);
        window.workerStats.created++;
      }
      postMessage(message, ...args) {
        window.workerStats.posts.push(
          new TextEncoder().encode(message.text).byteLength,
        );
        return super.postMessage(message, ...args);
      }
      terminate() {
        window.workerStats.terminated++;
        return super.terminate();
      }
    };
  });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/'))
      return route.abort();
    return route.continue();
  });
  await page.goto(new URL('verify/', base).href, { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('heading', { name: 'A receipt. A closer look.' }),
  ).toBeVisible();
  assert.match(
    await page
      .locator('meta[http-equiv="content-security-policy"]')
      .getAttribute('content'),
    /script-src 'self' 'sha256-/,
  );
  const upload = async (buffer = fixture) =>
    page.getByLabel('Choose sample receipt JSON').setInputFiles({
      name: 'sample.json',
      mimeType: 'application/json',
      buffer,
    });
  await upload();
  await expect(page.locator('.receipt-read-result')).toContainText(
    'Request digest matches',
  );
  await expect(
    page.locator('.verification-levels dd', { hasText: 'Not verified' }),
  ).toHaveCount(4);
  assert.equal(workerUrls.length, 1);
  assert.match(workerUrls[0], /receipt\.worker-.*\.js$/);
  assert.deepEqual(await page.evaluate(() => window.workerStats), {
    created: 1,
    terminated: 1,
    posts: [fixture.byteLength],
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );

  await upload(Buffer.alloc(65537, ' '));
  await expect(page.locator('.receipt-read-error')).toContainText('64 KB');
  assert.equal((await page.evaluate(() => window.workerStats)).created, 1);
  const changed = JSON.parse(fixture);
  changed.request.amount = '5001';
  await upload(Buffer.from(JSON.stringify(changed)));
  await expect(page.locator('.receipt-read-error')).toContainText(
    'digest mismatch',
  );
  await expect(page.locator('.receipt-read-result')).toHaveCount(0);

  // Actual dedicated thread does CPU work until UI cancellation terminates it.
  const hangWorker = async (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'while (true) {}',
    });
  await page.route('**/receipt.worker-*.js', hangWorker);
  await upload();
  await expect(
    page.getByRole('button', { name: 'Cancel verification' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel verification' }).click();
  await expect(page.locator('.receipt-read-error')).toContainText('cancelled');
  await expect(
    page.getByRole('button', { name: 'Check saved receipt' }),
  ).toBeFocused();
  await expect(page.locator('.receipt-read-result')).toHaveCount(0);
  await upload();
  await expect(page.locator('.receipt-read-error')).toContainText('timed out', {
    timeout: 12000,
  });
  await expect(page.locator('.receipt-read-result')).toHaveCount(0);
  await page.unroute('**/receipt.worker-*.js', hangWorker);
  await upload();
  await expect(page.locator('.receipt-read-result')).toContainText(
    'Request digest matches',
  );
  const stats = await page.evaluate(() => window.workerStats);
  assert.equal(stats.created, stats.terminated);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(errors, []);

  const unsupported = await browser.newPage();
  await unsupported.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue()
      : route.abort(),
  );
  await unsupported.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error('not supported');
      }
    };
  });
  await unsupported.goto(new URL('verify/', base).href);
  await unsupported.getByLabel('Choose sample receipt JSON').setInputFiles({
    name: 'sample.json',
    mimeType: 'application/json',
    buffer: fixture,
  });
  await expect(unsupported.locator('.receipt-read-error')).toContainText(
    'could not start',
  );
  await expect(unsupported.locator('.receipt-read-result')).toHaveCount(0);
  console.log(
    'Production worker boundary, static hydration/CSP, backend-offline verification, byte bounds, cancellation, timeout/retry, unavailable worker, evidence levels and 320px layout passed.',
  );
} finally {
  await browser.close();
}
