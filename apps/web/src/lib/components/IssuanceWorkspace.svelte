<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { EIP1193Provider } from 'viem';
  import { createIssuanceSession } from '../application/issuance-session';
  import {
    formatGrams,
    getTokenBackend,
    parseTransferGrams,
    readJsonFile,
    saveJson,
    MAX_BUNDLE_BYTES,
    MAX_DEPLOYMENT_BYTES,
    IssuanceClientError,
    resolveEnsRecipient,
  } from '../issuance';
  import { BrowserRpcError } from '../browser-rpc';
  import Glyph from '../visuals/Glyph.svelte';
  import OrbitField from '../visuals/OrbitField.svelte';

  const session = createIssuanceSession();
  let snapshot = $state(session.read());
  let fileError = $state('');
  let reading = $state(false);
  let deploymentName = $state('');
  let bundleName = $state('');
  let transferRecipient = $state('');
  let transferAmount = $state('');
  let ethereumRpc = $state('');
  let resolving = $state(false);
  let transferError = $state('');
  let recoveryHash = $state('');
  let reviewSummary: HTMLElement | undefined;
  let ens = $state<Awaited<ReturnType<typeof resolveEnsRecipient>>>();
  let resolutionVersion = 0;
  function clearEns() {
    resolutionVersion++;
    ens = undefined;
  }
  let connected = $derived(!!snapshot.wallet);
  let busy = $derived(!!snapshot.busy || reading || resolving);
  let unresolved = $derived(
    !!snapshot.pendingOperation ||
      !!snapshot.unknownSubmission ||
      ['pending', 'unresolved'].includes(snapshot.transaction?.outcome ?? '') ||
      ['pending', 'unresolved'].includes(
        snapshot.tokenTransaction?.outcome ?? '',
      ),
  );
  let request = $derived(snapshot.bundle?.request);
  let tokenBackend = $derived(
    snapshot.deployment ? getTokenBackend(snapshot.deployment) : undefined,
  );
  let networkLabel = $derived(
    snapshot.deployment
      ? snapshot.deployment.auditPolicy.chainId === '296'
        ? 'Hedera testnet · 296'
        : `Test chain ${snapshot.deployment.auditPolicy.chainId}`
      : 'No deployment loaded',
  );
  let phase:
    'document' | 'review' | 'authorization' | 'proof' | 'mint' | 'receipt' =
    $derived(
      snapshot.receipt
        ? 'receipt'
        : snapshot.transaction
          ? 'mint'
          : snapshot.signature
            ? 'proof'
            : snapshot.sourceProof === 'accepted'
              ? 'authorization'
              : request
                ? 'review'
                : 'document',
    );
  let steps = $derived([
    { label: 'Import', done: !!snapshot.deployment && !!request },
    { label: 'Check', done: snapshot.sourceProof === 'accepted' },
    { label: 'Sign', done: !!snapshot.signature },
    { label: 'Preflight', done: snapshot.simulation === 'passed' },
    { label: 'Submit', done: !!snapshot.transaction },
    { label: 'Receipt', done: !!snapshot.receipt },
  ]);
  let current = $derived(
    Math.max(
      0,
      steps.findIndex((step) => !step.done),
    ),
  );
  let nextAction = $derived(
    snapshot.pendingOperation
      ? 'The original call is still pending. Review its status below before another action.'
      : unresolved
        ? 'Resolve the wallet outcome below before starting another action.'
        : snapshot.receipt
          ? 'Save your receipt, then use the transfer panel below.'
          : snapshot.transaction?.outcome === 'reverted'
            ? 'No tokens were issued. Import the bundle again for a new attempt.'
            : !snapshot.deployment
              ? 'Start with trusted chain and contract settings.'
              : !request
                ? 'Import the approved file for the right you want to issue.'
                : !connected
                  ? 'Review the quantity and recipient, then connect that wallet.'
                  : snapshot.sourceProof !== 'accepted'
                    ? 'Check the proof and approval before signing.'
                    : !snapshot.disclosed
                      ? 'Read and acknowledge the test-source notice.'
                      : !snapshot.signature
                        ? 'Sign the fixed request in your wallet.'
                        : snapshot.simulation !== 'passed'
                          ? 'Check that the transaction can execute before sending.'
                          : 'Ready for your wallet to review the issuance transaction.',
  );

  onMount(() => {
    const unsubscribe = session.subscribe((value) => {
      snapshot = value;
    });
    const candidate = (window as Window & { ethereum?: EIP1193Provider })
      .ethereum;
    const provider =
      candidate && typeof candidate.request === 'function'
        ? candidate
        : undefined;
    session.setProvider(provider);
    const changed = () => {
      session.walletChanged();
      clearEns();
    };
    provider?.on?.('accountsChanged', changed);
    provider?.on?.('chainChanged', changed);
    provider?.on?.('disconnect', changed);
    return () => {
      provider?.removeListener?.('accountsChanged', changed);
      provider?.removeListener?.('chainChanged', changed);
      provider?.removeListener?.('disconnect', changed);
      unsubscribe();
      session.dispose();
      clearEns();
    };
  });

  async function importFile(event: Event, kind: 'deployment' | 'bundle') {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    reading = true;
    fileError = '';
    try {
      const text = await readJsonFile(
        file,
        kind === 'deployment' ? MAX_DEPLOYMENT_BYTES : MAX_BUNDLE_BYTES,
      );
      if (kind === 'deployment') {
        session.loadDeployment(text);
        deploymentName = file.name;
        bundleName = '';
        clearEns();
      } else {
        session.loadBundle(text);
        bundleName = file.name;
        await tick();
        reviewSummary?.focus();
      }
    } catch (error) {
      fileError =
        error instanceof IssuanceClientError || error instanceof BrowserRpcError
          ? error.message
          : 'The file could not be imported. Check its format, size and any pending transaction.';
    } finally {
      reading = false;
    }
  }

  async function resolveRecipient() {
    if (!snapshot.deployment || busy) return;
    const name = transferRecipient;
    const chainId = snapshot.deployment.auditPolicy.chainId;
    resolving = true;
    transferError = '';
    clearEns();
    const version = resolutionVersion;
    try {
      const result = await resolveEnsRecipient({
        name,
        chainId,
        ethereumRpcUrl: ethereumRpc,
      });
      if (
        version === resolutionVersion &&
        transferRecipient === name &&
        snapshot.deployment?.auditPolicy.chainId === chainId
      )
        ens = result;
    } catch (error) {
      transferError =
        error instanceof BrowserRpcError
          ? error.message
          : 'ENS resolution did not complete. Check the name, Ethereum RPC and intended chain.';
    } finally {
      resolving = false;
    }
  }

  async function transfer() {
    transferError = '';
    try {
      if (!transferRecipient.startsWith('0x') && !ens)
        throw new Error('Resolve the name before transferring.');
      const amount = parseTransferGrams(transferAmount);
      await session.transfer(ens?.address ?? transferRecipient, amount);
    } catch (error) {
      transferError =
        error instanceof Error
          ? error.message
          : 'Check the transfer address and amount.';
    }
  }
  async function recoverWalletTransaction() {
    if (
      snapshot.unknownSubmission === 'issuance' ||
      snapshot.transaction?.outcome === 'unresolved'
    )
      await session.recoverIssuanceHash(recoveryHash);
    else await session.recoverTokenHash(recoveryHash);
  }
</script>

<a class="skip-link" href="#issuance">Skip to issuance</a>
<div class="live-shell">
  <header class="live-header">
    <a class="live-brand" href="/"><span>u</span>ultratokenizer<i>.</i></a>
    <span class="mode-pill">Synthetic source · live wallet actions</span>
    <nav class="workspace-nav" aria-label="Workspace">
      <a class="text-link" href="#transfer">Transfer</a>
      <a class="text-link" href="/verify/"
        >Verify a receipt <Glyph name="arrow" size={15} /></a
      >
    </nav>
  </header>

  <main id="issuance" tabindex="-1" class="issuance-layout">
    <section class="issuance-visual" aria-labelledby="issuance-title">
      <p class="overline">One complete right. One issuance.</p>
      <h1 id="issuance-title">A right.<br /><em>A new form.</em></h1>
      <p class="visual-lede">
        Turn one complete gold claim into tokens. Issue its exact quantity once,
        then transfer in whole milligrams.
      </p>
      <div class="live-orbit" aria-label="Issuance progress">
        <OrbitField stage={phase} />
        <div class="live-orbit-ring"></div>
        <div class="live-orbit-ring inner"></div>
        <ol class="live-orbit-steps">
          {#each steps as step, index}
            <li
              class:done={step.done}
              class:current={!snapshot.receipt && index === current}
              style={`--node: ${index}`}
              aria-current={!snapshot.receipt && index === current
                ? 'step'
                : undefined}
            >
              <span
                >{#if step.done}<Glyph name="check" size={14} />{:else}{index +
                    1}{/if}</span
              ><small>{step.label}</small>
            </li>
          {/each}
        </ol>
        <div class="claim-paper">
          <div class="paper-top">
            <span>UT / CLAIM</span><Glyph name="lock" size={16} />
          </div>
          <span class="paper-label"
            >{request ? 'Fixed quantity' : 'Awaiting a claim'}</span
          >
          <strong class="claim-quantity"
            >{request ? formatGrams(request.amount) : '—'}<small>g</small
            ></strong
          >
          <div class="paper-rule"></div>
          <span class="paper-bottom"
            >{snapshot.receipt
              ? 'Issuance confirmed'
              : request
                ? 'All, or nothing'
                : 'Import your public bundle'}</span
          >
          <div class="paper-seal" aria-hidden="true">u</div>
        </div>
      </div>
      <p class="source-boundary">
        <Glyph name="shield" size={17} /><span
          >Synthetic test source. Real wallet actions; no real bank
          authorization, gold backing or redemption is established.</span
        >
      </p>
    </section>

    <section class="issuance-controls" aria-label="Issue a complete claim">
      <div class="control-heading">
        <p class="overline">Issue your gold claim</p>
        <span class="network-label">{networkLabel}</span>
      </div>
      <p class="next-action" role="status">{nextAction}</p>
      <details class="workflow-step" open={!request}>
        <summary>
          <span class="workflow-step-title"><b>01</b> Load your files</span>
          <span class="workflow-step-state"
            >{request ? 'Loaded' : 'Start here'}</span
          >
        </summary>
        <div class="workflow-step-body">
          <div class="file-pair">
            <label class="file-control"
              ><span>Trusted deployment file</span><small
                >{deploymentName ||
                  `Chain and contract settings · JSON · ${MAX_DEPLOYMENT_BYTES / 1024} KB max`}</small
              ><input
                type="file"
                accept=".json,application/json"
                aria-label="Import deployment configuration"
                disabled={busy || unresolved}
                onchange={(event) => importFile(event, 'deployment')}
              /></label
            >
            <label class="file-control"
              ><span>Approved issuance file</span><small
                >{bundleName ||
                  `Request, proof and approval · JSON · ${MAX_BUNDLE_BYTES / 1024} KB max`}</small
              ><input
                type="file"
                accept=".json,application/json"
                aria-label="Import issuance bundle"
                disabled={!snapshot.deployment || busy || unresolved}
                onchange={(event) => importFile(event, 'bundle')}
              /></label
            >
          </div>
          <p class="field-hint">
            Get the deployment settings independently from a trusted source. The
            claim cannot supply its own trust settings. Both imports stay local.
          </p>
          <p class="field-hint">
            Use public JSON files here. PDF and email evidence must be prepared
            before this step.
          </p>
        </div>
      </details>
      {#if reading}<p class="status-line" role="status">
          Reading JSON locally…
        </p>{/if}
      {#if fileError}<p class="inline-error" role="alert">{fileError}</p>{/if}

      {#if snapshot.deployment}
        <details class="technical-details">
          <summary>Deployment and public request</summary>
          <dl class="data-list">
            <div>
              <dt>RPC contacted by actions</dt>
              <dd>{snapshot.deployment.rpcUrl}</dd>
            </div>
            <div>
              <dt>Gate</dt>
              <dd>{snapshot.deployment.auditPolicy.gate}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{snapshot.deployment.auditPolicy.token}</dd>
            </div>
            <div>
              <dt>Token backend</dt>
              <dd>
                {tokenBackend === 'ats'
                  ? 'ATS · EVM token'
                  : 'HTS · native token'}
              </dd>
            </div>
            <div>
              <dt>Pinned verifier</dt>
              <dd>{snapshot.deployment.auditPolicy.verifierAddress}</dd>
            </div>
            {#if request}<div>
                <dt>Bound recipient</dt>
                <dd>{request.recipient}</dd>
              </div>
              <div>
                <dt>Exact amount</dt>
                <dd>{request.amount} mg</dd>
              </div>
              <div>
                <dt>Issuer ID</dt>
                <dd>{request.issuerId}</dd>
              </div>
              <div>
                <dt>Reservation</dt>
                <dd>{request.reservationId}</dd>
              </div>
              <div>
                <dt>Request ID</dt>
                <dd>{request.requestId}</dd>
              </div>{/if}
          </dl>
        </details>
      {/if}

      <details class="workflow-step" open={!!snapshot.deployment}>
        <summary bind:this={reviewSummary}>
          <span class="workflow-step-title"><b>02</b> Review the claim</span>
          <span class="workflow-step-state"
            >{snapshot.sourceProof === 'accepted'
              ? 'Checked'
              : request
                ? 'Ready to review'
                : snapshot.deployment
                  ? 'Connect your wallet'
                  : 'Waiting for settings'}</span
          >
        </summary>
        <div class="workflow-step-body">
          {#if request}
            <div class="claim-review">
              <span class="overline">Full claim quantity</span>
              <strong class="claim-review-amount"
                >{formatGrams(request.amount)} <small>g gold</small></strong
              >
              <p class="field-hint">
                {request.amount} mg · This entire right is issued once. The amount
                cannot be changed.
              </p>
            </div>
          {/if}
          <div class="wallet-row">
            <div>
              <span class="overline">Your wallet</span>
              <p>
                {snapshot.wallet
                  ? snapshot.wallet.address
                  : snapshot.providerAvailable
                    ? 'Connect the claim recipient’s wallet.'
                    : 'No browser wallet detected. Open this page in a wallet-enabled browser.'}
              </p>
              {#if request}<small class="bound-recipient"
                  >Claim recipient · {request.recipient}</small
                >{/if}
            </div>
            <button
              class="secondary-button"
              disabled={!snapshot.providerAvailable ||
                !snapshot.deployment ||
                busy ||
                !!snapshot.pendingOperation}
              onclick={() => session.connect()}
              ><Glyph name="wallet" size={16} />{connected
                ? 'Reconnect'
                : 'Connect'}</button
            >
          </div>

          <div class="check-row">
            <div>
              <strong>Claim proof and issuer approval</strong><span
                >{snapshot.sourceProof === 'accepted'
                  ? 'Accepted by the pinned verifier and current registry.'
                  : 'Unchecked. Verify the proof, approval and contract settings through your configured RPC.'}</span
              >
            </div>
            <button
              class="secondary-button"
              disabled={!connected ||
                !request ||
                busy ||
                !!snapshot.transaction ||
                unresolved}
              onclick={() => session.check()}>Check bundle</button
            >
          </div>
        </div>
      </details>

      <details
        class="workflow-step"
        open={snapshot.sourceProof === 'accepted' && !snapshot.transaction}
      >
        <summary>
          <span class="workflow-step-title"><b>03</b> Authorize issuance</span>
          <span class="workflow-step-state"
            >{snapshot.pendingOperation
              ? 'Call still pending'
              : snapshot.unknownSubmission
                ? 'Outcome unknown'
                : snapshot.transaction
                  ? snapshot.transaction.outcome === 'confirmed'
                    ? 'Issued'
                    : snapshot.transaction.outcome === 'reverted'
                      ? 'Reverted'
                      : snapshot.transaction.outcome === 'unresolved'
                        ? 'Outcome unresolved'
                        : 'Submitted'
                  : snapshot.simulation === 'passed'
                    ? 'Ready to send'
                    : snapshot.signature
                      ? 'Signed'
                      : snapshot.sourceProof === 'accepted'
                        ? 'Ready to sign'
                        : 'Check the claim first'}</span
          >
        </summary>
        <div class="workflow-step-body">
          <label class="disclosure-control"
            ><input
              type="checkbox"
              checked={snapshot.disclosed}
              disabled={busy || !!snapshot.transaction || unresolved}
              onchange={(event) =>
                session.disclose(event.currentTarget.checked)}
            /><span
              >I understand this test source grants no real gold rights. The
              full claim quantity, wallet and request data are public from
              onchain reservation or submission, even if issuance fails.</span
            ></label
          >

          <ol class="action-list">
            <li>
              <span
                ><b>1</b><strong>Sign the fixed request</strong><small
                  >{snapshot.signature
                    ? 'Holder signature checked'
                    : 'Approve this quantity and recipient; no transaction yet'}</small
                ></span
              ><button
                class="secondary-button"
                disabled={!connected ||
                  snapshot.sourceProof !== 'accepted' ||
                  !snapshot.disclosed ||
                  busy ||
                  !!snapshot.transaction ||
                  unresolved}
                onclick={() => session.sign()}
                >{snapshot.signature ? 'Sign again' : 'Sign request'}</button
              >
            </li>
            <li>
              <span
                ><b>2</b><strong>Check before sending</strong><small
                  >{snapshot.simulation === 'passed'
                    ? 'Call succeeded; no transaction sent'
                    : 'Check current execution without sending'}</small
                ></span
              ><button
                class="secondary-button"
                disabled={!snapshot.signature ||
                  busy ||
                  !!snapshot.transaction ||
                  unresolved}
                onclick={() => session.simulate()}>Check before sending</button
              >
            </li>
          </ol>
        </div>
      </details>
      <div class="issuance-submit">
        <button
          class="primary-button"
          disabled={!snapshot.signature ||
            snapshot.simulation !== 'passed' ||
            !snapshot.disclosed ||
            busy ||
            !!snapshot.transaction ||
            unresolved}
          onclick={() => session.submit()}
          >Issue full claim <Glyph name="arrow" size={15} /></button
        >
        <p class="field-hint">
          Your wallet reviews and submits the transaction. Issuance completes
          only after its outcome is checked.
        </p>
      </div>
      {#if snapshot.busy}<p class="status-line" role="status">
          {snapshot.busy === 'confirming'
            ? 'Waiting for the actual transaction outcome…'
            : `${snapshot.busy.charAt(0).toUpperCase()}${snapshot.busy.slice(1)}…`}
        </p>{/if}
      {#if snapshot.error}<p class="inline-error" role="alert">
          {snapshot.error}
        </p>{/if}

      {#if snapshot.pendingOperation}
        <p class="status-line" role="status">
          The original call is still pending. Close or complete its wallet
          prompt. New wallet actions remain blocked; a returned transaction hash
          will be retained.
        </p>
      {/if}

      {#if snapshot.unknownSubmission}
        <section
          id="wallet-outcome"
          class="transaction-card"
          aria-label="Unknown wallet outcome"
        >
          <h2>Wallet outcome unknown</h2>
          <p>
            A transaction may have been sent. Further submissions are paused.
            Inspect wallet activity before continuing.
          </p>
          <label class="text-field"
            >Transaction hash from wallet<input
              type="text"
              placeholder="0x…"
              bind:value={recoveryHash}
              disabled={busy}
              spellcheck="false"
            /></label
          ><button
            class="primary-button"
            disabled={busy || !recoveryHash}
            onclick={recoverWalletTransaction}>Reconcile wallet hash</button
          >
          <button
            class="secondary-button"
            disabled={busy || !!snapshot.pendingOperation}
            onclick={() => session.acknowledgeNotSent()}
            >I checked wallet activity: nothing was sent</button
          >
        </section>
      {/if}

      {#if snapshot.transaction}
        <section class="transaction-card" aria-label="Issuance transaction">
          <div class="transaction-heading">
            <h2>
              {snapshot.transaction.outcome === 'confirmed'
                ? 'Issuance confirmed'
                : snapshot.transaction.outcome === 'reverted'
                  ? 'Transaction reverted'
                  : snapshot.transaction.outcome === 'unresolved'
                    ? 'Issuance outcome unresolved'
                    : 'Transaction submitted'}
            </h2>
            <span class="status-pill">{snapshot.transaction.outcome}</span>
          </div>
          <code>{snapshot.transaction.hash}</code>
          {#if snapshot.receipt}<p>
              {formatGrams(snapshot.receipt.request.amount)} g issued to the bound
              recipient. The receipt matches the configured Gate event exactly.
            </p>
            <dl class="data-list">
              <div>
                <dt>Recipient</dt>
                <dd>{snapshot.receipt.request.recipient}</dd>
              </div>
            </dl>
            <button
              class="primary-button"
              onclick={() =>
                saveJson(
                  snapshot.receipt,
                  'ultratokenizer-issuance-receipt.json',
                )}>Save issuance receipt</button
            >
          {:else if snapshot.transaction.outcome === 'reverted'}<p>
              This transaction did not issue tokens. Keep the hash as an audit
              reference, then import the issuance bundle again to start a new
              checked attempt.
            </p>
          {:else}<p>
              Keep this hash and this page open until reconciliation completes.
              Sending a transaction is not confirmation.
            </p>
            <button
              class="primary-button"
              disabled={busy}
              onclick={() => session.confirm()}
              >Check transaction outcome</button
            >{/if}
          {#if snapshot.transaction.outcome === 'unresolved'}
            <label class="text-field"
              >Recovered issuance transaction hash<input
                type="text"
                placeholder="0x…"
                bind:value={recoveryHash}
                disabled={busy}
                spellcheck="false"
              /></label
            ><button
              class="secondary-button"
              disabled={busy || !recoveryHash}
              onclick={recoverWalletTransaction}
              >Reconcile recovered issuance hash</button
            >
          {/if}
        </section>
      {/if}
    </section>

    <section
      id="transfer"
      class="token-workspace"
      aria-labelledby="token-title"
      tabindex="-1"
    >
      <div class="token-overview">
        <p class="overline">After issuance</p>
        <h2 id="token-title">A whole claim.<br /><em>Divisible tokens.</em></h2>
        <p>
          Send any positive amount in whole milligrams, including part of an
          issued claim. One base unit is 0.001 g.
          {#if tokenBackend === 'hts'}
            HTS association and transfers are separate wallet transactions.
          {:else if tokenBackend === 'ats'}
            ATS token transfers are wallet transactions.
          {:else}
            Import a deployment to use its token.
          {/if}
        </p>
        <p class="field-hint">
          Already hold this token? Load its trusted deployment and connect your
          wallet to transfer. You do not need a new claim.
        </p>
      </div>
      <div class="token-controls">
        <div class="token-balance">
          <span>Connected wallet balance</span><strong
            >{snapshot.balanceMg === undefined
              ? '—'
              : `${formatGrams(snapshot.balanceMg)} g`}</strong
          ><button
            class="text-link"
            disabled={!connected || busy || !!snapshot.pendingOperation}
            onclick={() => session.refreshBalance()}>Refresh</button
          >
        </div>
        {#if tokenBackend === 'hts'}
          <button
            class="secondary-button"
            disabled={!connected || busy || unresolved}
            onclick={() => session.associate()}>Associate this token</button
          >
          <p class="field-hint">
            Use this if the connected wallet has not associated with the token.
            The chain checks whether it is needed.
          </p>
        {/if}
        <div class="token-form">
          <label class="text-field"
            >Transfer recipient<input
              type="text"
              placeholder="0x… or name.eth"
              value={transferRecipient}
              disabled={busy}
              oninput={(event) => {
                transferRecipient = event.currentTarget.value;
                clearEns();
              }}
              autocomplete="off"
              spellcheck="false"
            /></label
          >
          {#if transferRecipient && !transferRecipient.startsWith('0x')}
            <label class="text-field"
              >Ethereum RPC for ENS<input
                type="url"
                placeholder="https://…"
                value={ethereumRpc}
                disabled={busy}
                oninput={(event) => {
                  ethereumRpc = event.currentTarget.value;
                  clearEns();
                }}
              /></label
            ><button
              class="secondary-button"
              disabled={!snapshot.deployment || !ethereumRpc || busy}
              onclick={resolveRecipient}>Resolve ENS recipient</button
            >
            <p class="field-hint">
              Resolve only when you are ready to send the name to this Ethereum
              RPC. Check the full returned address before transferring. ENS does
              not grant institution authority.
            </p>
          {/if}
          {#if ens}<div class="resolved-address">
              <strong>{ens.normalizedName} → Chain {ens.chainId}</strong><code
                >{ens.address}</code
              ><small
                >Frozen for this transfer. The resolver may use its default EVM
                address. Ethereum block {ens.blockNumber.toString()}.</small
              >
            </div>{/if}
          <label class="text-field"
            >Transfer amount (g)<input
              type="text"
              inputmode="decimal"
              placeholder="For example, 0.125"
              bind:value={transferAmount}
              disabled={busy}
            /></label
          >
          <p class="field-hint">
            Up to three decimal places. Your issuance quantity stays unchanged.
          </p>
          <button
            class="primary-button"
            disabled={!connected ||
              !transferRecipient ||
              !transferAmount ||
              (!transferRecipient.startsWith('0x') && !ens) ||
              busy ||
              unresolved}
            onclick={transfer}
            >Review transfer in wallet <Glyph name="arrow" size={15} /></button
          >
          {#if transferError || snapshot.error}<p
              class="inline-error"
              role={transferError ? 'alert' : undefined}
            >
              {transferError || snapshot.error}
            </p>{/if}
          {#if snapshot.unknownSubmission}
            <p class="status-line">
              New transfers are paused. <a
                class="text-link"
                href="#wallet-outcome">Review the wallet outcome</a
              > before continuing.
            </p>
          {/if}
        </div>
        {#if snapshot.tokenIntent}<div
            class="transaction-card"
            aria-label="Frozen token intent"
          >
            <strong
              >{snapshot.tokenIntent.kind === 'transfer'
                ? `${formatGrams(snapshot.tokenIntent.milligrams)} g transfer`
                : 'Token association'}</strong
            >
            <p>
              Saved before sending. This is the action we check, even if the
              wallet or form changes.
            </p>
            <dl class="data-list">
              <div>
                <dt>From</dt>
                <dd>{snapshot.tokenIntent.account}</dd>
              </div>
              {#if snapshot.tokenIntent.kind === 'transfer'}<div>
                  <dt>To</dt>
                  <dd>{snapshot.tokenIntent.recipient}</dd>
                </div>{/if}
              <div>
                <dt>Token · Chain {snapshot.tokenIntent.chainId}</dt>
                <dd>{snapshot.tokenIntent.token}</dd>
              </div>
            </dl>
          </div>{/if}
        {#if snapshot.tokenTransaction}<div class="transaction-card">
            <strong
              >{snapshot.tokenTransaction.kind === 'transfer'
                ? 'Transfer'
                : 'Association'} · {snapshot.tokenTransaction.outcome}</strong
            ><code>{snapshot.tokenTransaction.hash}</code
            >{#if ['pending', 'unresolved'].includes(snapshot.tokenTransaction.outcome)}<button
                class="secondary-button"
                disabled={busy}
                onclick={() => session.confirmToken()}
                >Check token transaction</button
              >{/if}
            {#if snapshot.tokenTransaction.outcome === 'unresolved'}
              <label class="text-field"
                >Recovered token transaction hash<input
                  type="text"
                  placeholder="0x…"
                  bind:value={recoveryHash}
                  disabled={busy}
                  spellcheck="false"
                /></label
              >
              <button
                class="secondary-button"
                disabled={busy || !recoveryHash}
                onclick={recoverWalletTransaction}
                >Reconcile recovered token hash</button
              >
            {/if}
          </div>{/if}
      </div>
    </section>
  </main>
  <footer class="live-footer">
    <span
      ><Glyph name="lock" size={14} /> Source documents and private keys are never
      requested here.</span
    ><span>Session data stays in memory. Save confirmed receipts.</span>
  </footer>
</div>

<style>
  .live-orbit :global(.orbit-field) {
    overflow: clip;
  }
</style>
