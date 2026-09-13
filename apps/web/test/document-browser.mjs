import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { loadModule } from './helpers.mjs';
import { exerciseIssuanceRecovery } from './fixtures/issuance-browser.mjs';

// All document, proof, RPC and wallet responses are explicit isolated test fixtures.
// This exercises the production UI/client; it never signs with a real wallet or broadcasts.
const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:4173/');
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const { getIssuerPermitDigest } = await loadModule(
  '../../../packages/domain/src/index.ts',
);
const { ISSUANCE_GATE_ABI: gateAbi, toIssueArgs } = await loadModule(
  '../../../packages/issuance/src/abi.ts',
);
const fixture = await createFixture();
const screenshots = new URL('../../../.scratch/web-qa/', import.meta.url);
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  await exerciseIssuanceRecovery({
    browser,
    base,
    fixture,
    gateAbi,
    toIssueArgs,
    permitDigest: getIssuerPermitDigest(
      fixture.bundle.request,
      fixture.bundle.permit,
    ),
    screenshots,
    start: 'unknown',
    outcome: 'confirmed',
    documentFlow: true,
  });
  const page = await browser.newPage();
  const mutations = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base.origin || request.method() !== 'GET') {
      mutations.push(request.method());
      return route.abort();
    }
    if (url.pathname === '/deployment.json')
      return route.fulfill({ json: fixture.deployment });
    if (url.pathname === '/api/config')
      return route.fulfill({
        status: 503,
        json: { error: { code: 'service_unavailable' } },
      });
    return route.continue();
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('ultratokenizer.document-job.v1', 'invalid json');
  });
  await page.goto(base.href, { waitUntil: 'networkidle' });
  const recovery = page.getByRole('region', {
    name: 'Unreadable saved request',
  });
  await expect(recovery).toBeVisible();
  const remove = recovery.getByRole('button', {
    name: 'Remove unreadable record',
  });
  await expect(remove).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Upload signed PDF' }),
  ).toHaveCount(0);
  await recovery.getByRole('checkbox').check();
  await remove.click();
  await expect(recovery).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Upload signed PDF' }),
  ).toBeEnabled();
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem('ultratokenizer.document-job.v1'),
    ),
    null,
  );
  assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    'Unreadable saved request requires acknowledgment; removal restores upload without network mutation.',
  );
} finally {
  await browser.close();
}
