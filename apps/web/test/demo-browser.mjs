import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const origin = new URL(base).origin;
const demo = new URL('demo/', base).href;
const browser = await chromium.launch({ headless: true });
const sections = [
  'Summary',
  'The issuance spine',
  'What zkPDF proves',
  'Cross-language digest',
  'Exact quantity rule',
  'The Gate decision',
  'Hedera Asset Tokenization Studio',
  'ERC-8004 attribution',
  'Current state',
  'Prize criteria',
  'Where to look next',
];
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

try {
  // The walkthrough must explain the protocol without a published deployment.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, undefined);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(demo, { waitUntil: 'networkidle' });
      await expect(
        page.getByRole('heading', {
          name: 'A signed document becomes exactly one token.',
        }),
      ).toBeVisible();
      for (const label of sections)
        await expect(
          page.locator(`main section[aria-label="${label}"]`),
        ).toHaveCount(1);
      await expect(page.locator('.header-wallet')).toHaveCount(0);
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
    await expect(page.locator('.notice')).toContainText(
      'has not published a deployment configuration',
    );
    // Every heading must be readable at rest; nothing waits on a scroll observer.
    const parked = await page.evaluate(() =>
      [...document.querySelectorAll('main h1, main h2, main h3')]
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
    assert.deepEqual(parked, [], 'headings must render at rest');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // With a published configuration the page shows addresses and outbound links.
  if (published) {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    const gate = JSON.parse(published).auditPolicy.gate;
    const state = page.locator('main section[aria-label="Current state"]');
    await expect(state).toContainText(gate);
    await expect(
      state.locator(`a[href="https://hashscan.io/testnet/contract/${gate}"]`),
    ).toHaveCount(1);
    await expect(
      state.locator(`a[href="https://repo.sourcify.dev/296/${gate}"]`),
    ).toHaveCount(1);
    assert.deepEqual(external, [], 'links must never be fetched');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // A replayed request must halt, and the later checks must never be reached.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    const gate = page.locator('main section[aria-label="The Gate decision"]');
    await gate.getByRole('button', { name: 'Run a replayed request' }).click();
    await expect(gate.locator('.verdict')).toContainText(
      'Reverted with Replay',
    );
    await expect(gate.locator('.check[data-state="fail"]')).toHaveCount(1);
    await expect(gate.locator('.check[data-state="skipped"]')).toHaveCount(6);
    await gate
      .getByRole('button', { name: 'Run an authorized request' })
      .click();
    await expect(gate.locator('.verdict')).toContainText('All ten checks');
    await expect(gate.locator('.check[data-state="pass"]')).toHaveCount(10);
    // The exact-amount control must reject every partial request.
    const exact = page.locator(
      'main section[aria-label="Exact quantity rule"]',
    );
    await exact.getByRole('button', { name: '0.500 g' }).click();
    await expect(exact.locator('.verdict')).toContainText('Rejected');
    await exact.getByRole('button', { name: '1.000 g' }).click();
    await expect(exact.locator('.verdict')).toContainText('Accepted');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Reduced motion must leave the walkthrough complete and stationary.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    const active = page.locator('.stage-card[data-active="true"]');
    await expect(active).toHaveCount(1);
    const first = await active.textContent();
    await page.waitForTimeout(3000);
    assert.equal(
      await page.locator('.stage-card[data-active="true"]').textContent(),
      first,
      'the spine must not advance under reduced motion',
    );
    for (const label of sections)
      await expect(
        page.locator(`main section[aria-label="${label}"]`),
      ).toHaveCount(1);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log(
    'Walkthrough: 11 sections at four widths, fail-closed configuration, Gate halt on replay, reduced motion stationary, no external requests.',
  );
} finally {
  await browser.close();
}
