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
    await expect(
      page.getByRole('link', { name: 'Download all 50 PDFs' }),
    ).toBeVisible();
    const guideButton = page.getByRole('button', { name: 'Try it' });
    await expect(guideButton).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Download sample' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Request proof budget/ }),
    ).toHaveAttribute('href', 'https://t.me/yamanc');
    await guideButton.click();
    await expect(
      page.getByRole('link', { name: 'Download sample' }),
    ).toBeHidden();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(
      page.getByRole('link', { name: 'Download sample' }),
    ).toBeHidden();
    await expect(page.getByText('What the demo establishes')).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `judge page overflowed at ${width}px`,
    );
    await page.evaluate(() => sessionStorage.clear());
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
  const catalogResponse = await page.request.get(
    new URL('jury/documents/catalog.json', base).href,
  );
  assert.equal(catalogResponse.status(), 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.format, 'ultratokenizer.public-jury-documents.v1');
  assert.equal(catalog.documents.length, 50);
  assert.equal(new Set(catalog.documents.map((item) => item.sha256)).size, 50);
  assert.equal(catalog.documents[7].presenterDocument, true);
  const archive = await page.request.get(
    new URL('jury/ultratokenizer-jury-documents.zip', base).href,
  );
  assert.equal(archive.status(), 200);
  assert((await archive.body()).length > 100_000);
  assert.deepEqual(errors, []);
  console.log(
    'Judge walkthrough: desktop/mobile layout, calls to action and exact Demo 08 download passed.',
  );
} finally {
  await browser.close();
}
