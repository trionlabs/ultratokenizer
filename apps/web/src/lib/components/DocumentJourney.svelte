<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type {
    createIssuanceSession,
    IssuanceSnapshot,
  } from '../application/issuance-session';
  import {
    createDocumentSession,
    documentStatusLabel,
  } from '../application/document-session';
  import { documentBlocker } from '../application/document-client';
  import { formatGrams, saveJson } from '../issuance';
  import Glyph from '../visuals/Glyph.svelte';
  import EvidenceArtifact, {
    type ProofStage,
  } from '../visuals/EvidenceArtifact.svelte';
  import DocumentUpload from './DocumentUpload.svelte';

  let {
    session,
    snapshot,
    unresolved,
    connectWallet,
    walletNeedsTestnet,
    networkStatus,
    onamount,
  }: {
    session: ReturnType<typeof createIssuanceSession>;
    snapshot: IssuanceSnapshot;
    unresolved: boolean;
    connectWallet: () => void;
    walletNeedsTestnet: boolean;
    networkStatus: 'loading' | 'missing' | 'failed' | 'loaded';
    onamount: (amount?: string) => void;
  } = $props();
  const journey = untrack(() => createDocumentSession(session));
  let flow = $state(journey.read());
  let uploadError = $state('');
  let recoveryHash = $state('');
  let detailOpen = $state(false);
  let discardAcknowledged = $state(false);
  const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
  // Every service status reaches the artifact. Only `queued` and `proving` used
  // to, so the picture sat on "Ready to verify" for most of a run while the
  // phase text beside it kept changing.
  const artifactStage: Record<
    NonNullable<typeof flow.status>['status'],
    ProofStage
  > = {
    awaiting_signature: 'waiting',
    blocked: 'attention',
    reserving: 'preparing',
    preparing_proof: 'preparing',
    staging: 'preparing',
    queued: 'queued',
    proving: 'proving',
    proof_ready: 'checking',
    authorizing: 'authorizing',
    ready_to_mint: 'ready',
    attention_required: 'attention',
  };
  let document = $derived(
    flow.document?.document ??
      (flow.job
        ? {
            name: 'Signed document request',
            amountMilligrams: flow.job.prepared.request.amount,
            recipient: flow.job.prepared.request.recipient,
          }
        : undefined),
  );
  let issuer = $derived(flow.configuration?.issuer);
  let terms = $derived(flow.configuration?.terms);
  let amount = $derived(
    snapshot.receipt?.request.amount ??
      snapshot.bundle?.request.amount ??
      document?.amountMilligrams,
  );
  let currentStep = $derived(snapshot.receipt ? 2 : document ? 1 : 0);
  let busy = $derived(
    !!snapshot.busy ||
      !!snapshot.pendingOperation ||
      (!!flow.pending && flow.pending !== 'configuration'),
  );
  let preparingApproval = $derived(
    !flow.started &&
      (flow.pending === 'preparing' ||
        snapshot.busy === 'signing' ||
        snapshot.pendingOperation === 'signing'),
  );
  let requestSigningLabel = $derived(
    snapshot.pendingOperation === 'signing'
      ? 'Request verification still pending…'
      : snapshot.requestSigningPhase === 'awaiting_signature'
        ? 'Awaiting wallet request signature…'
        : snapshot.requestSigningPhase === 'checking_signature'
          ? 'Checking signed request…'
          : 'Checking Hedera authorization…',
  );
  let connecting = $derived(
    snapshot.busy === 'connecting' ||
      snapshot.pendingOperation === 'connecting',
  );
  let walletMatches = $derived(
    !!document &&
      snapshot.wallet?.address.toLowerCase() ===
        document.recipient.toLowerCase() &&
      snapshot.wallet?.chainId === snapshot.deployment?.auditPolicy.chainId,
  );
  let blocker = $derived(
    documentBlocker(
      flow.status?.detailCode ?? flow.document?.readiness.blocker,
    ),
  );
  let hasOutcome = $derived(
    !!snapshot.transaction || snapshot.unknownSubmission === 'issuance',
  );
  let proofAccepted = $derived(snapshot.sourceProof === 'accepted');
  let needsResume = $derived(
    flow.started &&
      !hasOutcome &&
      (!flow.status || flow.status.status === 'awaiting_signature'),
  );
  let canRefreshApproval = $derived(
    flow.errorCode === 'permit_expired' ||
      (flow.status?.phase === 'issuance' &&
        [
          'permit_expired',
          'issuer_unavailable',
          'deployment_unavailable',
        ].includes(flow.status.detailCode ?? '')),
  );

  onMount(() => {
    const unsubscribe = journey.subscribe((value) => {
      flow = value;
      onamount(
        value.document?.document.amountMilligrams ??
          value.job?.prepared.request.amount,
      );
    });
    try {
      journey.restoreStorage(window.sessionStorage);
    } catch {
      /* Browser storage is optional. */
    }
    void journey.loadConfiguration();
    return () => {
      unsubscribe();
      journey.dispose();
    };
  });
  function upload(file: File) {
    uploadError = '';
    void journey.upload(file);
  }
  async function recover() {
    await session.recoverIssuanceHash(recoveryHash);
  }
</script>

<div class="document-journey" class:loaded={!!document}>
  <div class="stage-copy document-heading">
    <p class="scene-kicker">
      Document → token <span>{currentStep + 1} / 3</span>
    </p>
    <h1 id="issuance-title" tabindex="-1">
      Ownership Docs. <em>Verifiably tokenized.</em>
    </h1>
    <p>
      {snapshot.receipt
        ? 'Your tokens are in the recipient wallet. Keep the evidence.'
        : hasOutcome
          ? 'Check the transaction outcome before continuing.'
          : document
            ? 'Review the fixed amount, then verify and mint to your wallet.'
            : 'Start with a signed gold-right document from the selected issuer.'}
    </p>
  </div>

  <div class="journey-evidence">
    <EvidenceArtifact
      configured={true}
      amount={amount ? formatGrams(amount) : undefined}
      verified={proofAccepted}
      minted={!!snapshot.receipt}
      outcome={snapshot.transaction?.outcome ??
        (snapshot.unknownSubmission === 'issuance' ? 'unresolved' : undefined)}
      emptyCaption="Waiting for your document"
      proofStage={flow.status ? artifactStage[flow.status.status] : undefined}
      compact
    />

    <ol class="flow-rail document-steps" aria-label="Issuance progress">
      {#each ['Upload document', 'Verify & mint', 'Review'] as label, index}
        <li
          class:done={index < currentStep || !!snapshot.receipt}
          class:current={index === currentStep}
          aria-current={index === currentStep ? 'step' : undefined}
        >
          <span
            >{index < currentStep || snapshot.receipt ? '✓' : index + 1}</span
          ><small>{label}</small>
        </li>
      {/each}
    </ol>
  </div>

  <section
    class="stage-action document-action"
    aria-label="Current issuance step"
  >
    {#if flow.unreadable && !flow.job}
      <div
        class="transaction-card"
        role="region"
        aria-label="Unreadable saved request"
      >
        <h2>The saved request could not be opened</h2>
        <p>
          An earlier request may still be running. Removing this browser record
          does not cancel the issuer’s work. Contact the issuer to reconcile it.
        </p>
        <label class="disclosure-control">
          <input
            type="checkbox"
            bind:checked={discardAcknowledged}
            disabled={busy || unresolved}
          />
          <span>I understand the earlier request may continue.</span>
        </label>
        <button
          class="secondary-button"
          disabled={!discardAcknowledged ||
            busy ||
            unresolved ||
            !!flow.pending}
          onclick={() => {
            journey.discard(discardAcknowledged);
            discardAcknowledged = false;
          }}>Remove unreadable record</button
        >
      </div>
    {:else if flow.recovery && !snapshot.transaction}
      <div
        class="transaction-card"
        role="region"
        aria-label="Saved wallet outcome"
      >
        <h2>Recover the transaction outcome</h2>
        <p>
          This document already reached the wallet confirmation step. Check its
          original transaction before continuing.
        </p>
        {#if flow.recovery.hash}<code>{flow.recovery.hash}</code>{:else}<label
            class="text-field"
            >Transaction hash<input
              bind:value={recoveryHash}
              placeholder="0x…"
              disabled={busy}
              spellcheck="false"
            /></label
          >{/if}
        <button
          class="primary-button"
          disabled={busy ||
            !snapshot.deployment ||
            (!flow.recovery.hash && !recoveryHash)}
          onclick={() =>
            journey.recoverSubmission(
              flow.recovery?.hash ?? (recoveryHash as `0x${string}`),
            )}>Check saved transaction</button
        >
      </div>
    {:else if snapshot.unknownSubmission === 'issuance'}
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
            bind:value={recoveryHash}
            placeholder="0x…"
            disabled={busy}
            spellcheck="false"
          /></label
        >
        <div class="button-row">
          <button
            class="primary-button"
            disabled={busy || !recoveryHash}
            onclick={recover}>Reconcile hash</button
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
            {snapshot.receipt
              ? 'Mint confirmed'
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
          <p>
            <strong>{formatGrams(snapshot.receipt.request.amount)} g</strong>
            minted to
            <span class="address"
              >{short(snapshot.receipt.request.recipient)}</span
            >.
          </p>
          <p class="field-hint">
            The mint delivered the tokens directly to this wallet.
          </p>
          <div class="button-row">
            <button
              class="primary-button"
              onclick={() =>
                saveJson(
                  snapshot.receipt,
                  'ultratokenizer-issuance-receipt.json',
                )}>Save receipt</button
            ><a class="secondary-button" href="/verify/">Verify evidence</a>
          </div>
          <button
            class="text-link"
            disabled={busy || unresolved || !!flow.pending}
            onclick={() => journey.startAnotherDocument()}
            >Start another document</button
          >
          <p class="field-hint">
            Save this receipt before starting another document.
          </p>
          <details>
            <summary>Receipt details</summary>
            <dl class="data-list">
              <div>
                <dt>Recipient</dt>
                <dd>{snapshot.receipt.request.recipient}</dd>
              </div>
              <div>
                <dt>Issuer</dt>
                <dd>{snapshot.receipt.request.issuerId}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>
                  {formatGrams(snapshot.receipt.request.amount)} g · fixed by document
                </dd>
              </div>
            </dl>
          </details>
        {:else if snapshot.transaction.outcome === 'reverted'}
          <p>
            No tokens were minted. The issuer must review this document request
            before another attempt.
          </p>
        {:else}
          <p>
            Tokens are confirmed only after the transaction and issuance events
            have been checked.
          </p>
          <button
            class="primary-button"
            disabled={busy}
            onclick={() => session.confirm()}>Check transaction outcome</button
          >
        {/if}
        {#if snapshot.transaction.outcome === 'unresolved'}
          <label class="text-field"
            >Recovered transaction hash<input
              bind:value={recoveryHash}
              placeholder="0x…"
              disabled={busy}
              spellcheck="false"
            /></label
          >
          <button
            class="secondary-button"
            disabled={busy || !recoveryHash}
            onclick={recover}>Reconcile recovered hash</button
          >
        {/if}
      </div>
    {:else}
      {#if !document}
        <DocumentUpload
          disabled={busy || unresolved}
          onfile={upload}
          onerror={(message) => (uploadError = message)}
        />
        <p class="document-privacy">
          Your signed document is sent to this app’s document service for
          authentication and proof preparation.
        </p>
      {:else}
        <div class="document-summary">
          <div>
            <small>Signed document</small><strong>{document.name}</strong>
          </div>
          <div class="fixed-amount">
            <small>Fixed amount</small><strong
              >{formatGrams(document.amountMilligrams)} <span>g</span></strong
            >
          </div>
        </div>
      {/if}

      {#if issuer}
        <div class="issuer-card" aria-label="Selected issuer">
          <span class="issuer-mark"><Glyph name="wallet" size={17} /></span>
          <div>
            <small>Selected issuer</small><strong>{issuer.label}</strong><span
              class="issuer-context"
              >{short(issuer.wallet)} · ERC-8004 #{issuer.agentId}</span
            >
          </div>
          <button
            class="text-link"
            aria-expanded={detailOpen}
            onclick={() => (detailOpen = !detailOpen)}
            >{detailOpen ? 'Hide details' : 'Details'}</button
          >
        </div>
        {#if detailOpen && terms}
          <div class="issuer-details">
            <dl class="data-list">
              <div>
                <dt>Issuer wallet</dt>
                <dd>{issuer.wallet}</dd>
              </div>
              <div>
                <dt>Issuer ID</dt>
                <dd>{issuer.issuerId}</dd>
              </div>
              <div>
                <dt>Identity registry</dt>
                <dd>{issuer.identityRegistry}</dd>
              </div>
            </dl>
            <p>
              ERC-8004 identifies this issuer. Gate authorization is checked
              separately before the wallet approval and mint.
            </p>
            <p>
              {terms.checked
                ? `Terms matched Gate at block ${terms.blockNumber}.`
                : 'Gate terms could not be confirmed. Verification is unavailable.'}
              Text hashes are checked locally.
            </p>
            <details>
              <summary>Policy terms</summary>
              <p class="terms-text">{terms.policy.text}</p>
              <code>{terms.policy.hash}</code>
            </details>
            <details>
              <summary>Rights terms</summary>
              <p class="terms-text">{terms.rights.text}</p>
              <code>{terms.rights.hash}</code>
            </details>
          </div>
        {/if}
      {:else if flow.pending === 'configuration'}
        <p class="field-hint" role="status">Loading issuer details…</p>
      {/if}

      {#if document}
        <div class="document-phases" aria-label="Verification and mint phases">
          <div class:phase-done={proofAccepted}>
            <span>2a</span>
            <div>
              <strong>Verify with SP1</strong>
              <p>
                {proofAccepted
                  ? 'Proof and issuer approval verified.'
                  : flow.status
                    ? documentStatusLabel[flow.status.status]
                    : 'Approve the request, then generate and check its proof.'}
              </p>
            </div>
          </div>
          <div>
            <span>2b</span>
            <div>
              <strong>Mint to wallet</strong>
              <p>
                The Gate checks the proof and mints directly to your wallet.
              </p>
            </div>
          </div>
        </div>
        <div class="bound-recipient">
          <span>Recipient wallet</span><code>{document.recipient}</code>
        </div>
        {#if !walletMatches}
          <button
            class="primary-button"
            disabled={busy || unresolved}
            aria-busy={connecting}
            onclick={connectWallet}
            ><Glyph name="wallet" size={16} />{connecting
              ? 'Connecting…'
              : walletNeedsTestnet
                ? 'Switch to Hedera testnet'
                : 'Connect recipient wallet'}</button
          >
          {#if snapshot.wallet && !walletNeedsTestnet}<p class="field-hint">
              Select the recipient account shown above, then connect again.
            </p>{/if}
        {:else if proofAccepted && snapshot.signature}
          {#if snapshot.simulation !== 'passed'}
            <button
              class="primary-button"
              disabled={busy || unresolved}
              onclick={() => session.simulate()}>Check before minting</button
            >
          {:else}
            <button
              class="primary-button"
              disabled={busy || unresolved || !snapshot.disclosed}
              onclick={() => session.submit()}
              >Mint {formatGrams(document.amountMilligrams)} g <Glyph
                name="arrow"
                size={15}
              /></button
            >
          {/if}
        {:else if needsResume}
          <button
            class="primary-button"
            disabled={busy || unresolved}
            onclick={() => journey.resume()}>Resume verification</button
          >
          <p class="field-hint">
            Check the saved approval and start this same request only if the
            service has not begun. No new wallet signature is needed.
          </p>
        {:else if !flow.started}
          <label class="disclosure-control"
            ><input
              type="checkbox"
              checked={flow.reviewed}
              disabled={busy || unresolved}
              onchange={(event) =>
                journey.disclose(event.currentTarget.checked)}
            /><span
              >I understand this is a synthetic test document. It proves no bank
              backing or redemption. The exact amount and recipient may be
              public onchain.</span
            ></label
          >
          <button
            class="primary-button"
            disabled={!flow.reviewed ||
              busy ||
              unresolved ||
              !snapshot.deployment ||
              !flow.document?.readiness.canStart}
            aria-busy={preparingApproval}
            onclick={() => journey.verifyAndMint()}
            >{preparingApproval ? requestSigningLabel : 'Verify & mint'}
            <Glyph name="arrow" size={15} /></button
          >
          {#if preparingApproval}
            <p class="field-hint request-signing-status" role="status">
              {requestSigningLabel} No SP1 proof request has been submitted yet.
            </p>
          {:else}
            <p class="field-hint">
              First sign the exact request. After proof verification, confirm a
              separate mint transaction.
            </p>
          {/if}
        {/if}
        {#if snapshot.preparedGatePaused}<p class="field-hint">
            Proof preparation is available. Minting is paused by the Gate.
          </p>{/if}
        {#if flow.started && !hasOutcome && !proofAccepted}
          {#if canRefreshApproval}
            <button
              class="secondary-button"
              disabled={busy || unresolved || !walletMatches || !flow.job}
              onclick={() => journey.refreshPermit()}
              >Refresh issuer approval</button
            >
          {:else}
            <button
              class="secondary-button"
              disabled={busy}
              aria-busy={flow.pending === 'checking'}
              onclick={() => journey.checkStatus()}
              >{flow.pending === 'checking'
                ? 'Checking status…'
                : 'Refresh status'}</button
            >
            <p class="field-hint">
              {#if flow.statusCheckedAt}
                Checked at {new Date(flow.statusCheckedAt).toLocaleTimeString(
                  'en-GB',
                )}.
              {/if}
              {#if flow.status && !['blocked', 'attention_required', 'ready_to_mint'].includes(flow.status.status) && !flow.error}
                Updates automatically while this request runs.
              {/if}
            </p>
          {/if}
        {/if}
        {#if blocker}<p class="stage-notice" role="status">{blocker}</p>{/if}
        {#if !snapshot.deployment}<p class="stage-notice" role="status">
            {networkStatus === 'loading'
              ? 'Loading the testnet configuration…'
              : 'The testnet configuration is unavailable. Your document has been inspected; verification cannot start yet.'}
          </p>{/if}
        {#if !flow.started && !busy}<details class="change-document">
            <summary>Use another document</summary><DocumentUpload
              label="Change document"
              disabled={busy || unresolved}
              onfile={upload}
              onerror={(message) => (uploadError = message)}
            />
          </details>{/if}
      {/if}
    {/if}

    {#if flow.pending && flow.pending !== 'configuration' && !preparingApproval}<p
        class="status-line"
        role="status"
      >
        {flow.pending === 'upload'
          ? 'Authenticating the signed document…'
          : flow.pending === 'starting'
            ? 'Starting document verification…'
            : flow.pending === 'checking'
              ? 'Checking the existing proof request…'
              : flow.pending === 'approval'
                ? 'Refreshing issuer approval…'
                : snapshot.busy === 'signing'
                  ? 'Approve the request in your wallet…'
                  : 'Checking the exact issuance request…'}
      </p>{/if}
    {#if snapshot.busy && !flow.pending && !preparingApproval}<p
        class="status-line"
        role="status"
      >
        {snapshot.busy === 'connecting'
          ? 'Connecting to your wallet…'
          : snapshot.busy === 'confirming'
            ? 'Checking the transaction outcome…'
            : snapshot.busy === 'submitting'
              ? 'Confirm the mint in your wallet…'
              : snapshot.busy === 'simulating'
                ? 'Checking current mint conditions…'
                : snapshot.busy === 'signing'
                  ? 'Approve the request in your wallet…'
                  : 'Checking the issuance request…'}
      </p>{/if}
    {#if uploadError || flow.error}<p class="inline-error" role="alert">
        {uploadError || flow.error}
      </p>{/if}
    {#if snapshot.error}<p class="inline-error" role="alert">
        {snapshot.error}
        {#if flow.job && !flow.started}
          The SP1 request has not been submitted.
        {/if}
      </p>{/if}
    {#if !issuer && !flow.pending}<button
        class="text-link"
        onclick={() => journey.loadConfiguration()}
        >Reload issuer details</button
      >{/if}
    {#if snapshot.pendingOperation}<p class="stage-notice" role="status">
        Wait for the current check to finish. If your wallet has an open prompt,
        finish or close it before starting another action.
      </p>{/if}
  </section>
</div>

<style>
  .document-journey,
  .document-heading {
    min-width: 0;
  }
  .document-heading > * {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .document-heading h1 {
    font-size: clamp(2.2rem, 3.5vw, 2.8rem);
    margin: 10px 0 8px;
  }
  .document-heading > p:last-child {
    font-size: 12px;
    line-height: 1.5;
  }
  .document-heading .scene-kicker {
    margin: 0;
  }
  .document-action {
    width: min(100%, 570px);
    margin: 14px auto 0;
    padding: 0;
    display: grid;
    justify-items: center;
    gap: 10px;
  }
  .document-steps {
    max-width: 570px;
    margin-inline: auto;
    margin-top: 12px;
    grid-template-columns: repeat(3, 1fr);
  }
  .document-steps li {
    flex: 1;
  }
  .document-summary {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 17px 0;
    border-block: 1px solid var(--p-line);
  }
  .document-summary > div,
  .issuer-card > div {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .document-summary small,
  .issuer-card small {
    color: var(--p-muted);
    font-size: 10px;
  }
  .document-summary strong {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .fixed-amount {
    text-align: right;
    flex-shrink: 0;
  }
  .fixed-amount strong {
    font-size: 25px;
    font-weight: 550;
    letter-spacing: -0.7px;
  }
  .fixed-amount span {
    font-size: 14px;
  }
  .issuer-card {
    width: 100%;
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--p-line);
    border-radius: 16px;
    background: var(--p-paper);
  }
  .issuer-mark {
    display: grid;
    place-items: center;
    width: 35px;
    height: 35px;
    border-radius: 50%;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    flex-shrink: 0;
  }
  .issuer-card strong {
    font-size: 13px;
  }
  .issuer-context {
    font-size: 10px;
    color: var(--p-muted);
  }
  .issuer-card button {
    margin-left: auto;
    flex-shrink: 0;
  }
  .issuer-details {
    width: 100%;
    padding: 0 16px 16px;
    font-size: 11px;
    color: var(--p-muted);
    line-height: 1.6;
  }
  .issuer-details details {
    margin-top: 12px;
  }
  .issuer-details summary {
    cursor: pointer;
    color: var(--p-ink);
  }
  .issuer-details code {
    overflow-wrap: anywhere;
    font-size: 9px;
  }
  .terms-text {
    white-space: pre-wrap;
    max-height: 220px;
    overflow: auto;
  }
  /* Numbered circles on a connecting rail, the same idiom .flow-rail already
     uses, so a phase badge reads the same here as in the main issuance flow. */
  .document-phases {
    width: 100%;
    display: grid;
    gap: 0;
    padding: 3px 0;
  }
  .document-phases > div {
    position: relative;
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding-bottom: 15px;
  }
  .document-phases > div:last-child {
    padding-bottom: 0;
  }
  .document-phases > div:not(:last-child)::after {
    content: '';
    transition: background 300ms;
    position: absolute;
    left: 13px;
    top: 30px;
    bottom: 5px;
    width: 1px;
    background: var(--p-line);
  }
  .document-phases > div > span {
    position: relative;
    z-index: 1;
    transition:
      color 300ms,
      background 300ms,
      border-color 300ms;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid var(--p-line);
    background: var(--p-canvas);
    color: var(--p-muted);
    font-size: 0.64rem;
    font-weight: 700;
  }
  .document-phases strong {
    display: block;
    font-size: 0.8rem;
    font-weight: 650;
    line-height: 26px;
  }
  .document-phases p {
    margin: 1px 0 0;
    color: var(--p-muted);
    font-size: 0.72rem;
    line-height: 1.5;
  }
  /* A finished phase has to be visible on the badge, not only in the title. */
  .phase-done > span {
    border-color: var(--p-accent);
    background: var(--p-accent-soft);
    color: var(--p-accent);
  }
  .phase-done::after {
    background: var(--p-accent);
  }
  .phase-done strong {
    color: var(--p-accent);
  }
  .bound-recipient {
    margin: 0;
    font-size: 10px;
    width: 100%;
    overflow-wrap: anywhere;
    display: grid;
    gap: 5px;
  }
  .bound-recipient > span {
    color: var(--p-muted);
  }
  .bound-recipient code {
    color: var(--p-ink);
    font-size: 11px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .document-privacy {
    max-width: 350px;
    margin: -3px 0 0;
    text-align: center;
    font-size: 10px;
    color: var(--p-muted);
    line-height: 1.6;
  }
  .loaded .document-action {
    width: 100%;
    margin-top: 18px;
    padding: 20px;
    gap: 12px;
    justify-items: stretch;
    text-align: left;
    border: 1px solid var(--p-line);
    border-radius: 20px;
    background: var(--p-paper);
  }
  .loaded .document-summary {
    align-items: flex-start;
    padding: 0 0 14px;
    border-top: 0;
  }
  .loaded .document-summary strong {
    font-size: 14px;
    line-height: 1.4;
    font-weight: 650;
  }
  .loaded .fixed-amount strong {
    font-size: 28px;
    line-height: 1.15;
    font-weight: 550;
  }
  .loaded .issuer-card {
    padding: 0 0 14px;
    border: 0;
    border-bottom: 1px solid var(--p-line);
    border-radius: 0;
    background: transparent;
  }
  .loaded .issuer-mark {
    display: none;
  }
  .loaded .issuer-card strong {
    line-height: 1.4;
  }
  .loaded .issuer-details {
    padding: 0 0 12px;
    border-bottom: 1px solid var(--p-line);
  }
  .loaded .document-phases {
    gap: 0;
    padding: 0 0 12px;
    border-bottom: 1px solid var(--p-line);
  }
  .loaded .document-phases > div {
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 0;
    padding-bottom: 12px;
  }
  .loaded .document-phases > div:last-child {
    padding-bottom: 0;
  }
  .loaded .document-phases > div::after {
    display: none;
  }
  .loaded .document-phases > div > span {
    width: 36px;
    height: auto;
    display: block;
    border: 0;
    border-radius: 0;
    background: transparent;
    line-height: 20px;
    font-size: 11px;
    font-weight: 500;
  }
  .loaded .document-phases strong {
    font-size: 13px;
    line-height: 20px;
  }
  .loaded .document-phases p {
    margin-top: 3px;
    font-size: 11px;
    line-height: 1.5;
  }
  .loaded .document-action > .primary-button,
  .loaded .document-action > .secondary-button {
    width: 100%;
  }
  .loaded .field-hint,
  .loaded .status-line,
  .loaded .inline-error {
    margin: 0;
    text-align: left;
  }
  .loaded .disclosure-control {
    width: 100%;
    margin: 0;
    font-size: 10px;
    line-height: 1.5;
  }
  .loaded .change-document {
    padding-top: 3px;
  }
  @media (min-width: 981px) {
    .document-journey.loaded {
      display: grid;
      grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
      column-gap: 28px;
      align-items: start;
    }
    .loaded .document-heading {
      grid-column: 1 / -1;
    }
    .loaded .journey-evidence {
      width: 100%;
      max-width: 310px;
      margin: 46px auto 0;
    }
    .loaded .document-action {
      width: 100%;
      margin-top: 18px;
    }
    .loaded .stage-notice {
      padding: 9px 11px;
    }
  }
  .stage-notice {
    width: 100%;
    padding: 12px 14px;
    margin: 0;
    border-radius: 12px;
    background: var(--p-accent-soft);
    color: var(--p-ink);
    font-size: 11px;
    line-height: 1.6;
  }
  .change-document {
    font-size: 10px;
    color: var(--p-muted);
  }
  .change-document summary {
    cursor: pointer;
  }
  .address {
    font-family: monospace;
  }
  @media (max-width: 640px) {
    .document-action {
      gap: 13px;
      margin-top: 18px;
    }
    .issuer-card {
      padding: 12px;
      gap: 9px;
    }
    .issuer-card strong {
      font-size: 12px;
    }
    .issuer-card button {
      font-size: 10px;
    }
  }
</style>
