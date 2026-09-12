import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true });
const routes = [
  ['', 'Tokenize', true],
  ['institution/', 'Institution', true],
  ['trust/', 'Trust', false],
  ['verify/', 'Verify', false],
  ['demo/', 'How it works', false],
];
const labels = [
  'Tokenize',
  'Transfer',
  'Institution',
  'Trust',
  'Verify',
  'How it works',
];
const errors = [];
const external = [];
await mkdir('../../.scratch/web-qa', { recursive: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.origin);
      return route.abort();
    }
    if (['/deployment.json', '/discovery.json'].includes(url.pathname))
      return route.fulfill({ status: 404, body: '' });
    return route.continue();
  });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    let layout;
    for (const [path, active, wallet] of routes) {
      await page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });
      const header = page.locator('header');
      await expect(header).toHaveCount(1);
      await expect(header).toHaveClass(/app-header/);
      await expect(header.locator('nav a')).toHaveText(labels);
      await expect(header.locator('[aria-current="page"]')).toHaveText(active);
      await expect(header.locator('.header-wallet')).toHaveCount(
        wallet ? 1 : 0,
      );
      const box = await header.boundingBox();
      if (layout) {
        assert.equal(box.x, layout.x);
        assert.equal(box.width, layout.width);
        assert.equal(box.height, layout.height, `${path || '/'} at ${width}px`);
      }
      layout = box;
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `../../.scratch/web-qa/header-${path.replace('/', '') || 'holder'}-${width}.png`,
      });
    }
  }
  await page.goto(new URL('?operator=1', base).href, {
    waitUntil: 'networkidle',
  });
  const navigation = page.getByRole('navigation', {
    name: 'Workspace',
    exact: true,
  });
  await navigation.getByRole('link', { name: 'Transfer', exact: true }).click();
  assert.equal(new URL(page.url()).search, '?operator=1');
  assert.equal(new URL(page.url()).hash, '#transfer');
  await expect(navigation.locator('[aria-current="page"]')).toHaveText(
    'Transfer',
  );
  await navigation.getByRole('link', { name: 'Tokenize', exact: true }).click();
  assert.equal(new URL(page.url()).search, '?operator=1');
  await expect(navigation.locator('[aria-current="page"]')).toHaveText(
    'Tokenize',
  );
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await expect(
    navigation.getByRole('link', { name: 'How it works' }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    'Shared header: 5 routes x 4 widths, navigation, 200% text and hydration passed; no wallet or chain calls.',
  );
} finally {
  await browser.close();
}
