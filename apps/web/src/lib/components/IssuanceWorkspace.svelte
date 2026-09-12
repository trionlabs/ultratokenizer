<script lang="ts">
  import { onMount } from 'svelte';
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
  let workspaceView = $state<'issue' | 'transfer'>('issue');
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
  let tokenNeedsRecovery = $derived(
    snapshot.unknownSubmission === 'association' ||
      snapshot.unknownSubmission === 'transfer' ||
      snapshot.tokenTransaction?.outcome === 'unresolved',
  );
  let request = $derived(snapshot.bundle?.request);
  let tokenBackend = $derived(
    snapshot.deployment ? getTokenBackend(snapshot.deployment) : undefined,
  );
  let networkLabel = $derived(
    snapshot.deployment
      ? snapshot.deployment.auditPolicy.chainId === '296'
        ? 'Hedera testnet'
        : `Test chain ${snapshot.deployment.auditPolicy.chainId}`
      : 'Not loaded',
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
  let flowSteps = $derived([
    { label: 'Profile', done: !!snapshot.deployment },
    { label: 'Evidence', done: !!request },
    { label: 'Wallet', done: connected },
    { label: 'Verify', done: snapshot.sourceProof === 'accepted' },
    { label: 'Issue', done: !!snapshot.transaction },
    { label: 'Receipt', done: !!snapshot.receipt },
  ]);
  let activeStep = $derived(
    snapshot.receipt
      ? 5
      : Math.max(
          0,
          flowSteps.findIndex((step) => !step.done),
        ),
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
    const syncView = () => {
      workspaceView =
        window.location.hash === '#transfer' ? 'transfer' : 'issue';
    };
    syncView();
    window.addEventListener('hashchange', syncView);
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
      window.removeEventListener('hashchange', syncView);
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

<a class="skip-link" href="#engine">Skip to token engine</a>
<div class="live-shell">
  <header class="live-header">
    <a class="live-brand" href="/"><span>u</span>ultratokenizer<i>.</i></a>
    <span class="engine-label">Proof-backed token engine</span>
    <nav class="workspace-nav" aria-label="Workspace">
      <a class:active={workspaceView === 'issue'} href="#engine">Issue</a>
      <a class:active={workspaceView === 'transfer'} href="#transfer"
        >Transfer</a
      >
      <a href="/verify/">Verify <Glyph name="arrow" size={14} /></a>
    </nav>
    <button
      class="header-wallet"
      disabled={!snapshot.providerAvailable ||
        !snapshot.deployment ||
        busy ||
        !!snapshot.pendingOperation}
      onclick={() => session.connect()}
      title={!snapshot.deployment ? 'Load the test profile first' : undefined}
      ><Glyph name="wallet" size={15} />{connected
        ? 'Reconnect wallet'
        : 'Connect wallet'}</button
    >
  </header>

  <main id="engine" tabindex="-1" class="engine-layout">
    <section
      class="engine-stage"
      aria-labelledby="issuance-title"
      hidden={workspaceView !== 'issue'}
    >
      <div class="stage-copy">
        <p class="scene-kicker">
          Evidence → token <span>{activeStep + 1} / 6</span>
        </p>
        <h1 id="issuance-title">Your gold. <em>A new form.</em></h1>
        <p>
          {#if !snapshot.deployment}Open the Hedera test workspace.
          {:else if !request}Add the approved evidence package.
          {:else if !connected}Connect the wallet named by the package.
          {:else if snapshot.sourceProof !== 'accepted'}Verify before minting.
          {:else if !snapshot.transaction}Authorize the exact amount.
          {:else if snapshot.receipt}Save the receipt.
          {:else}Confirm the transaction outcome.{/if}
        </p>
      </div>

      <div class="proof-object" aria-hidden="true">
        <OrbitField stage={phase} />
        <div class="proof-sheet">
          <div class="sheet-top"><b>u.</b><span>PROOF / XAU</span></div>
          <strong
            >{request
              ? `${formatGrams(request.amount)} g`
              : 'Gold evidence'}</strong
          >
          <div class="sheet-lines"><span></span><span></span><span></span></div>
          <small
            >{snapshot.receipt
              ? 'Receipt ready'
              : snapshot.sourceProof === 'accepted'
                ? 'Proof accepted'
                : request
                  ? 'Package loaded'
                  : 'Awaiting profile'}</small
          >
          <i><Glyph name="lock" size={15} /></i>
        </div>
      </div>

      <section class="stage-action" aria-label="Current issuance step">
        {#if snapshot.unknownSubmission === 'issuance'}
          <div
            id="wallet-outcome"
            class="transaction-card"
            role="region"
            aria-label="Unknown wallet outcome"
          >
            <h2>Check your wallet</h2>
            <p>A transaction may have been sent. New submissions are paused.</p>
            <label class="text-field"
              >Transaction hash<input
                type="text"
                placeholder="0x…"
                bind:value={recoveryHash}
                disabled={busy}
                spellcheck="false"
              /></label
            >
            <div class="button-row">
              <button
                class="primary-button"
                disabled={busy || !recoveryHash}
                onclick={recoverWalletTransaction}>Reconcile hash</button
              >
              <button
                class="secondary-button"
                disabled={busy || !!snapshot.pendingOperation}
                onclick={() => session.acknowledgeNotSent()}
                >Nothing was sent</button
              >
            </div>
          </div>
        {:else if snapshot.transaction}
          <div
            class="transaction-card"
            role="region"
            aria-label="Issuance transaction"
          >
            <div class="transaction-heading">
              <h2>
                {snapshot.transaction.outcome === 'confirmed'
                  ? 'Issuance confirmed'
                  : snapshot.transaction.outcome === 'reverted'
                    ? 'Transaction reverted'
                    : snapshot.transaction.outcome === 'unresolved'
                      ? 'Outcome unresolved'
                      : 'Transaction submitted'}
              </h2>
              <span class="status-pill">{snapshot.transaction.outcome}</span>
            </div>
            <code>{snapshot.transaction.hash}</code>
            {#if snapshot.receipt}
              <p>{formatGrams(snapshot.receipt.request.amount)} g minted.</p>
              <button
                class="primary-button"
                onclick={() =>
                  saveJson(
                    snapshot.receipt,
                    'ultratokenizer-issuance-receipt.json',
                  )}>Save receipt</button
              >
            {:else if snapshot.transaction.outcome === 'reverted'}
              <p>No tokens were minted. Load a fresh package to retry.</p>
            {:else}
              <button
                class="primary-button"
                disabled={busy}
                onclick={() => session.confirm()}
                >Check transaction outcome</button
              >
            {/if}
            {#if snapshot.transaction.outcome === 'unresolved'}
              <label class="text-field"
                >Recovered transaction hash<input
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
                >Reconcile recovered hash</button
              >
            {/if}
          </div>
        {:else if !snapshot.deployment}
          <div class="action-copy">
            <span>01</span>
            <div>
              <h2>Open the test workspace</h2>
              <p>
                Loads the Hedera network, token, and verification rules for this
                run.
              </p>
            </div>
          </div>
          <label class="upload-button"
            >Choose workspace setup <Glyph name="arrow" size={15} /><input
              class="sr-only"
              type="file"
              accept=".json,application/json"
              aria-label="Import deployment configuration"
              disabled={busy || unresolved}
              onchange={(event) => importFile(event, 'deployment')}
            /></label
          >
          <p class="field-hint">
            Provided separately from the evidence package · JSON · {MAX_DEPLOYMENT_BYTES /
              1024} KB max
          </p>
        {:else if !request}
          <div class="action-copy">
            <span>02</span>
            <div>
              <h2>Add approved evidence</h2>
              <p>
                Contains the proof, approval, recipient, and exact quantity.
              </p>
            </div>
          </div>
          <label class="upload-button"
            >Choose evidence package <Glyph name="arrow" size={15} /><input
              class="sr-only"
              type="file"
              accept=".json,application/json"
              aria-label="Import issuance bundle"
              disabled={busy || unresolved}
              onchange={(event) => importFile(event, 'bundle')}
            /></label
          >
          <p class="field-hint">
            Public JSON · {MAX_BUNDLE_BYTES / 1024} KB max
          </p>
        {:else if !connected}
          <div class="action-copy">
            <span>03</span>
            <div>
              <h2>Connect the recipient wallet</h2>
              <p>The connected address must match the approved recipient.</p>
            </div>
          </div>
          <button
            class="primary-button wide-button"
            disabled={!snapshot.providerAvailable || busy || unresolved}
            onclick={() => session.connect()}
            ><Glyph name="wallet" size={16} /> Connect wallet</button
          >
          {#if !snapshot.providerAvailable}
            <p class="field-hint">No browser wallet detected.</p>
          {/if}
          <small class="bound-recipient">Recipient · {request.recipient}</small>
        {:else if snapshot.sourceProof !== 'accepted'}
          <div class="action-copy">
            <span>04</span>
            <div>
              <h2>Verify the package</h2>
              <p>Check the proof, approval, and current contract state.</p>
            </div>
          </div>
          <div class="claim-review">
            <span>Exact quantity</span>
            <strong class="claim-quantity"
              >{formatGrams(request.amount)} <small>g</small></strong
            >
            <button
              class="primary-button"
              disabled={busy || unresolved}
              onclick={() => session.check()}>Check bundle</button
            >
          </div>
        {:else}
          <div class="action-copy">
            <span>05</span>
            <div>
              <h2>Authorize issuance</h2>
              <p>Sign, preflight, then submit the fixed request.</p>
            </div>
          </div>
          <label class="disclosure-control"
            ><input
              type="checkbox"
              checked={snapshot.disclosed}
              disabled={busy || unresolved}
              onchange={(event) =>
                session.disclose(event.currentTarget.checked)}
            /><span
              >This test package proves no bank authorization, backing, or
              redemption. Its public request data may be written onchain.</span
            ></label
          >
          <ol class="action-list">
            <li>
              <span
                ><b>1</b><strong>Sign request</strong><small
                  >{snapshot.signature ? 'Signed' : 'No transaction'}</small
                ></span
              ><button
                class="secondary-button"
                disabled={!snapshot.disclosed || busy || unresolved}
                onclick={() => session.sign()}
                >{snapshot.signature ? 'Sign again' : 'Sign request'}</button
              >
            </li>
            <li>
              <span
                ><b>2</b><strong>Preflight</strong><small
                  >{snapshot.simulation === 'passed'
                    ? 'Passed'
                    : 'No transaction'}</small
                ></span
              ><button
                class="secondary-button"
                disabled={!snapshot.signature || busy || unresolved}
                onclick={() => session.simulate()}>Check before sending</button
              >
            </li>
          </ol>
          <button
            class="primary-button wide-button"
            disabled={!snapshot.signature ||
              snapshot.simulation !== 'passed' ||
              !snapshot.disclosed ||
              busy ||
              unresolved}
            onclick={() => session.submit()}
            >Issue {formatGrams(request.amount)} g <Glyph
              name="arrow"
              size={15}
            /></button
          >
        {/if}
        {#if reading}<p class="status-line" role="status">
            Reading JSON locally…
          </p>{/if}
        {#if workspaceView === 'transfer' && fileError}<p
            class="inline-error"
            role="alert"
          >
            {fileError}
          </p>{/if}
        {#if snapshot.busy}<p class="status-line" role="status">
            {snapshot.busy === 'confirming'
              ? 'Checking the transaction outcome…'
              : `${snapshot.busy.charAt(0).toUpperCase()}${snapshot.busy.slice(1)}…`}
          </p>{/if}
        {#if snapshot.error}<p class="inline-error" role="alert">
            {snapshot.error}
          </p>{/if}
        {#if snapshot.pendingOperation}<p class="status-line" role="status">
            Finish or close the open wallet prompt. New wallet actions are
            paused.
          </p>{/if}
      </section>

      <ol class="flow-rail" aria-label="Issuance progress">
        {#each flowSteps as step, index}
          <li
            class:done={step.done}
            class:current={!snapshot.receipt && index === activeStep}
            aria-current={!snapshot.receipt && index === activeStep
              ? 'step'
              : undefined}
          >
            <span>{step.done ? '✓' : index + 1}</span><small>{step.label}</small
            >
          </li>
        {/each}
      </ol>
    </section>

    <section
      id="transfer"
      class="transfer-stage"
      aria-labelledby="token-title"
      hidden={workspaceView !== 'transfer'}
    >
      <div class="stage-copy">
        <p class="scene-kicker">Token transfer</p>
        <h1 id="token-title">Move your gold.</h1>
        <p>Send any amount in 0.001 g units.</p>
      </div>
      <div class="transfer-card">
        <div class="token-balance">
          <span>Wallet balance</span><strong
            >{snapshot.balanceMg === undefined
              ? '—'
              : `${formatGrams(snapshot.balanceMg)} g`}</strong
          ><button
            class="text-link"
            disabled={!connected || busy || !!snapshot.pendingOperation}
            onclick={() => session.refreshBalance()}>Refresh</button
          >
        </div>
        {#if tokenNeedsRecovery && snapshot.tokenIntent}
          <div
            class="transaction-card"
            role="region"
            aria-label="Unknown wallet outcome"
          >
            <h2>Check your wallet</h2>
            <p>
              This exact token action may have been sent. New wallet actions are
              paused until it is reconciled.
            </p>
            <div class="intent-summary" aria-label="Frozen token intent">
              <strong
                >{snapshot.tokenIntent.kind === 'transfer'
                  ? `${formatGrams(BigInt(snapshot.tokenIntent.milligrams))} g transfer`
                  : 'Token association'}</strong
              >
              <span>From · {snapshot.tokenIntent.account}</span>
              {#if snapshot.tokenIntent.kind === 'transfer'}
                <span>To · {snapshot.tokenIntent.recipient}</span>
              {/if}
            </div>
            <label class="text-field"
              >Transaction hash<input
                type="text"
                placeholder="0x…"
                bind:value={recoveryHash}
                disabled={busy}
                spellcheck="false"
              /></label
            >
            <div class="button-row">
              <button
                class="primary-button"
                disabled={busy || !recoveryHash}
                onclick={recoverWalletTransaction}>Reconcile hash</button
              >
              <button
                class="secondary-button"
                disabled={busy || !!snapshot.pendingOperation}
                onclick={() => session.acknowledgeNotSent()}
                >Nothing was sent</button
              >
            </div>
          </div>
        {/if}
        {#if tokenBackend === 'hts'}
          <button
            class="secondary-button"
            disabled={!connected || busy || unresolved}
            onclick={() => session.associate()}>Associate this token</button
          >
          <p class="field-hint">
            The chain checks whether association is needed.
          </p>
        {:else if tokenBackend === 'ats'}
          <p class="field-hint">Transfers use the connected wallet.</p>
        {/if}
        <label class="text-field"
          >Recipient<input
            type="text"
            aria-label="Transfer recipient"
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
          >
          <button
            class="secondary-button"
            disabled={!snapshot.deployment || !ethereumRpc || busy}
            onclick={resolveRecipient}>Resolve ENS recipient</button
          >
          <p class="field-hint">
            This sends the name to your Ethereum RPC. Check the resolved address
            before transferring.
          </p>
        {/if}
        {#if ens}<div class="resolved-address">
            <strong>{ens.normalizedName} → Chain {ens.chainId}</strong><code
              >{ens.address}</code
            ><small
              >Locked for this transfer · Ethereum block {ens.blockNumber.toString()}.</small
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
        <button
          class="primary-button wide-button"
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
      </div>
    </section>

    <aside class="activity-rail" aria-label="Session and transaction status">
      <section>
        <div class="rail-heading"><span>Session</span></div>
        <dl class="session-list">
          <div>
            <dt>Network</dt>
            <dd>{networkLabel}</dd>
          </div>
          <div>
            <dt>Wallet</dt>
            <dd>
              {snapshot.wallet ? snapshot.wallet.address : 'Not connected'}
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              {request ? `${formatGrams(request.amount)} g XAU` : 'Not loaded'}
            </dd>
          </div>
        </dl>
        {#if fileError}<p class="inline-error" role="alert">{fileError}</p>{/if}
      </section>
      <section>
        <div class="rail-heading"><span>Activity</span></div>
        {#if !snapshot.transaction && !snapshot.tokenTransaction}
          <p class="empty-activity">No transactions yet.</p>
        {:else}
          {#if snapshot.transaction}<div class="activity-item">
              <span>Issuance</span><strong
                >{snapshot.transaction.outcome}</strong
              ><code>{snapshot.transaction.hash}</code>
            </div>{/if}
          {#if snapshot.tokenTransaction}<div class="activity-item">
              <span
                >{snapshot.tokenTransaction.kind === 'transfer'
                  ? 'Transfer'
                  : 'Association'}</span
              ><strong>{snapshot.tokenTransaction.outcome}</strong><code
                >{snapshot.tokenTransaction.hash}</code
              >{#if ['pending', 'unresolved'].includes(snapshot.tokenTransaction.outcome)}<button
                  class="text-link"
                  disabled={busy}
                  onclick={() => session.confirmToken()}
                  >Check transaction</button
                >{/if}
            </div>{/if}
        {/if}
      </section>
      {#if snapshot.deployment}
        <details class="technical-details">
          <summary>Test configuration</summary>
          <div class="compact-files">
            <label
              >Change profile<input
                class="sr-only"
                type="file"
                accept=".json,application/json"
                aria-label="Import deployment configuration"
                disabled={busy || unresolved}
                onchange={(event) => importFile(event, 'deployment')}
              /></label
            >
            {#if request}<label
                >Change package<input
                  class="sr-only"
                  type="file"
                  accept=".json,application/json"
                  aria-label="Import issuance bundle"
                  disabled={busy || unresolved}
                  onchange={(event) => importFile(event, 'bundle')}
                /></label
              >{/if}
          </div>
          <dl class="data-list">
            <div>
              <dt>Profile</dt>
              <dd>{deploymentName || 'Loaded JSON'}</dd>
            </div>
            {#if request}<div>
                <dt>Package</dt>
                <dd>{bundleName || 'Loaded JSON'}</dd>
              </div>{/if}
            <div>
              <dt>RPC</dt>
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
              <dt>Backend</dt>
              <dd>
                {tokenBackend === 'ats'
                  ? 'ATS · EVM token'
                  : 'HTS · native token'}
              </dd>
            </div>
            <div>
              <dt>Verifier</dt>
              <dd>{snapshot.deployment.auditPolicy.verifierAddress}</dd>
            </div>
          </dl>
        </details>
      {/if}
    </aside>
  </main>

  <footer class="live-footer">
    <Glyph name="lock" size={14} /> Files stay in this browser. Private keys are never
    requested.
  </footer>
</div>
