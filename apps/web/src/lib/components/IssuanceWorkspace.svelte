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
  } from '../issuance';
  import { resolveEnsRecipient } from '../../../../../packages/issuance/src/index.js';
  import Glyph from '../prototype/Glyph.svelte';
  import OrbitField from '../prototype/OrbitField.svelte';

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
  let ens = $state<Awaited<ReturnType<typeof resolveEnsRecipient>>>();
  let resolutionVersion = 0;
  function clearEns() {
    resolutionVersion++;
    ens = undefined;
  }
  let connected = $derived(!!snapshot.wallet);
  let busy = $derived(!!snapshot.busy || reading || resolving);
  let unresolved = $derived(
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
      }
    } catch (error) {
      fileError =
        error instanceof IssuanceClientError
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
    } catch {
      transferError =
        'ENS resolution did not complete. Check the name, Ethereum RPC and intended chain.';
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
    <span class="mode-pill">Test source · real transactions</span>
    <a class="text-link" href="/verify/"
      >Verify a receipt <Glyph name="arrow" size={15} /></a
    >
  </header>

  <main id="issuance" tabindex="-1" class="issuance-layout">
    <section class="issuance-visual" aria-labelledby="issuance-title">
      <p class="overline">One complete right. One issuance.</p>
      <h1 id="issuance-title">A right.<br /><em>A new form.</em></h1>
      <p class="visual-lede">
        Issue exactly the quantity in your signed claim. After issuance,
        transfer any whole milligram.
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
          >Current profile: synthetic signed capsule. No real bank
          authorization, gold backing or redemption is established.</span
        >
      </p>
    </section>

    <section class="issuance-controls" aria-label="Issue a complete claim">
      <div class="control-heading">
        <p class="overline">Prepare your issuance</p>
        <span class="network-label"
          >{snapshot.deployment
            ? `Chain ${snapshot.deployment.auditPolicy.chainId}`
            : 'No deployment loaded'}</span
        >
      </div>
      <div class="file-pair">
        <label class="file-control"
          ><span><b>01</b> Deployment configuration</span><small
            >{deploymentName ||
              `Independent trust pins · JSON · ${MAX_DEPLOYMENT_BYTES / 1024} KB max`}</small
          ><input
            type="file"
            accept=".json,application/json"
            aria-label="Import deployment configuration"
            disabled={busy || unresolved}
            onchange={(event) => importFile(event, 'deployment')}
          /></label
        >
        <label class="file-control"
          ><span><b>02</b> Issuance bundle</span><small
            >{bundleName ||
              'Bound request, proof and issuer permit · 160 KB max'}</small
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
        Choose the deployment from a source you trust independently of the
        claim. Importing a file does not connect to its RPC.
      </p>
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

      <div class="wallet-row">
        <div>
          <span class="overline">Your wallet</span>
          <p>
            {snapshot.wallet
              ? snapshot.wallet.address
              : snapshot.providerAvailable
                ? 'Connect the wallet bound to this claim.'
                : 'No injected wallet detected. Open this page with an EIP-1193 wallet.'}
          </p>
        </div>
        <button
          class="secondary-button"
          disabled={!snapshot.providerAvailable || !snapshot.deployment || busy}
          onclick={() => session.connect()}
          ><Glyph name="wallet" size={16} />{connected
            ? 'Reconnect'
            : 'Connect'}</button
        >
      </div>

      <div class="check-row">
        <div>
          <strong>Source proof & issuer permit</strong><span
            >{snapshot.sourceProof === 'accepted'
              ? 'Accepted by the pinned verifier and current registry checks.'
              : 'Unchecked. Imported bytes alone do not establish validity.'}</span
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

      <label class="disclosure-control"
        ><input
          type="checkbox"
          checked={snapshot.disclosed}
          disabled={busy || !!snapshot.transaction || unresolved}
          onchange={(event) => session.disclose(event.currentTarget.checked)}
        /><span
          >I understand that the full quantity, wallet and request data become
          public at onchain reservation/submission, including before a
          successful mint. This test source grants no real gold rights.</span
        ></label
      >

      <ol class="action-list">
        <li>
          <span
            ><b>1</b><strong>Sign the fixed request</strong><small
              >{snapshot.signature
                ? 'Holder signature checked'
                : 'No amount can be edited'}</small
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
            ><b>2</b><strong>Run a preflight call</strong><small
              >{snapshot.simulation === 'passed'
                ? 'Call succeeded; no transaction sent'
                : 'Check current Gate execution'}</small
            ></span
          ><button
            class="secondary-button"
            disabled={!snapshot.signature ||
              busy ||
              !!snapshot.transaction ||
              unresolved}
            onclick={() => session.simulate()}>Run preflight</button
          >
        </li>
        <li>
          <span
            ><b>3</b><strong>Submit for issuance</strong><small
              >Wallet confirms a real transaction</small
            ></span
          ><button
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
        </li>
      </ol>
      {#if snapshot.busy}<p class="status-line" role="status">
          {snapshot.busy === 'confirming'
            ? 'Waiting for the actual transaction outcome…'
            : `${snapshot.busy.charAt(0).toUpperCase()}${snapshot.busy.slice(1)}…`}
        </p>{/if}
      {#if snapshot.error}<p class="inline-error" role="alert">
          {snapshot.error}
        </p>{/if}

      {#if snapshot.unknownSubmission}
        <section class="transaction-card" aria-label="Unknown wallet outcome">
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
            disabled={busy}
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
              recipient. The configured Gate's exact issuance event was checked.
            </p>
            <button
              class="secondary-button"
              onclick={() =>
                saveJson(
                  snapshot.receipt,
                  'ultratokenizer-issuance-receipt.json',
                )}>Save issuance receipt</button
            >
          {:else}<p>
              Keep this hash and this page open until reconciliation completes.
              Sending a transaction is not confirmation.
            </p>
            <button
              class="primary-button"
              disabled={busy || snapshot.transaction.outcome === 'reverted'}
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

    <section class="token-workspace" aria-labelledby="token-title">
      <div>
        <p class="overline">After issuance</p>
        <h2 id="token-title">A whole claim.<br /><em>Divisible tokens.</em></h2>
        <p>
          One base unit is one milligram.
          {#if tokenBackend === 'hts'}
            HTS association and transfers are separate wallet transactions.
          {:else if tokenBackend === 'ats'}
            ATS token transfers are wallet transactions.
          {:else}
            Import a deployment to use its token.
          {/if}
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
            disabled={!connected || busy}
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
            Explicitly sends this name to your Ethereum RPC. ENS has no
            institution authority.
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
            placeholder="Up to three decimal places"
            bind:value={transferAmount}
            disabled={busy}
          /></label
        >
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
        {#if transferError}<p class="inline-error" role="alert">
            {transferError}
          </p>{/if}
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
              Frozen before sending. Wallet and form changes preserve this
              intended action for reconciliation.
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
