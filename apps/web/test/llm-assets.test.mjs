import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildLlmAssets } from '../scripts/generate-llm-assets.mjs';
import { SITE_ORIGIN, SITE_PAGES } from '../src/lib/site-meta.js';

const deployment = JSON.parse(
  await readFile(new URL('../static/deployment.json', import.meta.url), 'utf8'),
);
const discovery = JSON.parse(
  await readFile(new URL('../static/discovery.json', import.meta.url), 'utf8'),
);
const assets = buildLlmAssets(deployment, discovery);
const full = assets['llms-full.txt'];

test('publishes an index, a full corpus and one mirror per route', () => {
  const expected = [
    'sitemap.xml',
    'llms.txt',
    'llms-full.txt',
    ...SITE_PAGES.map((page) => page.markdown.slice(1)),
  ];
  deepStrictEqual(Object.keys(assets).sort(), expected.sort());
});

test('the sitemap lists every canonical route exactly once', () => {
  const sitemap = assets['sitemap.xml'];
  for (const page of SITE_PAGES) {
    const loc = `<loc>${SITE_ORIGIN}${page.route}</loc>`;
    strictEqual(sitemap.split(loc).length - 1, 1, page.route);
  }
  strictEqual(
    sitemap.split('<url>').length - 1,
    SITE_PAGES.length,
    'no extra sitemap entries',
  );
});

test('canonical routes keep the trailing slash the app enforces', () => {
  for (const page of SITE_PAGES) {
    ok(page.route.endsWith('/'), page.route);
  }
});

test('deployed addresses come from the configuration, never from prose', () => {
  const policy = deployment.auditPolicy;
  for (const address of [
    policy.gate,
    policy.token,
    policy.verifierAddress,
    deployment.backend.adapter.address,
    deployment.backend.facets.ControlListFacet.address,
    discovery.identityRegistry.address,
  ]) {
    ok(full.includes(address), `missing ${address}`);
  }
  ok(full.includes(policy.programVKey), 'missing program verification key');
  ok(
    full.includes(deployment.backend.upstreamCommit),
    'missing the pinned ATS upstream commit',
  );
});

test('the corpus states the Hedera track requirements and the evidence', () => {
  for (const phrase of [
    'Asset Tokenization Studio',
    'Hedera testnet',
    'Public GitHub repo',
    'lifecycle operation',
    `chain ID ${deployment.auditPolicy.chainId}`,
  ]) {
    ok(full.includes(phrase), `missing ${phrase}`);
  }
});

test('the corpus never overstates proof acceptance or a completed mint', () => {
  // The repository draws these boundaries in the product wording; a generated
  // corpus is the easiest place to lose them, so they are asserted here.
  const forbidden = [
    /proof (?:was |is )?accepted/i,
    /successfully minted/i,
    /mint(?:ing)? (?:is )?complete[d]?\b/i,
    /audited by/i,
    /regulat(?:ed|ory) approval/i,
    /physically backed/i,
    /real gold/i,
  ];
  for (const pattern of forbidden) {
    for (const [name, contents] of Object.entries(assets)) {
      strictEqual(pattern.test(contents), false, `${name} matched ${pattern}`);
    }
  }
});

test('the corpus keeps the explicit non-claims', () => {
  for (const phrase of [
    'synthetic',
    'not a security audit',
    'do not authorise a mint',
    'A wallet signature is not a transaction',
  ]) {
    ok(full.includes(phrase), `missing boundary: ${phrase}`);
  }
});

test('every page mirror is self-describing and links the full corpus', () => {
  for (const page of SITE_PAGES) {
    const mirror = assets[page.markdown.slice(1)];
    match(mirror, /^# /);
    ok(mirror.includes(`${SITE_ORIGIN}${page.route}`), page.route);
    ok(mirror.includes(`${SITE_ORIGIN}/llms-full.txt`), page.route);
    for (const fact of page.facts) ok(mirror.includes(fact), page.route);
  }
});

test('the index points at the machine-readable deployment data', () => {
  const index = assets['llms.txt'];
  for (const path of [
    '/deployment.json',
    '/discovery.json',
    '/sitemap.xml',
    '/llms-full.txt',
  ]) {
    ok(index.includes(path), `missing ${path}`);
  }
});

test('a checkout without operator deployment files still builds a corpus', () => {
  // deployment.json and discovery.json are operator-provided and Git-ignored,
  // so the build must not invent addresses when they are absent.
  const bare = buildLlmAssets(null, null);
  deepStrictEqual(Object.keys(bare).sort(), Object.keys(assets).sort());
  const bareFull = bare['llms-full.txt'];
  ok(bareFull.includes('no deployment configuration'));
  strictEqual(bareFull.includes(deployment.auditPolicy.gate), false);
  strictEqual(bare['llms.txt'].includes(deployment.auditPolicy.gate), false);
  for (const page of SITE_PAGES) {
    strictEqual(bare[page.markdown.slice(1)], assets[page.markdown.slice(1)]);
  }
});
