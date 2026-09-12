import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const origin = new URL(base).origin;
const demo = new URL('demo/', base).href;
const browser = await chromium.launch({ headless: true });
const parts = ['Claim', 'Proof', 'Permission', 'Check'];
const steps = [
  'The problem it solves',
  'What the document carries',
  'Proving the signature without showing the document',
  'One hash for the whole request',
  'Three languages, one answer',
  'All of it, or none of it',
  'What the institution does',
  'The ten checks',
  'One door into the token',
  'What the registry is for',
];
const reference = ['Current state', 'Prize criteria', 'Where to look next'];
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

/** Every heading inside a visible step must be readable without scrolling. */
function parkedHeadings(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main .step:not([hidden]) h3')]
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
  // The walkthrough must teach the protocol without a published deployment.
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
      // Every step stays in the document even while its part is closed.
      for (const label of [...steps, ...reference])
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
    assert.deepEqual(await parkedHeadings(page), []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Four parts, stepped in order, each showing only its own steps.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await expect(page.locator('.rail button')).toHaveCount(parts.length);
    await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();
    const visible = async () =>
      page.locator('main .step:not([hidden])').count();
    // Exactly one step owns the frame, so a 16:9 screen never has to scroll.
    assert.equal(await visible(), 1, 'one step at a time');
    for (let index = 1; index < steps.length; index += 1) {
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(
        page.locator(`main section[aria-label="${steps[index]}"]`),
      ).toBeVisible();
      assert.equal(await visible(), 1, `step ${index + 1} stands alone`);
      assert.deepEqual(await parkedHeadings(page), []);
    }
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
    // A part chip jumps to where that part begins.
    await page.getByRole('button', { name: 'Permission' }).click();
    await expect(
      page.locator('main section[aria-label="All of it, or none of it"]'),
    ).toBeVisible();
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // "Show everything" must open all ten steps and retire the stepper controls.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Show everything' }).click();
    await expect(page.locator('main .step[hidden]')).toHaveCount(0);
    await expect(page.locator('.rail')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
    assert.deepEqual(await parkedHeadings(page), []);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'expanded view overflows',
    );
    await page.getByRole('button', { name: 'Step through it' }).click();
    await expect(page.locator('main .step:not([hidden])')).toHaveCount(1);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // With a published configuration the reference block shows outbound links.
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
    // Every step cites something a reader can open independently.
    for (const label of steps)
      await expect(
        page.locator(`main section[aria-label="${label}"] .sources a`).first(),
      ).toHaveAttribute('href', /^https:\/\//);
    assert.deepEqual(external, [], 'citations must never be fetched');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Reduced motion must leave every visible step complete.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Show everything' }).click();
    await page.waitForTimeout(1200);
    await expect(page.locator('main .step[hidden]')).toHaveCount(0);
    assert.deepEqual(await parkedHeadings(page), []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log(
    'Walkthrough: four parts over ten steps, every step cited, fail-closed configuration, expanded view complete, reduced motion stationary, no external requests.',
  );
} finally {
  await browser.close();
}
