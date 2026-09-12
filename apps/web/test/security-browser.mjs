// Actual static build + the shipped HTTP headers. All nonlocal RPC is intercepted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { loadModule } from './helpers.mjs';

const build = resolve(fileURLToPath(new URL('../build/', import.meta.url)));
const headersText = await readFile(
  new URL('../build/_headers', import.meta.url),
  'utf8',
);
const headers = Object.fromEntries(
  headersText
    .split('\n')
    .filter((line) => /^\s+\S+:/.test(line))
    .map((line) => {
      const split = line.indexOf(':');
      return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
    }),
);
const servers = [];
async function serve(withHeaders) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/embed' || pathname === '/embed-alias') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          `<iframe title="Embedded application" src="${pathname === '/embed-alias' ? `http://${request.headers.host}//untrusted.invalid/` : '/'}"></iframe>`,
        );
        return;
      }
      const path = resolve(
        build,
        `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`,
      );
      if (!path.startsWith(`${build}/`)) throw new Error();
      const body = await readFile(path);
      response.writeHead(200, {
        ...(withHeaders ? headers : {}),
        'Content-Type':
          {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
          }[extname(path)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return new URL(`http://127.0.0.1:${server.address().port}/`);
}
const protectedBase = await serve(true);
const unprotectedBase = await serve(false);
const { createFixture } = await loadModule('./fixtures/issuance.ts');
const fixture = await createFixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
});
const failures = [];
async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
const contexts = [];
async function pageFor(base, javaScriptEnabled = true) {
  const context = await browser.newContext({ javaScriptEnabled });
  contexts.push(context);
  const page = await context.newPage();
  const external = [];
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== base.origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  return { page, external };
}
const upload = async (page, label, value) => {
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
  await page.getByLabel(label, { exact: true }).setInputFiles({
    name: 'synthetic-policy-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
};
try {
  for (const kind of ['deployment', 'ENS', 'verification']) {
    await check(
      `HTTP IPv6 ${kind} input fails before browser transport`,
      async () => {
        const { page, external } = await pageFor(protectedBase);
        await page.addInitScript(() => {
          window.createdWorkers = 0;
          const BrowserWorker = window.Worker;
          window.Worker = class extends BrowserWorker {
            constructor(...args) {
              super(...args);
              window.createdWorkers++;
            }
          };
        });
        const ipv6 = 'http://[::1]:8545/';
        const guidance = 'Use HTTPS, or HTTP at localhost or 127.0.0.1.';
        await page.goto(
          new URL(kind === 'verification' ? 'verify/' : '', protectedBase).href,
          { waitUntil: 'networkidle' },
        );
        if (kind === 'verification') {
          await upload(page, 'Choose issuance receipt JSON', fixture.receipt);
          await upload(
            page,
            'Choose independent audit policy JSON',
            fixture.policy,
          );
          await page
            .getByRole('checkbox', { name: /Online proof check/ })
            .check();
          await page.getByLabel('Proof verifier RPC URL').fill(ipv6);
          await page
            .getByRole('button', { name: 'Check receipt + online proof' })
            .click();
          await expect(page.locator('.receipt-read-error')).toContainText(
            guidance,
          );
          assert.equal(await page.evaluate(() => window.createdWorkers), 0);
        } else {
          await upload(
            page,
            'Import deployment configuration',
            fixture.deployment,
          );
          await upload(page, 'Import issuance bundle', fixture.bundle);
          if (kind === 'deployment') {
            await upload(page, 'Import deployment configuration', {
              ...fixture.deployment,
              rpcUrl: ipv6,
            });
            await expect(
              page.locator('.stage-action .inline-error'),
            ).toContainText(guidance);
            await expect(page.locator('.proof-sheet')).toContainText('1.000 g');
          } else {
            await page
              .getByRole('link', { name: 'Transfer', exact: true })
              .click();
            await page
              .getByLabel('Transfer recipient', { exact: true })
              .fill('alice.eth');
            await page
              .getByLabel('Ethereum RPC for ENS', { exact: true })
              .fill(ipv6);
            await page
              .getByRole('button', {
                name: 'Resolve ENS recipient',
                exact: true,
              })
              .click();
            await expect(
              page.locator('.transfer-card .inline-error'),
            ).toContainText(guidance);
          }
        }
        assert.deepEqual(external, []);
      },
    );
  }
  await check('idle routes make no third-party requests', async () => {
    const { page, external } = await pageFor(protectedBase);
    for (const route of ['', 'verify/']) {
      await page.goto(new URL(route, protectedBase).href, {
        waitUntil: 'networkidle',
      });
      await expect(
        page.getByRole('heading', {
          name: route ? 'Verify a receipt' : 'Your gold. A new form.',
        }),
      ).toBeVisible();
    }
    assert.deepEqual(external, []);
  });
  for (const origin of [
    'https://rpc.synthetic.invalid',
    'http://localhost:18545',
    'http://127.0.0.1:18546',
  ]) {
    await check(
      `header and meta policies permit explicit RPC and ENS at ${origin}`,
      async () => {
        const { page } = await pageFor(protectedBase);
        const calls = [];
        const rpc = `${origin}/hedera`;
        const ens = `${origin}/ethereum`;
        await page.route(
          (url) => url.href === rpc || url.href === ens,
          (route) => {
            const call = route.request().postDataJSON();
            calls.push({ url: route.request().url(), method: call.method });
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: call.id,
                result:
                  call.method === 'eth_chainId'
                    ? route.request().url() === rpc
                      ? '0x128'
                      : '0x1'
                    : call.method === 'eth_blockNumber'
                      ? '0x64'
                      : '0x',
              }),
            });
          },
        );
        await page.addInitScript((address) => {
          window.ethereum = {
            request: async ({ method }) =>
              method === 'eth_chainId'
                ? '0x128'
                : ['eth_accounts', 'eth_requestAccounts'].includes(method)
                  ? [address]
                  : Promise.reject(new Error('No sends in this test')),
          };
        }, fixture.bundle.request.recipient);
        const response = await page.goto(protectedBase.href, {
          waitUntil: 'networkidle',
        });
        assert.equal(
          response.headers()['content-security-policy'],
          headers['Content-Security-Policy'],
        );
        await upload(page, 'Import deployment configuration', {
          ...fixture.deployment,
          rpcUrl: rpc,
        });
        await upload(page, 'Import issuance bundle', fixture.bundle);
        assert.equal(calls.length, 0);
        await page
          .locator('.stage-action')
          .getByRole('button', { name: 'Connect wallet', exact: true })
          .click();
        await expect(page.locator('.stage-action .inline-error')).toBeVisible();
        assert(
          calls.some(
            (call) => call.url === rpc && call.method === 'eth_getCode',
          ),
          'Explicit imported RPC must reach the transport',
        );
        await page.getByRole('link', { name: 'Transfer', exact: true }).click();
        await page
          .getByLabel('Transfer recipient', { exact: true })
          .fill('alice.eth');
        await page
          .getByLabel('Ethereum RPC for ENS', { exact: true })
          .fill(ens);
        await page
          .getByRole('button', { name: 'Resolve ENS recipient', exact: true })
          .click();
        await expect
          .poll(() => calls.some((call) => call.url === ens))
          .toBe(true);
        assert(!calls.some((call) => call.method === 'eth_sendTransaction'));
      },
    );
  }
  await check('HTTP policy denies embedding the application', async () => {
    const { page } = await pageFor(protectedBase);
    await page.goto(new URL('embed', protectedBase).href, {
      waitUntil: 'networkidle',
    });
    assert.equal(
      page.frames().some((frame) => frame.url() === protectedBase.href),
      false,
    );
    await expect(
      page.frameLocator('iframe').locator('input[type=file]'),
    ).toHaveCount(0);
  });
  for (const javaScriptEnabled of [true, false]) {
    await check(
      `without HTTP headers a framed page exposes no controls (JavaScript ${javaScriptEnabled})`,
      async () => {
        const { page } = await pageFor(unprotectedBase, javaScriptEnabled);
        await page.goto(new URL('embed', unprotectedBase).href, {
          waitUntil: 'networkidle',
        });
        const frame = page.frameLocator('iframe');
        await expect(frame.locator('input, button')).toHaveCount(0);
        await expect(
          frame.getByRole('link', { name: 'Open Ultratokenizer directly' }),
        ).toBeVisible();
      },
    );
  }
  await check(
    'headerless direct link remains on this origin for a double-slash path alias',
    async () => {
      const { page, external } = await pageFor(unprotectedBase);
      await page.goto(new URL('embed-alias', unprotectedBase).href, {
        waitUntil: 'networkidle',
      });
      const frame = page.frameLocator('iframe');
      await expect(frame.locator('input, button')).toHaveCount(0);
      const link = frame.getByRole('link', {
        name: 'Open Ultratokenizer directly',
      });
      await expect(link).toHaveAttribute(
        'href',
        `${unprotectedBase.origin}//untrusted.invalid/`,
      );
      assert.equal(
        new URL(await link.getAttribute('href'), unprotectedBase).origin,
        unprotectedBase.origin,
      );
      assert.deepEqual(external, []);
    },
  );
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
}
assert.deepEqual(
  failures,
  [],
  'Static security browser regressions must all pass',
);
console.log(
  'Static security checks passed. RPC responses and wallets were synthetic; no live chain or external network was used.',
);
