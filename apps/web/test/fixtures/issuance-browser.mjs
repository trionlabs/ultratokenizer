import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
} from 'viem';

/** Synthetic RPC evidence exercises the production UI and client; no real proof or broadcast. */
export async function exerciseIssuanceRecovery({
  browser,
  base,
  fixture,
  gateAbi,
  toIssueArgs,
  permitDigest,
  screenshots,
  start,
  outcome,
}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const { bundle, holderSignature } = fixture;
  const { request } = bundle;
  const policy = fixture.deployment.auditPolicy;
  const goodHash = fixture.transactionHash;
  const badHash = `0x${'bb'.repeat(32)}`;
  const originalHash = `0x${'dd'.repeat(32)}`;
  const successHash = `0x${'ee'.repeat(32)}`;
  const foreignSender = '0x9999999999999999999999999999999999999999';
  const blockHash = `0x${'ab'.repeat(32)}`;
  const terms = `0x${'99'.repeat(32)}`;
  const adapter = '0x5555555555555555555555555555555555555555';
  const adapterCode = '0x60026000';
  const digest = fixture.receipt.requestDigest;
  const callData = encodeFunctionData({
    abi: gateAbi,
    functionName: 'issue',
    args: toIssueArgs(bundle, holderSignature),
  });
  const values = {
    issuerKeys: [policy.issuerAddress, BigInt(request.validUntil), false],
    policies: [1n, policy.sourceId, 1n, terms, false],
    rights: [policy.token, adapter, keccak256(adapterCode), terms, false],
    paused: false,
    backingPools: [1000n, 1000n, 0n],
    programs: [
      policy.verifierAddress,
      policy.verifierCodeHash,
      policy.programVKey,
      2,
      false,
    ],
    sourceKeys: [policy.sourceSignerFingerprint, false],
    reservations: [
      request.recipient,
      policy.token,
      1000n,
      0n,
      BigInt(request.validUntil),
      false,
      digest,
      request.claimUsageId,
      false,
    ],
    issue: digest,
  };
  const event = gateAbi.find(
    (item) => item.type === 'event' && item.name === 'Issued',
  );
  const errors = [];
  const unexpectedRequests = [];
  const rpcCalls = [];
  let failNextPreflight = false;
  let originalAvailable = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const rpcRequest = route.request();
    const url = new URL(rpcRequest.url());
    if (
      url.href === fixture.deployment.rpcUrl &&
      rpcRequest.method() === 'POST'
    ) {
      const call = rpcRequest.postDataJSON();
      rpcCalls.push(call);
      let result;
      let error;
      if (call.method === 'eth_chainId') result = '0x128';
      else if (call.method === 'eth_getCode') {
        const address = call.params[0].toLowerCase();
        result =
          address === policy.gate.toLowerCase()
            ? '0x60006000'
            : address === adapter.toLowerCase()
              ? adapterCode
              : '0x60016000';
      } else if (call.method === 'eth_getBlockByNumber') {
        if (failNextPreflight) {
          failNextPreflight = false;
          error = { code: -32000, message: 'Synthetic preflight outage' };
        } else
          result = {
            number: '0x64',
            hash: blockHash,
            timestamp: '0x713fb300',
            transactions: [],
          };
      } else if (call.method === 'eth_blockNumber') result = '0x65';
      else if (call.method === 'eth_call') {
        if (!call.params[0].to) {
          // viem's deployless signature check falls back to real local ECDSA recovery.
          assert.ok(
            [holderSignature, bundle.issuerSignature].some((signature) =>
              call.params[0].data.includes(signature.slice(2)),
            ),
          );
          error = {
            code: 3,
            message: 'Synthetic endpoint has no deployless verifier',
          };
        } else if (
          call.params[0].to.toLowerCase() ===
          policy.verifierAddress.toLowerCase()
        ) {
          result = '0x'; // Test-only verifier response; these four proof bytes are not a ZK proof.
        } else {
          const { functionName } = decodeFunctionData({
            abi: gateAbi,
            data: call.params[0].data,
          });
          assert.ok(Object.hasOwn(values, functionName), functionName);
          result = encodeFunctionResult({
            abi: gateAbi,
            functionName,
            result: values[functionName],
          });
        }
      } else if (call.method === 'eth_getTransactionReceipt') {
        const hash = call.params[0];
        assert.ok(
          [goodHash, badHash, originalHash, successHash].includes(hash),
        );
        const reverted =
          hash !== successHash && (outcome === 'reverted' || hash !== goodHash);
        result = {
          transactionHash: hash,
          blockHash,
          blockNumber: '0x64',
          transactionIndex: '0x0',
          from:
            hash === goodHash && outcome === 'reverted'
              ? foreignSender
              : request.recipient,
          to: policy.gate,
          contractAddress: null,
          cumulativeGasUsed: '0x100',
          gasUsed: '0x100',
          effectiveGasPrice: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          status: reverted ? '0x0' : '0x1',
          type: '0x0',
          logs: reverted
            ? []
            : [
                {
                  address: policy.gate,
                  topics: encodeEventTopics({
                    abi: gateAbi,
                    eventName: 'Issued',
                    args: {
                      requestDigest: digest,
                      requestId: request.requestId,
                      claimUsageId: request.claimUsageId,
                    },
                  }),
                  data: encodeAbiParameters(
                    event.inputs.filter((input) => !input.indexed),
                    [
                      request.issuerId,
                      request.reservationId,
                      request.token,
                      request.recipient,
                      BigInt(request.amount),
                      BigInt(request.policyVersion),
                      BigInt(request.rightsVersion),
                      permitDigest,
                      keccak256(bundle.publicValues),
                      bundle.programVKey,
                    ],
                  ),
                  blockHash,
                  blockNumber: '0x64',
                  transactionHash: hash,
                  transactionIndex: '0x0',
                  logIndex: '0x0',
                  removed: false,
                },
              ],
        };
      } else if (call.method === 'eth_getTransactionByHash') {
        const hash = call.params[0];
        result =
          hash === originalHash && !originalAvailable
            ? null
            : {
                hash,
                blockHash,
                blockNumber: '0x64',
                transactionIndex: '0x0',
                from:
                  hash === goodHash && outcome === 'reverted'
                    ? foreignSender
                    : request.recipient,
                to: policy.gate,
                value: '0x0',
                input: hash === badHash ? '0x' : callData,
                nonce:
                  hash === goodHash && outcome === 'reverted' ? '0x8' : '0x7',
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
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: call.id,
          ...(error ? { error } : { result }),
        }),
      });
      return;
    }
    if (url.origin === base.origin && rpcRequest.method() === 'GET')
      return route.continue();
    if (!(
      url.origin === 'https://fonts.googleapis.com' &&
      url.pathname === '/css2' &&
      rpcRequest.method() === 'GET'
    ))
      unexpectedRequests.push({
        origin: url.origin,
        path: url.pathname,
        method: rpcRequest.method(),
      });
    await route.abort();
  });
  await page.addInitScript(
    ({ account, signature, start, originalHash }) => {
      const listeners = new Map();
      window.issuanceWallet = {
        account,
        chain: '0x128',
        sends: [],
        methods: [],
      };
      window.changeIssuanceWallet = () => {
        window.issuanceWallet.account =
          '0x8888888888888888888888888888888888888888';
        window.issuanceWallet.chain = '0x1';
        for (const callback of listeners.get('accountsChanged') ?? [])
          callback([window.issuanceWallet.account]);
        for (const callback of listeners.get('chainChanged') ?? [])
          callback('0x1');
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
          window.issuanceWallet.methods.push(method);
          if (method === 'eth_chainId') return window.issuanceWallet.chain;
          if (method === 'eth_accounts' || method === 'eth_requestAccounts')
            return [window.issuanceWallet.account];
          if (method === 'eth_signTypedData_v4') return signature;
          if (method === 'eth_sendTransaction') {
            window.issuanceWallet.sends.push(params[0]);
            if (start === 'unknown')
              throw new Error('Synthetic lost wallet response after send');
            return originalHash;
          }
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      };
    },
    {
      account: request.recipient,
      signature: holderSignature,
      start,
      originalHash,
    },
  );
  try {
    await page.goto(base.href, { waitUntil: 'networkidle' });
    for (const [label, value] of [
      ['Import deployment configuration', fixture.deployment],
      ['Import issuance bundle', bundle],
    ])
      await page.getByLabel(label, { exact: true }).setInputFiles({
        name: 'synthetic-issuance-recovery.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(value)),
      });
    for (const name of ['Connect', 'Check bundle'])
      await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.check-row')).toContainText(
      'Accepted by the pinned verifier',
    );
    await page.getByRole('checkbox').check();
    await page
      .getByRole('button', { name: 'Sign request', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Check before sending', exact: true })
      .click();
    const issue = page.getByRole('button', {
      name: 'Issue full claim',
      exact: true,
    });
    await expect(issue).toBeEnabled();
    if (start === 'unknown' && outcome === 'confirmed') {
      failNextPreflight = true;
      await issue.click();
      await expect(
        page.locator('.issuance-controls .inline-error'),
      ).toContainText('Issuance checks could not complete');
      await expect(
        page.getByRole('region', { name: 'Unknown wallet outcome' }),
      ).toHaveCount(0);
      assert.equal(
        await page.evaluate(() => window.issuanceWallet.sends.length),
        0,
      );
      await expect(issue).toBeEnabled();
    }
    await issue.click();
    const transaction = page.getByRole('region', {
      name: 'Issuance transaction',
      exact: true,
    });
    if (start === 'unknown')
      await expect(
        page.getByRole('region', { name: 'Unknown wallet outcome' }),
      ).toBeVisible();
    else {
      await expect(transaction).toContainText(originalHash);
      await page
        .getByRole('button', { name: 'Check transaction outcome', exact: true })
        .click();
      await expect(transaction).toContainText('unresolved');
      originalAvailable = true;
    }
    await page.evaluate(() => window.changeIssuanceWallet());
    const beforeRecovery = await page.evaluate(() =>
      structuredClone(window.issuanceWallet),
    );
    assert.equal(beforeRecovery.sends.length, 1);
    assert.equal(beforeRecovery.sends[0].data, callData);
    const input = page.getByLabel(
      start === 'unknown'
        ? 'Transaction hash from wallet'
        : 'Recovered issuance transaction hash',
      { exact: true },
    );
    const reconcile = page.getByRole('button', {
      name:
        start === 'unknown'
          ? 'Reconcile wallet hash'
          : 'Reconcile recovered issuance hash',
      exact: true,
    });
    await input.fill(badHash);
    await reconcile.click();
    await expect(reconcile).toBeEnabled();
    await expect(
      page.locator('.issuance-controls .inline-error'),
    ).toContainText('does not contain the exact expected issuance');
    await expect(
      page.locator('.issuance-controls .inline-error'),
    ).not.toContainText('full transaction hash');
    if (start === 'unknown') await expect(transaction).toHaveCount(0);
    else await expect(transaction).toContainText(originalHash);
    await expect(
      page.getByRole('button', { name: 'Save issuance receipt', exact: true }),
    ).toHaveCount(0);
    if (start === 'unresolved' && outcome === 'confirmed') {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.screenshot({
        path: new URL('issuance-unresolved-mobile.png', screenshots).pathname,
        fullPage: true,
      });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await input.fill(goodHash);
    await reconcile.click();
    let finalHash = goodHash;
    let finalOutcome = outcome;
    if (outcome === 'reverted') {
      await expect(reconcile).toBeEnabled();
      await expect(
        page.locator('.issuance-controls .inline-error'),
      ).toContainText('does not identify the original wallet submission');
      if (start === 'unknown') await expect(transaction).toHaveCount(0);
      else {
        await expect(transaction.locator('.status-pill')).toHaveText(
          'unresolved',
        );
        await expect(transaction).toContainText(originalHash);
      }
      await expect(
        page.getByRole('button', { name: 'Issue full claim', exact: true }),
      ).toBeDisabled();
      // A foreign sender/nonce's exact-call revert cannot settle the original send.
      finalHash = start === 'unknown' ? successHash : originalHash;
      finalOutcome = start === 'unknown' ? 'confirmed' : 'reverted';
      await input.fill(finalHash);
      await reconcile.click();
    }
    await expect(transaction.locator('.status-pill')).toHaveText(finalOutcome);
    await expect(transaction).toContainText(finalHash);
    await expect(
      page.getByRole('region', { name: 'Unknown wallet outcome' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Save issuance receipt', exact: true }),
    ).toHaveCount(finalOutcome === 'confirmed' ? 1 : 0);
    if (finalOutcome === 'reverted') {
      await expect(transaction).toContainText(
        'This transaction did not issue tokens.',
      );
      await expect(
        page.getByRole('button', {
          name: 'Check transaction outcome',
          exact: true,
        }),
      ).toHaveCount(0);
    }
    assert.deepEqual(
      await page.evaluate(() => window.issuanceWallet.methods),
      beforeRecovery.methods,
    );
    assert.equal(
      await page.evaluate(() => window.issuanceWallet.sends.length),
      1,
    );
    assert.ok(
      rpcCalls.some(
        (call) =>
          call.method === 'eth_getTransactionByHash' &&
          call.params[0] === badHash,
      ),
    );
    assert.ok(
      rpcCalls.some(
        (call) =>
          call.method === 'eth_getTransactionByHash' &&
          call.params[0] === goodHash,
      ),
    );
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(errors, []);
    if (start === 'unresolved' && outcome === 'confirmed') {
      await page.screenshot({
        path: new URL('issuance-recovery-desktop.png', screenshots).pathname,
        fullPage: true,
      });
      await page.setViewportSize({ width: 320, height: 640 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: new URL('issuance-recovery-mobile.png', screenshots).pathname,
        fullPage: true,
      });
    }
    console.log(
      `Issuance browser recovery passed: ${start}, candidate ${outcome} → ${finalOutcome}; unrelated calldata rejected, foreign exact-call revert preserves ambiguity, original hash or successful issuance reconciled; one synthetic send, no external RPC.`,
    );
  } finally {
    await page.close();
  }
}
