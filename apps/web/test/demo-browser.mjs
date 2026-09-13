import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const origin = new URL(base).origin;
const demo = new URL('demo/', base).href;
const browser = await chromium.launch({ headless: true });
const steps = ['Prove', 'Authorise', 'Mint', 'Evidence'];
// The stage accumulates: each step lights more of the same picture and never
// takes anything away. These are the counts that claim is made of.
const lit = [3, 5, 7, 8];
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

const onStage = (page) => page.locator('.stage .part[data-state="on"]').count();
const onList = (page) =>
  page.locator('.stage-list li[data-state="on"]').count();

try {
  // The four steps advance one shared picture and never scroll sideways.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(demo, { waitUntil: 'networkidle' });
      await expect(page.locator('.rail button.rail-step')).toHaveCount(
        steps.length,
      );
      // The wide diagram sets 9-unit type; under 760px the same progression
      // is carried by the text list instead, and exactly one of them shows.
      const narrow = width <= 760;
      await expect(page.locator('.stage')).toBeVisible({ visible: !narrow });
      await expect(page.locator('.stage-list')).toBeVisible({
        visible: narrow,
      });
      await expect(page.locator('.header-wallet')).toHaveCount(0);
      for (let index = 0; index < steps.length; index += 1) {
        if (index > 0) await page.getByRole('button', { name: 'Next' }).click();
        await expect(
          page.locator(`main section[aria-label="${steps[index]}"]`),
        ).toBeVisible();
        await expect.poll(() => onStage(page)).toBe(lit[index]);
        await expect.poll(() => onList(page)).toBe(lit[index]);
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `demo overflows at ${width}px on step ${index + 1}`,
        );
      }
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: `../../.scratch/web-qa/demo-${width}.png`,
          fullPage: true,
        });
    }
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Detail is one click away under every step and starts closed.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await expect(page.locator('.items details[open]')).toHaveCount(0);
    await expect(page.locator('.items > li')).toHaveCount(4);
    // The proof's disclosure boundary is stated, not implied by "never leaves".
    await expect(page.locator('.items')).toContainText('What stays hidden');
    // The three names a reader would otherwise conflate are told apart.
    const aside = page.locator('.aside');
    await expect(aside).toContainText('zkPDF reads the signature');
    await expect(aside).toContainText('SP1 is the VM');
    await page.locator('.items summary').first().click();
    await expect(page.locator('.items details[open]')).toHaveCount(1);
    await expect(page.locator('.items details[open] a')).toHaveAttribute(
      'href',
      /^https:\/\//,
    );
    assert.deepEqual(external, [], 'sources must never be fetched');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // The last step carries the evidence and the honest limit.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Evidence' }).click();
    await expect(page.locator('.pending')).toContainText('Not live yet');
    await expect(
      page.getByRole('link', { name: 'See it on chain' }),
    ).toBeVisible();
    await page.getByText('Deployed contracts').click();
    if (published) {
      const gate = JSON.parse(published).auditPolicy.gate;
      await expect(
        page.locator(`a[href="https://hashscan.io/testnet/contract/${gate}"]`),
      ).toHaveCount(1);
    } else {
      // static/deployment.json is Git-ignored, so a fresh checkout cannot check
      // the rendered addresses. It must still say the configuration is absent
      // rather than render nothing, and the summary reports the narrower run.
      await expect(page.locator('.item-body')).toContainText(
        'has not published a configuration',
      );
    }
    await page.getByText('Track requirements').click();
    await expect(page.locator('.criteria li')).toHaveCount(4);
    await expect(page.locator('.criteria li[data-met="false"]')).toHaveCount(2);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // Reduced motion leaves the stage complete for the step it is on.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(demo, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Mint' }).click();
    // Every Gate rung is already lit; no timer ever runs. The rung count is
    // pinned to IssuanceGate.issue() by test/demo-claims.test.mjs.
    // Scoped to the stage: the Gate step's own illustration also draws rungs.
    const rungs = await page.locator('.stage .rung').count();
    assert.ok(rungs > 0, 'the stage has no Gate ladder');
    await expect(page.locator('.stage .rung[data-lit="true"]')).toHaveCount(
      rungs,
    );
    await page.waitForTimeout(900);
    await expect(page.locator('.stage .rung[data-lit="true"]')).toHaveCount(
      rungs,
    );
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // A step is addressable: ?step=N opens it, out-of-range falls back to the
  // first, and Back walks the steps instead of leaving the site.
  {
    const external = [];
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await isolate(page, external, published);
    await page.setViewportSize({ width: 1440, height: 950 });
    const current = () =>
      page.locator('.rail button.rail-step[aria-current="step"]').innerText();

    for (let index = 0; index < steps.length; index += 1) {
      await page.goto(`${demo}?step=${index + 1}`, {
        waitUntil: 'networkidle',
      });
      assert.match(await current(), new RegExp(steps[index]));
    }
    for (const query of ['?step=0', `?step=${steps.length + 1}`, '?step=x']) {
      await page.goto(demo + query, { waitUntil: 'networkidle' });
      assert.match(
        await current(),
        new RegExp(steps[0]),
        `${query} fell wrong`,
      );
    }

    await page.goto(`${demo}?step=2`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Next' }).click();
    assert.match(await current(), new RegExp(steps[2]));
    assert.equal(new URL(page.url()).searchParams.get('step'), '3');
    await page.goBack();
    assert.match(await current(), new RegExp(steps[1]));
    assert.equal(new URL(page.url()).searchParams.get('step'), '2');

    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log(
    'Walkthrough: four steps over one accumulating stage, addressable by ?step, detail on demand, evidence and limit on the last step, reduced motion stationary, no external requests.' +
      (published
        ? ' Deployment addresses checked against static/deployment.json.'
        : ' No static/deployment.json present: the rendered addresses were NOT checked, only the absent-configuration message.'),
  );
} finally {
  await browser.close();
}
