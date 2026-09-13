import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
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
} finally {
  await browser.close();
}
