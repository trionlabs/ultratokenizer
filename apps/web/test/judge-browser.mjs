import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/health', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'local-demo-service' }),
    }),
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ readiness: { canStart: true } }),
    }),
  );

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(new URL('judge/', base).href, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Review the claim. Follow the proof. Check the chain.',
    );
    await expect(
      page.getByRole('link', { name: 'Download Demo 08 PDF' }),
    ).toBeVisible();
    await expect(page.getByText('What the demo establishes')).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `judge page overflowed at ${width}px`,
    );
  }

  const response = await page.request.get(
    new URL('jury/08-gold.pdf', base).href,
  );
  assert.equal(response.status(), 200);
  const bytes = await response.body();
  assert(bytes.subarray(0, 9).equals(Buffer.from('%PDF-1.7\n')));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '595483b171e2214304251ce54b07e540702f03d14ef6d3fdab6a833bffbc89de',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Judge walkthrough: desktop/mobile layout, calls to action and exact Demo 08 download passed.',
  );
} finally {
  await browser.close();
}
