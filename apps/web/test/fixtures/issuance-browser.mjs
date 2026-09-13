import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { operatorUrl, openOperatorConfiguration } from '../helpers.mjs';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toHex,
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
  documentFlow = false,
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
  const terms = documentFlow
    ? keccak256(toHex('Synthetic browser test terms.'))
    : `0x${'99'.repeat(32)}`;
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
    usedRequests: false,
    usedRequestIds: false,
    usedClaims: false,
    usedHolderNonces: false,
  };
  const reserved = values.reservations;
  if (documentFlow) {
    values.reservations = [
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0n,
      0n,
      0n,
      false,
      `0x${'00'.repeat(32)}`,
      `0x${'00'.repeat(32)}`,
      false,
    ];
    values.backingPools = [1000n, 0n, 0n];
  }
  const prepared = {
    request,
    sourceId: policy.sourceId,
    signerFingerprint: policy.sourceSignerFingerprint,
    policyTermsHash: terms,
    rightsTermsHash: terms,
  };
  const demoConfig = {
    issuer: {
      label: 'Synthetic browser issuer',
      agentId: '116',
      identityRegistry: policy.gate,
      issuerId: policy.issuerId,
      wallet: policy.issuerAddress,
      selected: true,
    },
    terms: {
      policy: { text: 'Synthetic browser test terms.', hash: terms },
      rights: { text: 'Synthetic browser test terms.', hash: terms },
      checked: true,
      blockNumber: '100',
    },
    readiness: { canStart: true },
  };
  const job = {
    jobId: 'test_job',
    documentId: 'test_document',
    requestDigest: digest,
  };
  let proofStarts = 0;
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
      documentFlow &&
      url.origin === base.origin &&
      (url.pathname.startsWith('/api/') || url.pathname === '/deployment.json')
    ) {
      let value;
      if (url.pathname === '/deployment.json') value = fixture.deployment;
      else if (url.pathname === '/api/config') value = demoConfig;
      else if (url.pathname === '/api/documents')
        value = {
          ...demoConfig,
          documentId: job.documentId,
          document: {
            name: 'Synthetic signed gold.pdf',
            amountMilligrams: request.amount,
            recipient: request.recipient,
            issuerId: policy.issuerId,
            sourceId: policy.sourceId,
            sourceSignerFingerprint: policy.sourceSignerFingerprint,
            profile: 'ultratokenizer-synthetic-gold-v2',
            sha256: `0x${'11'.repeat(32)}`,
          },
        };
      else if (url.pathname === '/api/jobs/prepare') {
        assert.deepEqual(rpcRequest.postDataJSON(), {
          documentId: job.documentId,
          recipient: request.recipient,
        });
        value = {
          ...job,
          request,
          prepared,
          status: 'awaiting_signature',
          readiness: { canStart: true },
        };
      } else if (url.pathname === `/api/jobs/${job.jobId}/start`) {
        assert.equal(
          rpcRequest.postDataJSON().holderSignature,
          holderSignature,
        );
        proofStarts++;
        values.reservations = reserved;
        values.backingPools = [1000n, 1000n, 0n];
        value = {
          ...job,
          phase: 'proof',
          status: 'proving',
          detailCode: null,
          bundleReady: false,
          canRetry: false,
        };
      } else if (url.pathname === `/api/jobs/${job.jobId}`)
        value = {
          ...job,
          phase: 'issuance',
          status: 'ready_to_mint',
          detailCode: null,
          bundleReady: true,
          canRetry: false,
        };
      else if (url.pathname === `/api/jobs/${job.jobId}/bundle`) value = bundle;
      else throw new Error(`Unexpected document endpoint ${url.pathname}`);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    }
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
    unexpectedRequests.push({
      origin: url.origin,
      path: url.pathname,
      method: rpcRequest.method(),
    });
    await route.abort();
  });
  await page.addInitScript(
    ({ account, signature, start, originalHash, documentFlow }) => {
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
          if (method === 'eth_requestAccounts' && documentFlow) {
            await new Promise((resolve) => {
              window.grantIssuanceWallet = () => {
                for (const callback of listeners.get('accountsChanged') ?? [])
                  callback([window.issuanceWallet.account]);
                resolve();
              };
            });
          }
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
      documentFlow,
    },
  );
  try {
    await page.goto(documentFlow ? base.href : operatorUrl(base), {
      waitUntil: 'networkidle',
    });
    if (documentFlow) {
      const checkViewport = async (loaded) => {
        for (const [width, height] of [
          [1440, 900],
          [1280, 800],
          [2048, 1080],
        ]) {
          await page.setViewportSize({ width, height });
          await page.evaluate(() => window.scrollTo(0, 0));
          const action = page.getByRole('button', {
            name: loaded ? 'Verify & mint' : 'Upload signed PDF',
            exact: true,
          });
          await expect(action).toBeVisible();
          const fits = await page.evaluate((loaded) => {
            const selectors = [
              '.proof-object',
              '.flow-rail',
              '.issuer-card',
              loaded
                ? '.document-action > .primary-button'
                : '.document-drop .primary-button',
            ];
            return (
              selectors.every((selector) => {
                const rect = document
                  .querySelector(selector)
                  ?.getBoundingClientRect();
                return rect && rect.top >= 0 && rect.bottom <= innerHeight;
              }) && document.documentElement.scrollWidth <= innerWidth
            );
          }, loaded);
          assert.ok(
            fits,
            `${loaded ? 'loaded' : 'initial'} document flow fits ${width}x${height}`,
          );
          await page.screenshot({
            path: `/private/tmp/document-journey-${loaded ? 'loaded' : 'initial'}-${width}.png`,
          });
        }
        if (loaded) {
          for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(() => window.scrollTo(0, 0));
            assert(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
              `loaded review panel has no horizontal overflow at ${width}px`,
            );
            await page.screenshot({
              path: `/private/tmp/document-journey-loaded-${width}.png`,
              fullPage: true,
            });
          }
          const textZoom = await page.addStyleTag({
            content: 'html { font-size: 200%; }',
          });
          assert(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            'loaded review panel fits 320px with 200% text',
          );
          await textZoom.evaluate((element) => element.remove());
        }
        await page.setViewportSize({ width: 1280, height: 900 });
      };
      await expect(
        page.getByRole('button', { name: 'Upload signed PDF', exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByLabel('Import issuance bundle', { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator('.flow-rail li')).toHaveCount(3);
      await checkViewport(false);
      await page.getByLabel('Signed document', { exact: true }).setInputFiles({
        name: 'signed.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF'),
      });
      await expect(page.locator('.document-summary')).toContainText('1.000');
      await expect(page.locator('.session-list')).toContainText(
        'Document amount',
      );
      await expect(page.locator('.session-list')).toContainText('1.000 g XAU');
      await page
        .getByRole('button', { name: 'Connect recipient wallet', exact: true })
        .click();
      const connecting = page.getByRole('button', {
        name: 'Connecting…',
        exact: true,
      });
      await expect(connecting).toHaveCount(2);
      await expect(connecting.first()).toBeDisabled();
      await expect(connecting.last()).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByText('Connecting to your wallet…')).toBeVisible();
      assert.equal(proofStarts, 0, 'connecting cannot start a paid proof');
      assert.deepEqual(
        await page.evaluate(() => window.issuanceWallet.sends),
        [],
        'connecting cannot broadcast a transaction',
      );
      await page.evaluate(() => window.grantIssuanceWallet());
      await expect(connecting).toHaveCount(0);
      await expect(page.locator('.session-list')).toContainText(
        request.recipient,
      );
      await page.getByRole('checkbox').check();
      await checkViewport(true);
      await page
        .getByRole('button', { name: 'Verify & mint', exact: true })
        .click();
      await expect(page.locator('.document-phases')).toContainText(
        'Generating the SP1 proof',
        { timeout: 15000 },
      );
      await expect(page.locator('.artifact-caption')).toHaveText(
        'SP1 proof in progress',
      );
      await expect(page.locator('.artifact-caption')).not.toContainText(
        'Ready to verify',
      );
      await expect(page.locator('.proof-object')).toHaveAttribute(
        'data-state',
        'working',
      );
      await expect(page.locator('.artifact-body')).not.toHaveClass(/is-coin/);
      await page
        .getByRole('button', { name: 'Check verification status', exact: true })
        .click();
      await expect(page.locator('.proof-object')).toHaveAttribute(
        'data-state',
        'verified',
        { timeout: 15000 },
      );
      await page
        .getByRole('button', { name: 'Check before minting', exact: true })
        .click();
      assert.equal(proofStarts, 1);
    } else {
      for (const [label, value] of [
        ['Import deployment configuration', fixture.deployment],
        ['Import issuance bundle', bundle],
      ]) {
        if (label === 'Import deployment configuration')
          await openOperatorConfiguration(page);
        await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
        await page.getByLabel(label, { exact: true }).setInputFiles({
          name: 'synthetic-issuance-recovery.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(value)),
        });
        await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
      }
      if (start === 'unknown' && outcome === 'confirmed') {
        await page.evaluate((address) => {
          window.issuanceWallet.account = address;
        }, foreignSender);
        await page
          .locator('.stage-action')
          .getByRole('button', { name: 'Connect wallet', exact: true })
          .click();
        await expect(page.locator('.stage-action')).toContainText(
          'The wallet network or address does not match.',
        );
        await expect(
          page.locator('.flow-rail [aria-current="step"]'),
        ).toContainText('Wallet');
        await expect(
          page.getByRole('button', { name: 'Verify evidence', exact: true }),
        ).toHaveCount(0);
        await page.evaluate((address) => {
          window.issuanceWallet.account = address;
        }, request.recipient);
      }
      await page
        .locator('.stage-action')
        .getByRole('button', { name: 'Connect wallet', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Verify evidence', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Sign mint request' }),
      ).toBeVisible();
      await expect(page.locator('.proof-object')).toHaveAttribute(
        'data-state',
        'verified',
      );
      await expect(page.locator('.artifact-body')).not.toHaveClass(/is-coin/);
      await page.getByRole('checkbox').check();
      await page
        .getByRole('button', { name: 'Sign mint request', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Check before sending', exact: true })
        .click();
    }
    const issue = page.getByRole('button', {
      name: 'Mint 1.000 g',
      exact: true,
    });
    // Validation performs several sequential RPC checks; allow the configured
    // ten-second transport timeout without confusing it with the test runner default.
    await expect(issue).toBeEnabled({ timeout: 15_000 });
    if (start === 'unknown' && outcome === 'confirmed') {
      failNextPreflight = true;
      await issue.click();
      await expect(page.locator('.stage-action .inline-error')).toContainText(
        'Issuance checks could not complete',
      );
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
    await expect(page.locator('.artifact-body')).not.toHaveClass(/is-coin/);
    await expect(
      page.locator('.flow-rail [aria-current="step"]'),
    ).toContainText(documentFlow ? 'Verify & mint' : 'Mint');
    const transaction = page.getByRole('region', {
      name: 'Issuance transaction',
      exact: true,
    });
    if (start === 'unknown') {
      await expect(
        page.getByRole('region', { name: 'Unknown wallet outcome' }),
      ).toBeVisible();
      await expect(page.locator('.activity-rail')).toContainText(
        'Transaction outcome unknown.',
      );
      await expect(page.locator('.activity-rail')).not.toContainText(
        'No transactions yet.',
      );
    } else {
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
      start === 'unknown' ? 'Transaction hash' : 'Recovered transaction hash',
      { exact: true },
    );
    const reconcile = page.getByRole('button', {
      name: start === 'unknown' ? 'Reconcile hash' : 'Reconcile recovered hash',
      exact: true,
    });
    for (const malformed of ['0x1234', `0x${'00'.repeat(32)}`]) {
      const readCount = rpcCalls.length;
      await input.fill(malformed);
      await reconcile.click();
      await expect(page.locator('.stage-action .inline-error')).toContainText(
        'full nonzero 32-byte transaction hash',
      );
      assert.equal(rpcCalls.length, readCount);
      if (start === 'unknown') await expect(transaction).toHaveCount(0);
      else await expect(transaction).toContainText(originalHash);
    }
    await input.fill(badHash);
    await reconcile.click();
    await expect(reconcile).toBeEnabled();
    await expect(page.locator('.stage-action .inline-error')).toContainText(
      'does not contain the exact expected issuance',
    );
    await expect(page.locator('.stage-action .inline-error')).not.toContainText(
      'full transaction hash',
    );
    if (start === 'unknown') await expect(transaction).toHaveCount(0);
    else await expect(transaction).toContainText(originalHash);
    await expect(
      page.getByRole('button', { name: 'Save receipt', exact: true }),
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
      await expect(page.locator('.stage-action .inline-error')).toContainText(
        'does not identify the original wallet submission',
      );
      if (start === 'unknown') await expect(transaction).toHaveCount(0);
      else {
        await expect(transaction.locator('.status-pill')).toHaveText(
          'unresolved',
        );
        await expect(transaction).toContainText(originalHash);
      }
      await expect(
        page.getByRole('button', { name: 'Mint 1.000 g', exact: true }),
      ).toHaveCount(0);
      // A foreign sender/nonce's exact-call revert cannot settle the original send.
      finalHash = start === 'unknown' ? successHash : originalHash;
      finalOutcome = start === 'unknown' ? 'confirmed' : 'reverted';
      await input.fill(finalHash);
      await reconcile.click();
    }
    await expect(transaction.locator('.status-pill')).toHaveText(finalOutcome);
    await expect(page.locator('.proof-object')).toHaveAttribute(
      'data-state',
      finalOutcome === 'confirmed' ? 'minted' : 'reverted',
    );
    if (finalOutcome === 'confirmed') {
      await expect(page.locator('.artifact-body')).toHaveClass(/is-coin/);
      await expect(page.locator('.flow-rail li.done')).toHaveCount(
        documentFlow ? 3 : 6,
      );
    } else {
      await expect(page.locator('.artifact-body')).not.toHaveClass(/is-coin/);
      await expect(
        page.locator('.flow-rail [aria-current="step"]'),
      ).toContainText(documentFlow ? 'Verify & mint' : 'Mint');
    }
    await expect(transaction).toContainText(finalHash);
    await expect(
      page.getByRole('region', { name: 'Unknown wallet outcome' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Save receipt', exact: true }),
    ).toHaveCount(finalOutcome === 'confirmed' ? 1 : 0);
    if (finalOutcome === 'reverted') {
      await expect(transaction).toContainText('No tokens were minted.');
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
  } catch (error) {
    // This helper loads only synthetic fixtures; keep actionable UI diagnostics
    // when a production browser assertion fails before receipt recovery.
    console.error(
      'Synthetic issuance browser state:',
      await page.locator('.stage-action').innerText(),
    );
    console.error(
      'Synthetic wallet methods:',
      await page.evaluate(() => window.issuanceWallet.methods),
    );
    console.error(
      'Synthetic RPC methods:',
      rpcCalls.map((call) => call.method),
    );
    throw error;
  } finally {
    await page.close();
  }
}
