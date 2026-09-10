import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
} from 'viem';

/** Real browser/client boundary, with a test-only wallet and intercepted JSON-RPC. */
export async function exerciseTokenRecovery({
  browser,
  base,
  fixture,
  tokenAbi,
  screenshots,
  kind,
}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const policy = fixture.deployment.auditPolicy;
  const account = fixture.bundle.request.recipient;
  const recipient = '0x9999999999999999999999999999999999999999';
  const changedAccount = '0x8888888888888888888888888888888888888888';
  const goodHash = `0x${'ab'.repeat(32)}`;
  const badHash = `0x${'ac'.repeat(32)}`;
  const blockHash = `0x${'ad'.repeat(32)}`;
  const callData = encodeFunctionData({
    abi: tokenAbi,
    functionName: kind === 'transfer' ? 'transfer' : 'associate',
    ...(kind === 'transfer' ? { args: [recipient, 125n] } : {}),
  });
  const errors = [];
  const rpcCalls = [];
  const unexpectedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === fixture.deployment.rpcUrl && request.method() === 'POST') {
      const call = request.postDataJSON();
      rpcCalls.push(call);
      let result;
      if (call.method === 'eth_chainId') result = '0x128';
      else if (call.method === 'eth_getCode')
        result =
          call.params[0].toLowerCase() === policy.gate.toLowerCase()
            ? '0x60006000'
            : '0x60016000';
      else if (call.method === 'eth_getTransactionCount') result = '0x7';
      else if (call.method === 'eth_getBlockByNumber')
        result = {
          number: '0x64',
          hash: blockHash,
          timestamp: '0x713fb300',
          transactions: [],
        };
      else if (call.method === 'eth_blockNumber') result = '0x65';
      else if (call.method === 'eth_call') {
        const decoded = decodeFunctionData({
          abi: tokenAbi,
          data: call.params[0].data,
        });
        const functionName = decoded.functionName;
        assert.ok(
          ['decimals', 'transfer', 'associate', 'isAssociated'].includes(
            functionName,
          ),
        );
        if (functionName === 'isAssociated') {
          assert.equal(call.params[1], '0x64');
          assert.equal(
            call.params[0].from.toLowerCase(),
            account.toLowerCase(),
          );
        }
        result = encodeFunctionResult({
          abi: tokenAbi,
          functionName,
          result:
            functionName === 'decimals'
              ? 3
              : functionName === 'associate'
                ? 22n
                : true,
        });
      } else if (call.method === 'eth_getTransactionReceipt') {
        const hash = call.params[0];
        assert.ok(hash === goodHash || hash === badHash);
        result = {
          transactionHash: hash,
          blockHash,
          blockNumber: '0x64',
          transactionIndex: '0x0',
          from: account,
          to: policy.token,
          contractAddress: null,
          cumulativeGasUsed: '0x100',
          gasUsed: '0x100',
          effectiveGasPrice: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          type: '0x0',
          logs:
            kind === 'transfer'
              ? [
                  {
                    address: policy.token,
                    topics: encodeEventTopics({
                      abi: tokenAbi,
                      eventName: 'Transfer',
                      args: { from: account, to: recipient },
                    }),
                    data: encodeAbiParameters([{ type: 'uint256' }], [125n]),
                    blockHash,
                    blockNumber: '0x64',
                    transactionHash: hash,
                    transactionIndex: '0x0',
                    logIndex: '0x0',
                    removed: false,
                  },
                ]
              : [],
        };
      } else if (call.method === 'eth_getTransactionByHash') {
        const hash = call.params[0];
        result = {
          hash,
          blockHash,
          blockNumber: '0x64',
          transactionIndex: '0x0',
          from: account,
          to: policy.token,
          value: '0x0',
          input: callData,
          nonce: hash === goodHash ? '0x7' : '0x6',
          gas: '0x100000',
          gasPrice: '0x1',
          type: '0x0',
          v: '0x1b',
          r: `0x${'01'.repeat(32)}`,
          s: `0x${'02'.repeat(32)}`,
        };
      } else throw new Error(`Unexpected RPC method: ${call.method}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result }),
      });
      return;
    }
    if (url.origin === base.origin && request.method() === 'GET') {
      await route.continue();
      return;
    }
    unexpectedRequests.push({
      origin: url.origin,
      path: url.pathname,
      method: request.method(),
    });
    await route.abort();
  });
  await page.addInitScript(
    ({ initialAccount }) => {
      const listeners = new Map();
      window.tokenWallet = {
        account: initialAccount,
        chain: '0x128',
        sends: [],
        methods: [],
      };
      window.changeTokenWallet = (nextAccount, chain) => {
        window.tokenWallet.account = nextAccount;
        window.tokenWallet.chain = chain;
        for (const callback of listeners.get('accountsChanged') ?? [])
          callback([nextAccount]);
        for (const callback of listeners.get('chainChanged') ?? [])
          callback(chain);
      };
      window.ethereum = {
        on(event, listener) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(listener);
        },
        removeListener(event, listener) {
          listeners.get(event)?.delete(listener);
        },
        async request({ method, params }) {
          window.tokenWallet.methods.push(method);
          if (method === 'eth_chainId') return window.tokenWallet.chain;
          if (method === 'eth_accounts' || method === 'eth_requestAccounts')
            return [window.tokenWallet.account];
          if (method === 'eth_sendTransaction') {
            window.tokenWallet.sends.push(params[0]);
            throw new Error('Synthetic wallet disconnected after broadcast');
          }
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      };
    },
    { initialAccount: account },
  );
  try {
    await page.goto(base.href, { waitUntil: 'networkidle' });
    for (const [label, value] of [
      ['Import deployment configuration', fixture.deployment],
      ['Import issuance bundle', fixture.bundle],
    ]) {
      await page.getByLabel(label, { exact: true }).setInputFiles({
        name: 'synthetic-token-recovery.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(value)),
      });
    }
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Associate this token', exact: true }),
    ).toBeEnabled();
    if (kind === 'transfer') {
      await page
        .getByLabel('Transfer recipient', { exact: true })
        .fill(recipient);
      await page
        .getByLabel('Transfer amount (g)', { exact: true })
        .fill('0.125');
      await page
        .getByRole('button', { name: 'Review transfer in wallet', exact: true })
        .click();
    } else
      await page
        .getByRole('button', { name: 'Associate this token', exact: true })
        .click();
    await expect(
      page.getByRole('region', { name: 'Unknown wallet outcome' }),
    ).toBeVisible();
    const frozen = page.getByLabel('Frozen token intent', { exact: true });
    await expect(frozen).toContainText(account);
    if (kind === 'transfer') {
      await expect(frozen).toContainText('0.125 g transfer');
      await expect(frozen).toContainText(recipient);
      await page
        .getByLabel('Transfer recipient', { exact: true })
        .fill(changedAccount);
      await page
        .getByLabel('Transfer amount (g)', { exact: true })
        .fill('0.999');
      await expect(frozen).toContainText('0.125 g transfer');
      await expect(frozen).not.toContainText('0.999');
    }
    await page.evaluate(
      ({ changedAccount }) => window.changeTokenWallet(changedAccount, '0x1'),
      { changedAccount },
    );
    const beforeRecovery = await page.evaluate(() =>
      structuredClone(window.tokenWallet),
    );
    assert.equal(beforeRecovery.sends.length, 1);
    assert.equal(beforeRecovery.sends[0].data, callData);
    assert.equal(beforeRecovery.sends[0].nonce, '0x7');
    for (const malformed of ['0x1234', `0x${'00'.repeat(32)}`]) {
      const readCount = rpcCalls.length;
      await page
        .getByLabel('Transaction hash from wallet', { exact: true })
        .fill(malformed);
      await page
        .getByRole('button', { name: 'Reconcile wallet hash', exact: true })
        .click();
      await expect(
        page.locator('.issuance-controls .inline-error'),
      ).toContainText('full nonzero 32-byte transaction hash');
      assert.equal(rpcCalls.length, readCount);
      await expect(
        page.getByRole('region', { name: 'Unknown wallet outcome' }),
      ).toBeVisible();
    }
    await page
      .getByLabel('Transaction hash from wallet', { exact: true })
      .fill(badHash);
    await page
      .getByRole('button', { name: 'Reconcile wallet hash', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Reconcile wallet hash', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('region', { name: 'Unknown wallet outcome' }),
    ).toBeVisible();
    await expect(frozen).toContainText(account);
    await expect(page.locator('.token-workspace')).not.toContainText(
      '· confirmed',
    );
    await page
      .getByLabel('Transaction hash from wallet', { exact: true })
      .fill(goodHash);
    await page
      .getByRole('button', { name: 'Reconcile wallet hash', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Unknown wallet outcome' }),
    ).toHaveCount(0);
    await expect(page.locator('.token-workspace')).toContainText(
      `${kind === 'transfer' ? 'Transfer' : 'Association'} · confirmed`,
    );
    await expect(page.locator('.token-workspace')).toContainText(goodHash);
    await expect(page.locator('.claim-quantity')).toHaveText('1.000g');
    assert.deepEqual(
      await page.evaluate(() => window.tokenWallet.methods),
      beforeRecovery.methods,
    );
    assert.equal(await page.evaluate(() => window.tokenWallet.sends.length), 1);
    assert.ok(
      rpcCalls.filter((call) => call.method === 'eth_getTransactionByHash')
        .length >= 2,
    );
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(errors, []);
    if (kind === 'transfer') {
      await page.screenshot({
        path: new URL('token-recovery-desktop.png', screenshots).pathname,
        fullPage: true,
      });
      await page.setViewportSize({ width: 320, height: 640 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: new URL('token-recovery-mobile.png', screenshots).pathname,
        fullPage: true,
      });
    }
    console.log(
      `Token browser recovery passed: ${kind}, lost hash, account/chain change, old nonce rejected, exact intent confirmed; one synthetic send, no external RPC.`,
    );
  } finally {
    await page.close();
  }
}
