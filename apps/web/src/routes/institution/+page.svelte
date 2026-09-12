<script lang="ts">
  import { onMount } from 'svelte';
  import { zeroAddress, type EIP1193Provider, type Hex } from 'viem';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import { fetchHostedDeployment } from '$lib/application/hosted-deployment';
  import { createIssuanceSession } from '$lib/application/issuance-session';
  import {
    createAuthorityClient,
    readTrustSnapshot,
    formatUtcTime,
    type AuthorityAction,
    type AuthorityIntent,
    type TrustSnapshot,
  } from '$lib/application/institution-client';
  import {
    createIssuerClient,
    parseClaimProofExport,
    type ClaimProof,
  } from '../../../../../packages/issuance/src/index.js';
  import {
    formatGrams,
    parseTransferGrams,
    parseTransactionHash,
    readJsonFile,
    saveJson,
    MAX_BUNDLE_BYTES,
    IssuanceClientError,
    type IssuanceBundle,
    type DeploymentConfig,
  } from '$lib/issuance';

  const walletSession = createIssuanceSession();
  let walletState = $state(walletSession.read());
  let provider = $state<EIP1193Provider>();
  let deployment = $state<DeploymentConfig>();
  let snapshot = $state<TrustSnapshot>();
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let tab = $state<'issuer' | 'admission'>('issuer');
  let proof = $state<ClaimProof>();
  let proofExport = $state('');
  let proofName = $state('');
  let ledgerReference = $state('');
  let ledgerReviewed = $state(false);
  let reservationPending = $state(false);
  let reservationHash = $state('');
  let reservationConfirmed = $state(false);
  let bundle = $state<IssuanceBundle>();
  let reviewed = $state(false);
  let reviewReference = $state('');
  let expiry = $state('');
  let capGrams = $state('');
  let authorityIntent = $state<AuthorityIntent>();
  let authorityHash = $state('');
  let authorityPending = $state(false);
  let authorityResult = $state('');
  const controller = new AbortController();
  const isIssuer = $derived(
    !!walletState.wallet &&
      !!deployment &&
      walletState.wallet.chainId === deployment.auditPolicy.chainId &&
      walletState.wallet.address === deployment.auditPolicy.issuerAddress,
  );
  const isGovernor = $derived(
    !!walletState.wallet &&
      !!snapshot &&
      walletState.wallet.chainId === deployment?.auditPolicy.chainId &&
      walletState.wallet.address === snapshot.governor,
  );

  async function refresh() {
    if (deployment) snapshot = await readTrustSnapshot(deployment);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    message = '';
    try {
      await action();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'The operation could not complete. Check wallet activity before retrying.';
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    const unsubscribe = walletSession.subscribe((state) => {
      walletState = state;
    });
    const candidate = (window as Window & { ethereum?: EIP1193Provider })
      .ethereum;
    if (candidate && typeof candidate.request === 'function')
      provider = candidate;
    walletSession.setProvider(provider);
    const change = () => {
      walletSession.walletChanged();
      reviewed = false;
      ledgerReviewed = false;
    };
    const events = provider as
      | (EIP1193Provider & {
          on?: (name: string, callback: () => void) => void;
          removeListener?: (name: string, callback: () => void) => void;
        })
      | undefined;
    events?.on?.('accountsChanged', change);
    events?.on?.('chainChanged', change);
    void run(async () => {
      const text = await fetchHostedDeployment(controller.signal);
      if (text !== undefined) {
        walletSession.loadDeployment(text);
        deployment = walletSession.read().deployment;
        await refresh();
      }
      loading = false;
    }).finally(() => {
      loading = false;
    });
    return () => {
      controller.abort();
      unsubscribe();
      walletSession.dispose();
      events?.removeListener?.('accountsChanged', change);
      events?.removeListener?.('chainChanged', change);
    };
  });

  function issuer() {
    if (!provider || !deployment)
      throw new Error('Connect the institution wallet first.');
    return createIssuerClient({ provider, deployment });
  }
  function authority() {
    if (!provider || !deployment)
      throw new Error('Connect the demo authority wallet first.');
    return createAuthorityClient({ provider, deployment });
  }
  function loadProof(file?: File) {
    if (!file || reservationPending) return;
    void run(async () => {
      proof = undefined;
      proofExport = '';
      proofName = '';
      bundle = undefined;
      ledgerReviewed = false;
      reservationHash = '';
      reservationConfirmed = false;
      const text = await readJsonFile(file, MAX_BUNDLE_BYTES);
      const parsed = parseClaimProofExport(text);
      proof = parsed;
      proofExport = text;
      proofName = file.name;
      bundle = undefined;
      ledgerReviewed = false;
      reservationHash = '';
      reservationConfirmed = false;
    });
  }
  async function reserve() {
    if (
      !proof ||
      !ledgerReviewed ||
      !ledgerReference.trim() ||
      reservationPending ||
      !isIssuer
    )
      return;
    const current = proofExport;
    await issuer().connect();
    reservationPending = true;
    try {
      reservationHash = await issuer().openReservation(current);
    } catch (cause) {
      if (
        cause instanceof IssuanceClientError &&
        !['transaction_uncertain', 'transaction_declined'].includes(cause.code)
      )
        reservationPending = false;
      throw cause;
    }
    await reconcileReservation();
  }
  async function reconcileReservation() {
    if (!proof) return;
    const hash = parseTransactionHash(reservationHash);
    const observed = await issuer().waitReservation(proofExport, hash);
    reservationHash = observed.transactionHash;
    reservationConfirmed = true;
    reservationPending = true;
    message =
      'The exact reservation is confirmed. Sign a fresh permit when the holder is ready.';
    await refresh();
  }
  async function permit() {
    if (!proof || !reservationConfirmed || !isIssuer) return;
    const random = crypto.getRandomValues(new Uint8Array(16));
    const nonce = BigInt(
      `0x${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    ).toString();
    bundle = await issuer().signPermit(
      proofExport,
      parseTransactionHash(reservationHash),
      { nonce, validForSeconds: 600 },
    );
    message =
      'Permit signed. Send the downloaded package to the holder; it expires within 10 minutes.';
    saveJson(bundle, 'ultratokenizer-issuance-package.json');
  }
  async function govern(action: AuthorityAction) {
    if (!isGovernor || !reviewed || !reviewReference.trim() || authorityPending)
      return;
    authorityIntent = await authority().prepare(action);
    authorityHash = '';
    authorityResult = '';
    authorityPending = true;
    try {
      authorityHash = await authority().send(authorityIntent);
    } catch (cause) {
      if (
        cause instanceof IssuanceClientError &&
        !['transaction_uncertain', 'transaction_declined'].includes(cause.code)
      )
        authorityPending = false;
      throw cause;
    }
    await reconcileAuthority();
  }
  async function reconcileAuthority() {
    if (!authorityIntent) return;
    const result = await authority().wait(
      authorityIntent,
      parseTransactionHash(authorityHash),
    );
    authorityResult =
      result.status === 'success'
        ? `Confirmed at block ${result.blockNumber}`
        : `Reverted at block ${result.blockNumber}`;
    authorityPending = false;
    reviewed = false;
    message =
      result.status === 'success'
        ? 'The Gate transaction is confirmed.'
        : 'The Gate transaction reverted. No change was applied.';
    await refresh();
  }
  function capAction(): AuthorityAction {
    return {
      kind: 'cap',
      milligrams: capGrams === '0' ? '0' : parseTransferGrams(capGrams),
    };
  }
  function admissionAction(): AuthorityAction {
    const seconds = Date.parse(expiry) / 1000;
    if (!Number.isSafeInteger(seconds) || seconds <= Date.now() / 1000)
      throw new Error('Choose a future issuer-key expiry.');
    return { kind: 'admit-issuer', validUntil: String(seconds) };
  }
</script>

<svelte:head
  ><title>Institution console — Ultratokenizer</title><meta
    name="description"
    content="Review test issuance, reserve a complete allocation and authorize its mint with an institution wallet."
  /></svelte:head
>
<PortalShell current="institution">
  <p class="eyebrow">Institution console</p>
  <h1>Review. Authorize. Issue.</h1>
  <p class="intro">
    The issuer reserves an allocation and signs its permit. The demo authority
    admits the configured signer and manages the Gate.
  </p>
  <p class="muted">
    Signed source documents and proof preparation happen outside this browser.
    This console starts with a public claim-proof export. Follow the
    <a href="/demo/">demo institution workflow</a> from source to permit.
  </p>
  <div class="status-line">
    <div class="actions" role="group" aria-label="Institution role">
      <button
        class:secondary={tab !== 'issuer'}
        aria-pressed={tab === 'issuer'}
        onclick={() => (tab = 'issuer')}>Issuer</button
      >
      <button
        class:secondary={tab !== 'admission'}
        aria-pressed={tab === 'admission'}
        onclick={() => (tab = 'admission')}>Demo authority</button
      >
    </div>
    <div class="actions">
      <button
        onclick={() =>
          run(async () => {
            await walletSession.connect();
          })}
        disabled={busy || !!walletState.busy}
        >{walletState.wallet
          ? `${walletState.wallet.address.slice(0, 6)}…${walletState.wallet.address.slice(-4)}`
          : 'Connect wallet'}</button
      >
      {#if walletState.wallet && walletState.wallet.chainId !== '296' && deployment}<button
          class="secondary"
          onclick={() =>
            run(async () => {
              await walletSession.switchToTestnet();
            })}
          disabled={busy}>Switch to Hedera testnet</button
        >{/if}
      {#if deployment}<button
          class="secondary"
          onclick={() => run(refresh)}
          disabled={busy}>Refresh</button
        >{/if}
    </div>
  </div>
  {#if !provider && !loading}<p class="notice">
      Open this console in the browser containing your EVM wallet extension.
      Private keys are never entered here.
    </p>{/if}
  {#if walletState.error}<p class="notice" role="alert">
      {walletState.error}
    </p>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}
  {#if loading}<p class="notice" role="status">
      Loading this site's deployment and reading the Gate…
    </p>
  {:else if !deployment}<section class="portal-card">
      <h2>Waiting for the deployment operator</h2>
      <p class="muted">
        Publish this site's approved testnet configuration before making
        institutional transactions. Holder accounts do not configure contracts.
      </p>
      <div class="actions">
        <a class="portal-button secondary" href="/trust/">Inspect deployment</a>
      </div>
    </section>
  {:else}
    {@const policy = deployment.auditPolicy}
    <div class="portal-grid">
      <div>
        {#if tab === 'issuer'}
          <section class="portal-card">
            <p class="eyebrow">01 · Review the allocation</p>
            <h2>One right. Its full quantity.</h2>
            <p class="muted">
              Import the public claim-proof export prepared by your prover.
              Source PDFs and private witnesses stay in the institution's local
              workflow.
            </p>
            <label for="institution-proof">Claim proof export</label><input
              id="institution-proof"
              type="file"
              accept=".json,application/json"
              disabled={busy || reservationPending}
              onchange={(event) => loadProof(event.currentTarget.files?.[0])}
            />
            {#if proof}<dl>
                <div>
                  <dt>Loaded proof</dt>
                  <dd>{proofName}</dd>
                </div>
                <div>
                  <dt>Exact allocation</dt>
                  <dd>{formatGrams(proof.request.amount)} g</dd>
                </div>
                <div>
                  <dt>Holder</dt>
                  <dd class="mono">{proof.request.recipient}</dd>
                </div>
                <div>
                  <dt>Stable right usage ID</dt>
                  <dd class="mono">{proof.request.claimUsageId}</dd>
                </div>
                <div>
                  <dt>Request expiry (UTC)</dt>
                  <dd>
                    {formatUtcTime(proof.request.validUntil)}
                  </dd>
                </div>
              </dl>{/if}
            <label for="ledger-reference">Private ledger review reference</label
            ><input
              id="ledger-reference"
              bind:value={ledgerReference}
              maxlength="160"
              placeholder="Your allocation reference"
              disabled={busy || reservationPending}
            />
            <label class="check-label"
              ><input
                type="checkbox"
                bind:checked={ledgerReviewed}
                disabled={busy || reservationPending}
              /><span
                >I reserved this stable right in the institution ledger and
                reviewed its holder, full quantity and terms.</span
              ></label
            >
            <p class="muted">
              This acknowledgement stays in this page. It is not a verified
              ledger bridge or an on-chain attestation.
            </p>
            <div class="actions">
              <button
                disabled={busy ||
                  !proof ||
                  !isIssuer ||
                  !ledgerReviewed ||
                  !ledgerReference.trim() ||
                  reservationPending}
                onclick={() => run(reserve)}>Reserve in wallet</button
              >
            </div>
            {#if !isIssuer}<p class="muted">
                Connect the configured permit signer shown in the role panel.
              </p>{/if}
          </section>
          <section class="portal-card">
            <p class="eyebrow">02 · Confirm and authorize</p>
            <h2>Issue a fresh permit.</h2>
            <p class="muted">
              Reconcile the reservation first. The permit signs the exact
              request and expires within 10 minutes.
            </p>
            <label for="reservation-hash">Reservation transaction hash</label
            ><input
              id="reservation-hash"
              bind:value={reservationHash}
              oninput={() => {
                reservationConfirmed = false;
                bundle = undefined;
              }}
              maxlength="66"
              spellcheck="false"
              placeholder="0x…"
              disabled={busy || !proof}
            />
            <div class="actions">
              <button
                class="secondary"
                disabled={busy || !proof || !reservationHash}
                onclick={() => run(reconcileReservation)}
                >Check reservation</button
              ><button
                disabled={busy || !reservationConfirmed || !isIssuer}
                onclick={() => run(permit)}>Sign permit &amp; download</button
              >
            </div>
            {#if reservationPending && !reservationConfirmed}<p class="notice">
                A reservation may have been submitted. Keep the original hash
                and reconcile it before requesting another transaction.
              </p>{/if}
            {#if bundle}<p class="notice">
                Signed permit expiry: {formatUtcTime(bundle.permit.validUntil)}.
              </p>
              <button
                class="secondary"
                onclick={() =>
                  saveJson(bundle, 'ultratokenizer-issuance-package.json')}
                >Download package again</button
              >{/if}
          </section>
        {:else}
          <section class="portal-card">
            <p class="eyebrow">01 · Admission review</p>
            <h2>Review the configured institution.</h2>
            <p class="muted">
              This demo authority controls this Gate. It does not confer a bank
              licence or regulatory approval.
            </p>
            <dl>
              <div>
                <dt>Issuer ID</dt>
                <dd class="mono">{policy.issuerId}</dd>
              </div>
              <div>
                <dt>
                  Proposed permit signer · version {policy.issuerKeyVersion}
                </dt>
                <dd class="mono">{policy.issuerAddress}</dd>
              </div>
              <div>
                <dt>Source fingerprint</dt>
                <dd class="mono">{policy.sourceSignerFingerprint}</dd>
              </div>
              <div>
                <dt>Policy / rights versions</dt>
                <dd>{policy.policyVersion} / {policy.rightsVersion}</dd>
              </div>
            </dl>
            <label for="review-reference">Dossier or review reference</label
            ><input
              id="review-reference"
              bind:value={reviewReference}
              maxlength="160"
              placeholder="Your reviewed dossier reference"
              disabled={busy || authorityPending}
            />
            <label class="check-label"
              ><input
                type="checkbox"
                bind:checked={reviewed}
                disabled={busy || authorityPending}
              /><span
                >I reviewed the issuer, source and terms separately. The
                following action changes the Gate's own records.</span
              ></label
            >
            <p class="muted">
              The review reference is local context. The existing Gate call
              records the wallet action; it does not store this dossier or prove
              signer consent.
            </p>
            {#if snapshot?.issuer.signer === zeroAddress}
              <label for="key-expiry">Issuer key expiry (your local time)</label
              ><input
                id="key-expiry"
                type="datetime-local"
                bind:value={expiry}
                disabled={busy || authorityPending}
              />
              <div class="actions">
                <button
                  disabled={busy ||
                    authorityPending ||
                    !isGovernor ||
                    !reviewed ||
                    !reviewReference.trim() ||
                    !expiry}
                  onclick={() => run(() => govern(admissionAction()))}
                  >Admit configured signer</button
                >
              </div>
            {:else}<p class="notice">
                This issuer key version is already registered. Keys are
                append-only; this console cannot overwrite it.
              </p>{/if}
          </section>
          <section class="portal-card">
            <p class="eyebrow">02 · Gate controls</p>
            <h2>Manage issuance capacity.</h2>
            <p class="muted">
              The cap covers pending reservations plus outstanding tokens.
              Reducing it cannot remove an issued liability.
            </p>
            <label for="backing-cap">Total backing cap (g)</label><input
              id="backing-cap"
              inputmode="decimal"
              bind:value={capGrams}
              placeholder="For example, 10.000"
              disabled={busy || authorityPending}
            />
            <div class="actions">
              <button
                disabled={busy ||
                  authorityPending ||
                  !isGovernor ||
                  !reviewed ||
                  !reviewReference.trim() ||
                  !capGrams}
                onclick={() => run(() => govern(capAction()))}
                >Review cap in wallet</button
              ><button
                class="secondary"
                disabled={busy ||
                  authorityPending ||
                  !isGovernor ||
                  !reviewed ||
                  !reviewReference.trim() ||
                  !snapshot}
                onclick={() =>
                  run(() =>
                    govern({ kind: 'pause', paused: !snapshot!.paused }),
                  )}
                >{snapshot?.paused ? 'Open issuance' : 'Pause issuance'}</button
              >
            </div>
            <p class="muted">
              Pausing the Gate stops new issuance. It does not freeze token
              transfers.
            </p>
            {#if authorityIntent}<label for="authority-hash"
                >Authority transaction hash</label
              ><input
                id="authority-hash"
                bind:value={authorityHash}
                maxlength="66"
                spellcheck="false"
                placeholder="0x…"
                disabled={busy}
              />
              <div class="actions">
                <button
                  class="secondary"
                  disabled={busy || !authorityHash}
                  onclick={() => run(reconcileAuthority)}
                  >Reconcile transaction</button
                >
              </div>{/if}
            {#if authorityPending}<p class="notice">
                This action is unresolved. Reconcile its original transaction
                before requesting another change.
              </p>{/if}
            {#if authorityResult}<p class="notice" role="status">
                {authorityResult}
              </p>{/if}
          </section>
        {/if}
      </div>
      <aside>
        <section class="portal-card">
          <h2>On-chain roles</h2>
          <dl>
            <div>
              <dt>Connected wallet</dt>
              <dd class="mono">
                {walletState.wallet?.address ?? 'Not connected'}
              </dd>
            </div>
            <div>
              <dt>Configured issuer</dt>
              <dd class="mono">{policy.issuerAddress}</dd>
            </div>
            <div>
              <dt>Gate governor</dt>
              <dd class="mono">{snapshot?.governor ?? 'Not observed'}</dd>
            </div>
            <div>
              <dt>Your role</dt>
              <dd>
                {isIssuer
                  ? 'Issuer signer'
                  : isGovernor
                    ? 'Demo admission authority'
                    : 'Read-only visitor'}
              </dd>
            </div>
          </dl>
          <p class="muted">
            The contract rechecks the signing wallet for every action.
          </p>
        </section>
        {#if snapshot}<section class="portal-card">
            <h2>Gate state</h2>
            <dl>
              <div>
                <dt>Issuance</dt>
                <dd>
                  {snapshot.paused ? 'Paused' : 'Open flag set'} · {snapshot.active
                    ? 'Configured records active'
                    : 'Issuance unavailable'}
                </dd>
              </div>
              <div>
                <dt>Cap / reserved / issued</dt>
                <dd>
                  {formatGrams(snapshot.pool.cap)} / {formatGrams(
                    snapshot.pool.pending,
                  )} / {formatGrams(snapshot.pool.outstanding)} g
                </dd>
              </div>
              <div>
                <dt>Observed block</dt>
                <dd>{snapshot.blockNumber}</dd>
              </div>
            </dl>
            <div class="actions">
              <a class="portal-button secondary" href="/trust/"
                >Inspect trust records</a
              >
            </div>
          </section>{/if}
        <section class="portal-card">
          <h2>Evidence and authority</h2>
          <p class="muted">
            This zkPDF profile authenticates a sealed synthetic PDF, its
            embedded capsule and the complete quantity. It does not extract
            arbitrary bank statements or authenticate email. Issuer authority
            and physical custody are separate claims.
          </p>
          <p class="muted">
            ERC-8004 may index issuer and audit references. Registry records
            cannot authorize this Gate or raise its backing cap.
          </p>
        </section>
      </aside>
    </div>
  {/if}
</PortalShell>
