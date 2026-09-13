<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { EIP1193Provider } from 'viem';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createIssuanceSession } from '../application/issuance-session';
  import { fetchHostedDeployment } from '../application/hosted-deployment';
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
  import EvidenceArtifact from '../visuals/EvidenceArtifact.svelte';
  import AppHeader from './AppHeader.svelte';
  import JsonFileInput from './JsonFileInput.svelte';
  import DocumentJourney from './DocumentJourney.svelte';

  const session = createIssuanceSession();
  let snapshot = $state(session.read());
  let fileError = $state('');
  let setupError = $state('');
  let operatorMode = $state(false);
  let configurationInput = $state<HTMLInputElement>();
  let reading = $state(false);
  let deploymentName = $state('');
  let bundleName = $state('');
  let documentAmount = $state<string>();
  let transferRecipient = $state('');
  let transferAmount = $state('');
  let ethereumRpc = $state('');
  let resolving = $state(false);
  let transferError = $state('');
  let recoveryHash = $state('');
  let walletHelp = $state(false);
  let workspaceView = $derived<'issue' | 'transfer'>(
    page.url.hash === '#transfer' ? 'transfer' : 'issue',
  );
  let setupDialog = $state<HTMLDialogElement>();
  let setupOpen = $state(false);
  let networkStatus = $state<'loading' | 'missing' | 'failed' | 'loaded'>(
    'loading',
  );
  let networkLoad: AbortController | undefined;
  let ens = $state<Awaited<ReturnType<typeof resolveEnsRecipient>>>();
  let resolutionVersion = 0;

  function clearEns() {
    resolutionVersion++;
    ens = undefined;
  }

  function connectWallet() {
    if (!snapshot.providerAvailable) {
      walletHelp = true;
      return;
    }
    walletHelp = false;
    void (walletNeedsTestnet ? session.switchToTestnet() : session.connect());
  }

  let connected = $derived(!!snapshot.wallet);
  let walletNeedsTestnet = $derived(
    connected &&
      snapshot.deployment?.auditPolicy.chainId === '296' &&
      snapshot.wallet?.chainId !== '296',
  );
  let walletOnConfiguredChain = $derived(
    connected &&
      snapshot.wallet?.chainId === snapshot.deployment?.auditPolicy.chainId,
  );
  let busy = $derived(
    !!snapshot.busy || reading || resolving || networkStatus === 'loading',
  );
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
  let recipientConnected = $derived(
    walletOnConfiguredChain &&
      snapshot.wallet?.address.toLowerCase() ===
        request?.recipient.toLowerCase(),
  );
  let tokenBackend = $derived(
    snapshot.deployment ? getTokenBackend(snapshot.deployment) : undefined,
  );
  let networkLabel = $derived(
    snapshot.deployment
      ? snapshot.deployment.auditPolicy.chainId === '296'
        ? 'Hedera testnet'
        : `Test chain ${snapshot.deployment.auditPolicy.chainId}`
      : 'Not configured',
  );
  let issuanceStarted = $derived(
    !!snapshot.transaction || snapshot.unknownSubmission === 'issuance',
  );
  let flowSteps = $derived([
    { label: 'Proof', done: !!request },
    { label: 'Wallet', done: recipientConnected || issuanceStarted },
    {
      label: 'Verify',
      done: snapshot.sourceProof === 'accepted' || issuanceStarted,
    },
    { label: 'Sign', done: !!snapshot.signature || issuanceStarted },
    { label: 'Mint', done: !!snapshot.receipt },
    { label: 'Receipt', done: !!snapshot.receipt },
  ]);
  let activeStep = $derived(
    snapshot.receipt
      ? 5
      : snapshot.transaction ||
          snapshot.unknownSubmission === 'issuance' ||
          snapshot.signature
        ? 4
        : !request
          ? 0
          : !recipientConnected
            ? 1
            : snapshot.sourceProof !== 'accepted'
              ? 2
              : 3,
  );

  function openSetup() {
    if (!operatorMode || busy || unresolved) return;
    networkLoad?.abort();
    if (networkStatus === 'loading') networkStatus = 'missing';
    setupError = '';
    setupDialog?.showModal();
    setupOpen = true;
  }

  async function loadNetwork() {
    if (snapshot.deployment) return;
    networkLoad?.abort();
    const controller = new AbortController();
    networkLoad = controller;
    networkStatus = 'loading';
    try {
      const text = await fetchHostedDeployment(controller.signal);
      if (controller.signal.aborted || session.read().deployment) return;
      if (text === undefined) {
        networkStatus = 'missing';
        return;
      }
      session.loadDeployment(text);
      deploymentName = 'App configuration';
      networkStatus = 'loaded';
    } catch {
      if (!controller.signal.aborted) networkStatus = 'failed';
    }
  }

  // A workspace selection always starts its destination view at the top of
  // the page, both for in-page hash switches and cross-route navigation.
  // A task (not a microtask) runs after SvelteKit's own fragment restore.
  function alignViewTop() {
    setTimeout(() => {
      if (window.scrollY !== 0) window.scrollTo({ top: 0, left: 0 });
    }, 0);
  }

  afterNavigate((navigation) => {
    const target = navigation.to?.url.hash;
    if (
      navigation.type !== 'popstate' &&
      (target === '#engine' || target === '#transfer')
    )
      alignViewTop();
  });

  function selectWorkspace(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest<HTMLAnchorElement>('a');
    if (
      !link ||
      !['#engine', '#transfer'].includes(link.getAttribute('href') ?? '')
    )
      return;
    event.preventDefault();
    // Native same-page fragments bypass navigation hooks. Let SvelteKit own
    // their history and scroll restoration, including repeated selections.
    void goto(link.href, {
      noScroll: true,
      keepFocus: true,
      replaceState: link.href === window.location.href,
    });
  }

  onMount(() => {
    // This only exposes local configuration tools; it grants no chain authority.
    operatorMode =
      new URLSearchParams(window.location.search).get('operator') === '1';
    const unsubscribe = session.subscribe((value) => {
      snapshot = value;
    });
    const candidate = (window as Window & { ethereum?: EIP1193Provider })
      .ethereum;
    const provider =
      candidate && typeof candidate.request === 'function'
        ? candidate
        : undefined;
    const navigation = document.querySelector<HTMLElement>(
      'nav[aria-label="Workspace"]',
    );
    navigation?.addEventListener('click', selectWorkspace);
    session.setProvider(provider);
    void loadNetwork();
    const changed = () => {
      session.walletChanged();
      clearEns();
    };
    provider?.on?.('accountsChanged', changed);
    provider?.on?.('chainChanged', changed);
    provider?.on?.('disconnect', changed);
    return () => {
      networkLoad?.abort();
      provider?.removeListener?.('accountsChanged', changed);
      provider?.removeListener?.('chainChanged', changed);
      provider?.removeListener?.('disconnect', changed);
      navigation?.removeEventListener('click', selectWorkspace);
      unsubscribe();
      session.dispose();
      clearEns();
    };
  });

  async function importFile(
    file: File | undefined,
    kind: 'deployment' | 'bundle',
  ) {
    if (!file || busy || unresolved || (kind === 'deployment' && !operatorMode))
      return;
    reading = true;
    if (kind === 'deployment') setupError = '';
    else fileError = '';
    try {
      const text = await readJsonFile(
        file,
        kind === 'deployment' ? MAX_DEPLOYMENT_BYTES : MAX_BUNDLE_BYTES,
      );
      if (kind === 'deployment') {
        networkLoad?.abort();
        session.loadDeployment(text);
        networkStatus = 'loaded';
        deploymentName = file.name;
        bundleName = '';
        fileError = '';
        clearEns();
        const returnToJourney = setupDialog?.open;
        setupDialog?.close();
        if (returnToJourney) {
          await tick();
          document
            .getElementById(
              workspaceView === 'issue' ? 'issuance-title' : 'token-title',
            )
            ?.focus();
        }
      } else {
        session.loadBundle(text);
        bundleName = file.name;
      }
    } catch (error) {
      const message =
        error instanceof IssuanceClientError || error instanceof BrowserRpcError
          ? error.message
          : 'The file could not be imported. Check its format, size and any pending transaction.';
      if (kind === 'deployment') setupError = message;
      else fileError = message;
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
<div
  class="live-shell"
  class:document-workspace={!operatorMode && workspaceView === 'issue'}
>
  <AppHeader current={workspaceView}>
    {#snippet actions()}
      <button
        class="header-wallet"
        disabled={!!snapshot.busy || unresolved}
        onclick={connectWallet}
        title={snapshot.wallet?.address}
        ><Glyph name="wallet" size={15} />{walletNeedsTestnet
          ? 'Switch to testnet'
          : connected
            ? `${snapshot.wallet?.address.slice(0, 6)}…${snapshot.wallet?.address.slice(-4)}`
            : 'Connect wallet'}</button
      >
    {/snippet}
  </AppHeader>
  {#if walletHelp}
    <p class="wallet-help" role="status">
      No browser wallet found. Open this page in an EVM wallet browser or
      install a browser wallet, then reload.
    </p>
  {/if}

  <main
    id="engine"
    tabindex="-1"
    class="engine-layout"
    class:unavailable={!snapshot.deployment}
  >
    <section
      class="engine-stage"
      aria-labelledby="issuance-title"
      hidden={workspaceView !== 'issue'}
    >
      {#if !operatorMode}
        <DocumentJourney
          {session}
          {snapshot}
          {unresolved}
          {connectWallet}
          {walletNeedsTestnet}
          {networkStatus}
          onamount={(value) => (documentAmount = value)}
        />
      {:else}
        <div class="stage-copy">
          <p class="scene-kicker">
            {#if snapshot.deployment}Proof → token <span
                >{activeStep + 1} / 6</span
              >{:else}How issuance works{/if}
          </p>
          <h1 id="issuance-title" tabindex="-1">
            Proof first. <em>Tokens next.</em>
          </h1>
          <p>
            {#if snapshot.receipt}Your tokens are issued. Keep the receipt.
            {:else if snapshot.transaction?.outcome === 'reverted'}The
              transaction reverted. No tokens were minted.
            {:else if snapshot.transaction || snapshot.unknownSubmission === 'issuance'}Check
              the outcome before continuing.
            {:else if !snapshot.deployment}A gold right becomes transferable
              tokens after proof, issuer approval, and your signature.
            {:else if !request}Tokenize gold with proof and issuer
              authorization.
            {:else if !recipientConnected}Connect the wallet that will receive
              your tokens.
            {:else if snapshot.sourceProof !== 'accepted'}Check the evidence
              before approving the mint.
            {:else if !snapshot.signature}Approve exactly {formatGrams(
                request.amount,
              )} g.
            {:else}One final check, then mint to your wallet.{/if}
          </p>
        </div>

        <EvidenceArtifact
          configured={!!snapshot.deployment}
          amount={request ? formatGrams(request.amount) : undefined}
          verified={snapshot.sourceProof === 'accepted'}
          minted={!!snapshot.receipt}
          outcome={snapshot.transaction?.outcome ??
            (snapshot.unknownSubmission === 'issuance'
              ? 'unresolved'
              : undefined)}
        />

        <ol
          class="flow-rail"
          aria-label={snapshot.deployment
            ? 'Issuance progress'
            : 'Issuance steps'}
        >
          {#each flowSteps as step, index}
            <li
              class:done={step.done}
              class:current={!!snapshot.deployment &&
                !snapshot.receipt &&
                index === activeStep}
              aria-current={!!snapshot.deployment &&
              !snapshot.receipt &&
              index === activeStep
                ? 'step'
                : undefined}
            >
              <span>{step.done ? '✓' : index + 1}</span><small
                >{step.label}</small
              >
            </li>
          {/each}
        </ol>

        <section class="stage-action" aria-label="Current issuance step">
          {#key activeStep}
            {#if snapshot.unknownSubmission === 'issuance'}
              <div
                id="wallet-outcome"
                class="transaction-card"
                role="region"
                aria-label="Unknown wallet outcome"
              >
                <h2>Check your wallet</h2>
                <p>
                  A transaction may have been sent. New submissions are paused.
                </p>
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
                  <span class="status-pill">{snapshot.transaction.outcome}</span
                  >
                </div>
                <code>{snapshot.transaction.hash}</code>
                {#if snapshot.receipt}
                  <p>
                    {formatGrams(snapshot.receipt.request.amount)} g minted.
                  </p>
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
              {#if networkStatus === 'loading'}
                <p role="status">
                  Checking whether gold issuance is available…
                </p>
              {:else}
                <div class="action-copy" role="status">
                  <div>
                    <h2>
                      {networkStatus === 'missing'
                        ? 'Gold issuance is unavailable'
                        : 'Could not check issuance status'}
                    </h2>
                    <p>
                      {networkStatus === 'missing'
                        ? operatorMode
                          ? 'Publish the approved deployment before accepting proof packages.'
                          : 'Issuance will open when the testnet setup is ready. You can connect your wallet now.'
                        : 'The app could not load its network settings. Try again.'}
                    </p>
                  </div>
                </div>
                {#if networkStatus === 'failed'}
                  <button class="secondary-button" onclick={loadNetwork}
                    >Try again</button
                  >
                {/if}
                <a class="text-link" href="/verify/"
                  >Verify a receipt <Glyph name="arrow" size={14} /></a
                >
              {/if}
            {:else if !request}
              <JsonFileInput
                class="upload-button"
                label="Import issuance bundle"
                compact
                disabled={busy || unresolved}
                onfile={(file) => importFile(file, 'bundle')}
                onerror={(message) => (fileError = message)}
                >Add proof package <Glyph
                  name="plus"
                  size={15}
                /></JsonFileInput
              >
              <p class="field-hint">
                Drop one JSON package here, or choose a file.
              </p>
              <details class="upload-help">
                <summary>What can I upload?</summary>
                <p>
                  Get the public proof-and-permit package from your issuer. Its
                  permit lasts at most ten minutes; ask for a fresh permit if it
                  expires. JSON, up to {MAX_BUNDLE_BYTES / 1024} KB. Source PDFs and
                  emails cannot be uploaded here.
                </p>
              </details>
            {:else if !recipientConnected}
              <div class="action-copy">
                <span>02</span>
                <div>
                  <h2>
                    {walletNeedsTestnet
                      ? 'Switch to Hedera testnet'
                      : 'Connect the recipient wallet'}
                  </h2>
                  <p>
                    {walletNeedsTestnet
                      ? 'Your wallet is connected on another network.'
                      : 'The connected address must match the approved recipient.'}
                  </p>
                </div>
              </div>
              <button
                class="primary-button wide-button"
                disabled={busy || unresolved}
                onclick={connectWallet}
                ><Glyph name="wallet" size={16} />
                {walletNeedsTestnet
                  ? 'Switch to Hedera testnet'
                  : 'Connect wallet'}</button
              >
              {#if !snapshot.providerAvailable}
                <p class="field-hint">No browser wallet detected.</p>
              {:else if connected && !walletNeedsTestnet}
                <p class="field-hint">
                  The wallet network or address does not match. Select the
                  recipient account and configured network, then connect again.
                </p>
              {/if}
              <small class="bound-recipient"
                >Recipient · {request.recipient}</small
              >
            {:else if snapshot.sourceProof !== 'accepted'}
              <div class="action-copy">
                <span>03</span>
                <div>
                  <h2>Verify evidence</h2>
                  <p>
                    Check the proof, issuer authorization, and current issuance
                    conditions.
                  </p>
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
                  onclick={() => session.check()}>Verify evidence</button
                >
              </div>
            {:else if !snapshot.signature}
              <div class="action-copy">
                <span>04</span>
                <div>
                  <h2>Sign mint request</h2>
                  <p>
                    Approve the exact amount. This signature sends no
                    transaction.
                  </p>
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
              <button
                class="primary-button wide-button"
                disabled={!snapshot.disclosed || busy || unresolved}
                onclick={() => session.sign()}
                >Sign mint request <Glyph name="arrow" size={15} /></button
              >
            {:else}
              <div class="action-copy">
                <span>05</span>
                <div>
                  <h2>Mint {formatGrams(request.amount)} g</h2>
                  <p>
                    {snapshot.simulation === 'passed'
                      ? 'Check passed. Confirm the mint in your wallet.'
                      : 'Check current conditions before sending the transaction.'}
                  </p>
                </div>
              </div>
              {#if snapshot.simulation !== 'passed'}
                <button
                  class="primary-button wide-button"
                  disabled={!snapshot.signature || busy || unresolved}
                  onclick={() => session.simulate()}
                  >Check before sending</button
                >
              {:else}
                <button
                  class="primary-button wide-button"
                  disabled={!snapshot.signature ||
                    snapshot.simulation !== 'passed' ||
                    !snapshot.disclosed ||
                    busy ||
                    unresolved}
                  onclick={() => session.submit()}
                  >Mint {formatGrams(request.amount)} g <Glyph
                    name="arrow"
                    size={15}
                  /></button
                >
              {/if}
            {/if}
          {/key}
          {#if reading && !setupOpen}<p class="status-line" role="status">
              Reading JSON locally…
            </p>{/if}
          {#if fileError}<p class="inline-error" role="alert">
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
      {/if}
    </section>

    <section
      id="transfer"
      class="transfer-stage"
      aria-labelledby="token-title"
      hidden={workspaceView !== 'transfer'}
    >
      <div class="stage-copy">
        <p class="scene-kicker">Token transfer</p>
        <h1 id="token-title" tabindex="-1">Move your gold.</h1>
        <p>Send any amount in 0.001 g units.</p>
      </div>
      {#if !snapshot.deployment}
        <div class="stage-action" role="status">
          <div class="action-copy">
            <div>
              <h2>Transfers are not available here yet</h2>
              <p>
                Transfers will open when the testnet setup is ready. You can
                connect your wallet now.
              </p>
            </div>
          </div>
        </div>
      {:else}
        <div class="transfer-card">
          {#if walletNeedsTestnet}
            <button
              class="secondary-button"
              disabled={busy || unresolved}
              onclick={connectWallet}>Switch to Hedera testnet</button
            >
          {/if}
          <div class="token-balance">
            <span>Wallet balance</span><strong
              >{snapshot.balanceMg === undefined
                ? '—'
                : `${formatGrams(snapshot.balanceMg)} g`}</strong
            ><button
              class="text-link"
              disabled={!walletOnConfiguredChain || busy || unresolved}
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
                This exact token action may have been sent. New wallet actions
                are paused until it is reconciled.
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
              disabled={!walletOnConfiguredChain || busy || unresolved}
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
              This sends the name to your Ethereum RPC. Check the resolved
              address before transferring.
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
            disabled={!walletOnConfiguredChain ||
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
      {/if}
    </section>

    {#if snapshot.deployment}
      <aside class="activity-rail" aria-label="Session and transaction status">
        <section>
          <div class="rail-heading">
            <span>This session</span><span class="rail-dot"></span>
          </div>
          <dl class="session-list">
            <div>
              <dt>Network</dt>
              <dd>
                {networkLabel}
                <a class="network-link" href="/trust/">View contracts</a>
              </dd>
            </div>
            <div>
              <dt>Wallet</dt>
              <dd>
                {snapshot.wallet ? snapshot.wallet.address : 'Not connected'}
              </dd>
            </div>
            <div>
              <dt>
                {!operatorMode && !request && documentAmount
                  ? 'Document amount'
                  : 'Amount'}
              </dt>
              <dd>
                {request
                  ? `${formatGrams(request.amount)} g XAU`
                  : documentAmount && !operatorMode
                    ? `${formatGrams(documentAmount)} g XAU`
                    : 'Not loaded'}
              </dd>
            </div>
          </dl>
          {#if workspaceView === 'transfer' && fileError}<p
              class="inline-error"
              role="alert"
            >
              {fileError}
            </p>{/if}
        </section>
        <section>
          <div class="rail-heading"><span>Session activity</span></div>
          {#if !snapshot.transaction && !snapshot.tokenTransaction}
            <div class="empty-activity">
              <Glyph name="receipt" size={23} />
              <p>
                {snapshot.unknownSubmission
                  ? 'Transaction outcome unknown.'
                  : 'No transactions yet.'}
              </p>
              <small>
                {snapshot.unknownSubmission
                  ? 'A transaction may have been sent. Check wallet activity.'
                  : 'Your latest transaction status appears here.'}
              </small>
            </div>
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
            <summary>Deployment details</summary>
            <div class="compact-files">
              {#if request && operatorMode}<JsonFileInput
                  label="Import issuance bundle"
                  compact
                  disabled={busy || unresolved}
                  onfile={(file) => importFile(file, 'bundle')}
                  onerror={(message) => (fileError = message)}
                  >Change package</JsonFileInput
                >{/if}
            </div>
            <dl class="data-list">
              <div>
                <dt>Configuration</dt>
                <dd>{deploymentName || 'Loaded JSON'}</dd>
              </div>
              {#if request && operatorMode}<div>
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
                <dt>Proof program</dt>
                <dd>SP1 · sealed-PDF profile</dd>
              </div>
              <div>
                <dt>Verifier</dt>
                <dd>{snapshot.deployment.auditPolicy.verifierAddress}</dd>
              </div>
            </dl>
          </details>
        {/if}
      </aside>
    {/if}
  </main>

  {#if operatorMode}
    <dialog
      class="setup-dialog"
      bind:this={setupDialog}
      onclose={() => (setupOpen = false)}
      aria-labelledby="setup-title"
      aria-describedby="setup-description"
    >
      <div class="setup-heading">
        <span class="scene-kicker">Operator tools</span>
        <button
          class="dialog-close"
          aria-label="Close operator configuration"
          onclick={() => setupDialog?.close()}>×</button
        >
      </div>
      <h2 id="setup-title">Use another deployment</h2>
      <p id="setup-description">
        Replaces this session's network, token, and trusted verifier. Import an
        independently reviewed deployment file, never one supplied by a proof
        package.
      </p>
      <button
        class="upload-button"
        disabled={busy || unresolved}
        aria-describedby="setup-file-hint"
        onclick={() => configurationInput?.click()}
        >Import deployment file <Glyph name="arrow" size={15} /></button
      >
      <input
        bind:this={configurationInput}
        hidden
        type="file"
        accept=".json,application/json"
        aria-label="Import deployment configuration"
        disabled={busy || unresolved}
        onchange={(event) => {
          const input = event.currentTarget;
          void importFile(input.files?.[0], 'deployment');
          input.value = '';
        }}
      />
      <p id="setup-file-hint" class="field-hint">
        Operator export · JSON · up to {MAX_DEPLOYMENT_BYTES / 1024} KB. Applies to
        this tab only.
      </p>
      {#if reading}<p role="status">Checking deployment file…</p>{/if}
      {#if setupError}<p class="inline-error" role="alert">{setupError}</p>{/if}
    </dialog>
  {/if}

  <footer class="live-footer">
    <Glyph name="wallet" size={14} />
    {snapshot.deployment
      ? 'You sign in your wallet. Proofs and transaction details are public.'
      : 'Connecting a wallet does not sign or mint.'}
    {#if operatorMode}
      <nav aria-label="Operator tools">
        <button
          class="text-link"
          disabled={busy || unresolved}
          onclick={openSetup}>Operator configuration</button
        >
      </nav>
    {/if}
  </footer>
</div>

<style>
  .live-footer {
    flex-wrap: wrap;
    padding-block: 16px;
  }
  .live-footer nav {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 16px;
    margin-inline-start: auto;
  }
  @media (max-width: 640px) {
    .live-footer nav {
      width: 100%;
      margin-inline-start: 0;
    }
  }
</style>
