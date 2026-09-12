// Production browser checks. Test fixtures never provide a runtime success fallback.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { loadModule } from './helpers.mjs';
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173/';
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const fixture = await createFixture();
const { auditIssuanceReceipt } = await loadModule(
  '../../../packages/audit/src/index.ts',
);
const checked = {
  receipt: fixture.receipt,
  report: await auditIssuanceReceipt(
    JSON.stringify(fixture.receipt),
    fixture.policy,
  ),
  execution: 'dedicated-worker',
  mode: 'offline',
};
const oldSample = await readFile(
  new URL('./fixtures/sample-receipt-v1.json', import.meta.url),
);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
  headless: true,
});
const upload = async (page, label, value, filename = 'input.json') => {
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
  await page.getByLabel(label, { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
  });
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
};
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
  const hydrationWarnings = [];
  const workerUrls = [];
  const rpcCalls = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/hydration(?:_mismatch)?/i.test(message.text()))
      hydrationWarnings.push(message.text());
  });
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
    if (url.origin !== new URL(base).origin) {
      externalRequests.push(url.href);
      return route.abort();
    }
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
    page.getByRole('heading', { name: 'Your gold. A new form.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mint 1.000 g' })).toHaveCount(
    0,
  );
  const headerWallet = page.locator('.header-wallet');
  await expect(headerWallet).toHaveText('Connect wallet');
  await expect(headerWallet).toBeDisabled();
  // Future actions are not rendered before their prerequisites.
  await expect(
    page.getByRole('button', { name: 'Sign mint request', exact: true }),
  ).toHaveCount(0);
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
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const stillTransform = await page
    .locator('.artifact-body')
    .evaluate((element) => getComputedStyle(element).transform);
  const motionScene = await page.locator('.proof-object').boundingBox();
  await page.mouse.move(motionScene.x + 30, motionScene.y + 50);
  await expect
    .poll(() =>
      page
        .locator('.artifact-body')
        .evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(stillTransform);
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.artifact-lift')).toHaveCSS(
    'animation-name',
    'none',
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await noOverflow(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByLabel('Import deployment configuration', { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.getByRole('button', { name: 'Close network setup' }).click();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: new URL(
      '../../../.scratch/web-qa/issuance-large-text.png',
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('font-size');
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await noOverflow(page);
  const firstUpload = await page
    .getByRole('button', { name: 'Check availability', exact: true })
    .boundingBox();
  assert.ok(
    firstUpload && firstUpload.y + firstUpload.height <= 640,
    'Mobile availability action starts in the first viewport',
  );
  const sceneBox = await page.locator('.proof-object').boundingBox();
  const paperBox = await page.locator('.artifact-body').boundingBox();
  const captionBox = await page.locator('.artifact-caption').boundingBox();
  assert.ok(
    sceneBox &&
      paperBox &&
      captionBox &&
      paperBox.y >= sceneBox.y &&
      paperBox.y + paperBox.height < captionBox.y,
    'The mobile document is fully visible above its caption',
  );
  await page.setViewportSize({ width: 1280, height: 900 });

  const deployment = {
    ...fixture.deployment,
    rpcUrl: new URL('rpc-test', base).href,
  };
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByLabel('Import deployment configuration', { exact: true })
    .setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{}'),
    });
  await expect(page.locator('.setup-dialog .inline-error')).toBeVisible();
  await upload(page, 'Import deployment configuration', deployment);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#issuance-title')).toBeFocused();
  await upload(page, 'Import issuance bundle', fixture.bundle);
  await expect(page.locator('.proof-sheet')).toContainText('1.000 g');
  await expect(page.locator('.proof-object')).toHaveAttribute(
    'data-state',
    'loaded',
  );
  await expect(page.locator('.artifact-seal')).not.toHaveClass(/visible/);
  await expect(
    page.locator('.engine-stage input[inputmode="decimal"]'),
  ).toHaveCount(0);
  assert.deepEqual(rpcCalls, []);
  await page
    .locator('.stage-action')
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click();
  await expect(page.locator('.stage-action .inline-error')).toContainText(
    'do not match',
  );
  assert(rpcCalls.includes('eth_getCode'));
  await expect(
    page.getByRole('button', {
      name: 'Sign mint request',
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
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
    page.getByRole('heading', { name: 'Verify a receipt' }),
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
  await expect(page.locator('.audit-check-details')).not.toHaveAttribute(
    'open',
  );
  await expect(page.locator('.audit-check-summary')).toContainText(
    `${checked.report.checks.filter((check) => check.status === 'verified').length} Passed`,
  );
  await expect(page.locator('.audit-limitations')).toContainText(
    'backing, and redemption remain unverified',
  );
  await page.locator('.audit-check-details > summary').click();
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
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save audit report' }).click();
  const savedReport = await reportDownload;
  assert.equal(
    savedReport.suggestedFilename(),
    'ultratokenizer-audit-report.json',
  );
  const savedReportPath = await savedReport.path();
  assert.ok(savedReportPath);
  assert.deepEqual(
    JSON.parse(await readFile(savedReportPath, 'utf8')),
    checked.report,
  );
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
    name: /Online proof check/,
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
  await page.locator('.audit-check-details > summary').click();
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
  await expect(page.locator('.audit-check-details')).toHaveAttribute('open');
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

  // A bad worker reply must settle as a recoverable failure before it reaches rendering.
  for (const mutation of [
    'null-check',
    'unsafe-receipt',
    'missing-history',
    'offline-proof-verified',
  ]) {
    const malformed = structuredClone(checked);
    if (mutation === 'null-check') malformed.report.checks = [null];
    else if (mutation === 'unsafe-receipt')
      malformed.receipt = { format: fixture.receipt.format };
    else {
      const id =
        mutation === 'missing-history'
          ? 'historical_registry'
          : 'proof_cryptography';
      if (mutation === 'missing-history')
        malformed.report.checks = malformed.report.checks.filter(
          (check) => check.id !== id,
        );
      else
        malformed.report.checks.find((check) => check.id === id).status =
          'verified';
      malformed.report.missingEvidence =
        malformed.report.missingEvidence.filter((missing) => missing !== id);
    }
    const malformedWorker = (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `onmessage = ({data}) => postMessage({id: data.id, ok: true, result: ${JSON.stringify(malformed)}});`,
      });
    await page.route('**/receipt.worker-*.js', malformedWorker);
    await upload(page, 'Choose issuance receipt JSON', fixture.receipt);
    await page.getByRole('button', { name: 'Check receipt offline' }).click();
    await expect(page.locator('.receipt-read-error')).toContainText(
      'worker stopped unexpectedly',
    );
    await expect(page.locator('.audit-report')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Check receipt offline' }),
    ).toBeEnabled();
    await page.unroute('**/receipt.worker-*.js', malformedWorker);
    await page.getByRole('button', { name: 'Check receipt offline' }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Checks completed · history incomplete',
      }),
    ).toBeVisible();
  }

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
  assert.deepEqual(hydrationWarnings, []);
  assert.deepEqual(externalRequests, []);

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
    unsupported.getByText(/No browser wallet detected/),
  ).toBeVisible();
  await expect(
    unsupported
      .locator('.stage-action')
      .getByRole('button', { name: 'Connect wallet', exact: true }),
  ).toBeDisabled();
  await expect(
    unsupported.getByRole('button', { name: 'Mint 1.000 g' }),
  ).toHaveCount(0);
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
