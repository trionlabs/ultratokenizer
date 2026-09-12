import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const origin = new URL(base).origin;
const demo = new URL('demo/', base).href;
const browser = await chromium.launch({ headless: true });
const acts = ['Prove', 'Authorise', 'Mint'];
const published = await readFile('static/deployment.json', 'utf8').catch(
  () => undefined,
);
await mkdir('../../.scratch/web-qa', { recursive: true });

/** Aborts every cross-origin request and records its origin for the caller. */
function isolate(page, external, config) {
  return page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.origin);
      return route.abort();
    }
    if (url.pathname === '/deployment.json')
      return config
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: config,
          })
        : route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/discovery.json')
      return route.fulfill({ status: 404, body: '' });
    return route.continue();
  });
}

/** Nothing a reader must see may sit invisible behind an unfired observer. */
function parked(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main .act h2, main .act .plain')]
      .filter((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return (
          style.opacity !== '1' ||
          style.visibility === 'hidden' ||
          box.width === 0 ||
          box.height === 0
        );
      })
      .map((node) => node.textContent?.slice(0, 40)),
  );
}

try {
  // The whole shape of the system is readable without a published deployment
  // and without clicking anything.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, undefined);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(demo, { waitUntil: 'networkidle' });
      for (const name of acts)
        await expect(
          page.locator(`main section[aria-label="${name}"]`),
        ).toBeVisible();
      // Five stations carry the end-to-end journey above the three acts.
      await expect(page.locator('.journey li')).toHaveCount(5);
      await expect(page.locator('.header-wallet')).toHaveCount(0);
      assert.deepEqual(await parked(page), []);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `demo overflows at ${width}px`,
      );
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: `../../.scratch/web-qa/demo-${width}.png`,
          fullPage: true,
        });
    }
    // The honest limit is stated on the page itself, not only in the detail.
    await expect(page.locator('.pending-badge')).toContainText('Not live yet');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Detail is available under every act and opens together on request.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    const open = async () =>
      page.locator('main .act details.deeper[open]').count();
    assert.equal(await open(), 0, 'detail starts closed');
    await page.getByRole('button', { name: 'Show the detail' }).click();
    assert.equal(await open(), acts.length, 'every act opens together');
    // The three names a reader will otherwise conflate are told apart.
    await expect(
      page.locator('main section[aria-label="Prove"] .names'),
    ).toContainText('zkPDF is the library');
    await expect(
      page.locator('main section[aria-label="Prove"] .names'),
    ).toContainText('SP1 is the zero-knowledge VM');
    // Sub-steps are numbered inside their act, so they read as a sequence.
    await expect(
      page.locator('main section[aria-label="Prove"] .deeper-index'),
    ).toHaveText(['1.1', '1.2', '1.3']);
    await expect(
      page.locator('main section[aria-label="Mint"] .deeper-index'),
    ).toHaveText(['3.1', '3.2']);
    assert.deepEqual(await parked(page), []);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'expanded view overflows',
    );
    await page.getByRole('button', { name: 'Hide the detail' }).click();
    assert.equal(await open(), 0, 'detail closes again');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Every act cites something a reader can open independently.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    for (const name of acts)
      await expect(
        page.locator(`main section[aria-label="${name}"] .sources a`).first(),
      ).toHaveAttribute('href', /^https:\/\//);
    if (published) {
      const gate = JSON.parse(published).auditPolicy.gate;
      const state = page.locator('details[aria-label="Current state"]');
      await state.locator('summary').click();
      await expect(state).toContainText(gate);
      await expect(
        state.locator(`a[href="https://hashscan.io/testnet/contract/${gate}"]`),
      ).toHaveCount(1);
    }
    assert.deepEqual(external, [], 'citations must never be fetched');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Reduced motion must leave the journey strip complete and stationary.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await expect(page.locator('.journey li[data-on="true"]')).toHaveCount(5);
    await page.waitForTimeout(1400);
    await expect(page.locator('.journey li[data-on="true"]')).toHaveCount(5);
    assert.deepEqual(await parked(page), []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log(
    'Walkthrough: three acts side by side, journey strip complete, numbered sub-steps, every act cited, fail-closed configuration, reduced motion stationary, no external requests.',
  );
} finally {
  await browser.close();
}
