<script lang="ts">
  import { onMount } from 'svelte';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import {
    fetchHostedDeployment,
    fetchHostedDiscovery,
  } from '$lib/application/hosted-deployment';
  import {
    readDiscovery,
    type DiscoveryObservation,
  } from '$lib/application/discovery';
  import {
    readTrustSnapshot,
    formatUtcTime,
    type TrustSnapshot,
  } from '$lib/application/institution-client';
  import {
    parseDeploymentConfig,
    getTokenBackend,
    formatGrams,
    saveJson,
    type DeploymentConfig,
  } from '$lib/issuance';
  let deployment = $state<DeploymentConfig>();
  let snapshot = $state<TrustSnapshot>();
  let busy = $state(true);
  let error = $state('');
  let missing = $state(false);
  let discovery = $state<DiscoveryObservation>();
  let discoveryStatus = $state<
    'idle' | 'loading' | 'missing' | 'failed' | 'matched'
  >('idle');
  let discoveryError = $state('');
  const controller = new AbortController();
  async function refresh() {
    busy = true;
    error = '';
    snapshot = undefined;
    discovery = undefined;
    discoveryStatus = 'idle';
    try {
      if (!deployment) {
        const text = await fetchHostedDeployment(controller.signal);
        if (text === undefined) {
          missing = true;
          return;
        }
        deployment = parseDeploymentConfig(text);
      }
      snapshot = await readTrustSnapshot(deployment);
      void loadDiscovery(deployment, snapshot);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'Contract state could not be read.';
    } finally {
      busy = false;
    }
  }
  async function loadDiscovery(
    selected: DeploymentConfig,
    observed: TrustSnapshot,
  ) {
    discoveryStatus = 'loading';
    discoveryError = '';
    try {
      const text = await fetchHostedDiscovery(controller.signal);
      if (controller.signal.aborted || snapshot !== observed) return;
      if (text === undefined) {
        discoveryStatus = 'missing';
        return;
      }
      const result = await readDiscovery(text, selected, observed);
      if (controller.signal.aborted || snapshot !== observed) return;
      discovery = result;
      discoveryStatus = 'matched';
    } catch (cause) {
      if (controller.signal.aborted || snapshot !== observed) return;
      discoveryStatus = 'failed';
      discoveryError =
        cause instanceof Error
          ? cause.message
          : 'Discovery could not be checked.';
    }
  }
  onMount(() => {
    void refresh();
    return () => controller.abort();
  });
  function exportSnapshot() {
    if (snapshot && deployment)
      saveJson(
        {
          format: 'ultratokenizer.current-trust-snapshot.v1',
          assurance: 'configured-rpc-current-state',
          deployment,
          snapshot,
        },
        'ultratokenizer-trust-snapshot.json',
      );
  }
</script>

<svelte:head
  ><title>Trust and provenance — Ultratokenizer</title><meta
    name="description"
    content="Inspect the Gate, program, issuer and source records for this token deployment."
  /></svelte:head
>
<PortalShell current="trust">
  <p class="eyebrow">Deployment provenance</p>
  <h1>Follow the authority.</h1>
  <p class="intro">
    Inspect the contracts, signing roles and source profile behind this
    deployment. The Gate decides whether a token can be issued.
  </p>
  <div class="status-line">
    <p class="muted">
      {busy
        ? 'Reading the configured chain…'
        : snapshot
          ? `Observed at block ${snapshot.blockNumber}`
          : 'No chain observation yet.'}
    </p>
    <button class="secondary" onclick={refresh} disabled={busy}
      >Refresh chain state</button
    >
  </div>
  {#if missing}<p class="notice">
      The deployment operator has not published this site's configuration yet.
      This page cannot identify an approved Gate.
    </p>{/if}
  {#if error}<p class="notice" role="alert">
      {error} No matching deployment is claimed.
    </p>{/if}
  {#if deployment && snapshot}
    {@const policy = deployment.auditPolicy}
    <div class="portal-grid">
      <div>
        <section class="portal-card">
          <h2>Issuance authority</h2>
          <p class="muted">
            {snapshot.active
              ? 'Configured records match and issuance is open at this block.'
              : 'Issuance is paused, expired, revoked, or a configured record does not match.'}
          </p>
          <dl>
            <div>
              <dt>Chain / backend</dt>
              <dd>
                {policy.chainId === '296'
                  ? 'Hedera testnet'
                  : `Chain ${policy.chainId}`} · {getTokenBackend(
                  deployment,
                ).toUpperCase()}
              </dd>
            </div>
            <div>
              <dt>Gate</dt>
              <dd class="mono">{policy.gate}</dd>
            </div>
            <div>
              <dt>Governor</dt>
              <dd class="mono">{snapshot.governor}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd class="mono">{snapshot.rights.token}</dd>
            </div>
            <div>
              <dt>Issuer ID</dt>
              <dd class="mono">{policy.issuerId}</dd>
            </div>
            <div>
              <dt>Permit signer · version {policy.issuerKeyVersion}</dt>
              <dd class="mono">{snapshot.issuer.signer}</dd>
            </div>
            <div>
              <dt>Issuer binding</dt>
              <dd>
                {snapshot.matches.issuer
                  ? 'Matches application pins'
                  : 'Does not match application pins'} · {snapshot.issuer
                  .revoked
                  ? 'Revoked'
                  : 'Not revoked'}
              </dd>
            </div>
            <div>
              <dt>Issuer key expiry (UTC)</dt>
              <dd>
                {snapshot.issuer.validUntil === '0'
                  ? 'Not registered'
                  : formatUtcTime(snapshot.issuer.validUntil)}
              </dd>
            </div>
          </dl>
        </section>
        <section class="portal-card">
          <h2>Backing accounting</h2>
          <dl>
            <div>
              <dt>Accepted cap</dt>
              <dd>{formatGrams(snapshot.pool.cap)} g</dd>
            </div>
            <div>
              <dt>Reserved / issued</dt>
              <dd>
                {formatGrams(snapshot.pool.pending)} g / {formatGrams(
                  snapshot.pool.outstanding,
                )} g
              </dd>
            </div>
          </dl>
          <p class="muted">
            The cap is a governance assertion. It does not prove physical gold
            or a right to redeem it.
          </p>
        </section>
      </div>
      <div>
        <section class="portal-card">
          <h2>Proof and source</h2>
          <p class="muted">
            zkPDF · SP1 Groth16. This profile authenticates a sealed synthetic
            PDF, its embedded capsule and the exact quantity. It does not
            extract arbitrary bank statements or implement zkEmail.
          </p>
          <dl>
            <div>
              <dt>Program / profile</dt>
              <dd>
                Version {snapshot.program.version} · Profile {snapshot.program
                  .profile} · {snapshot.matches.program
                  ? 'Matches pins'
                  : 'Mismatch'}
              </dd>
            </div>
            <div>
              <dt>Program vkey</dt>
              <dd class="mono">{snapshot.program.vkey}</dd>
            </div>
            <div>
              <dt>Verifier</dt>
              <dd class="mono">{snapshot.program.verifier}</dd>
            </div>
            <div>
              <dt>Verifier runtime hash</dt>
              <dd class="mono">{snapshot.program.codeHash}</dd>
            </div>
            <div>
              <dt>Source ID · version {snapshot.source.version}</dt>
              <dd class="mono">{snapshot.source.id}</dd>
            </div>
            <div>
              <dt>Source signer fingerprint</dt>
              <dd class="mono">{snapshot.source.fingerprint}</dd>
            </div>
            <div>
              <dt>Source binding</dt>
              <dd>
                {snapshot.matches.source
                  ? 'Matches application pins'
                  : 'Does not match application pins'}
              </dd>
            </div>
          </dl>
        </section>
        <section class="portal-card">
          <h2>What this establishes</h2>
          <p class="muted">
            These are current contract reads through the configured RPC,
            compared with this app's pins. They are not an independent trust
            root or a reconstruction of past authority.
          </p>
          <details>
            <summary>Terms and observation hashes</summary>
            <dl>
              <div>
                <dt>Policy terms</dt>
                <dd class="mono">{snapshot.policy.termsHash}</dd>
              </div>
              <div>
                <dt>Rights terms</dt>
                <dd class="mono">{snapshot.rights.termsHash}</dd>
              </div>
              <div>
                <dt>Observed block hash</dt>
                <dd class="mono">{snapshot.blockHash}</dd>
              </div>
            </dl>
          </details>
          <div class="actions">
            <button class="secondary" onclick={exportSnapshot}
              >Save observation</button
            ><button
              class="secondary"
              onclick={() =>
                saveJson(
                  deployment!.auditPolicy,
                  'ultratokenizer-app-audit-policy.json',
                )}>Save app audit pins</button
            >
          </div>
          <p class="muted">
            Obtain your trusted Gate and pins independently before using an
            audit report as evidence.
          </p>
        </section>
      </div>
    </div>
    <section class="portal-card discovery-section">
      <p class="eyebrow">ERC-8004 · Discovery and attribution</p>
      <h2>Who published these services?</h2>
      <p class="muted">
        This site's index maps issuer IDs to registry records. The records
        identify service wallets and declarations; the Gate remains the issuance
        authority.
      </p>
      {#if discoveryStatus === 'loading'}<p class="notice" role="status">
          Checking service records at the same block as the Gate…
        </p>
      {:else if discoveryStatus === 'missing'}<p class="notice">
          No discovery index has been published for this deployment. The Gate
          observations above remain available.
        </p>
      {:else if discoveryStatus === 'failed'}<p class="notice" role="status">
          Discovery was not confirmed: {discoveryError} This does not change the Gate's
          records.
        </p>
      {:else if discovery}
        <p class="notice">
          Registry code, implementation, owner and service wallets match the
          reviewed index at block {discovery.blockNumber}. Declared
          issuer/program bindings match the Gate.
        </p>
        <div class="service-list">
          {#each discovery.entries as entry}
            <article>
              <p class="eyebrow">
                {entry.role === 'issuer'
                  ? 'Issuer service'
                  : entry.role === 'deployment'
                    ? 'Deployment service'
                    : 'Audit service'}
              </p>
              <h3>{entry.name}</h3>
              <dl>
                <div>
                  <dt>Agent ID</dt>
                  <dd>{entry.agentId}</dd>
                </div>
                <div>
                  <dt>Service wallet</dt>
                  <dd class="mono">{entry.wallet}</dd>
                </div>
                <div>
                  <dt>Declaration hash</dt>
                  <dd class="mono">{entry.metadataHash}</dd>
                </div>
              </dl>
              {#if entry.role === 'auditor'}<p class="muted">
                  A registered audit identity is not evidence that an audit was
                  performed or that its author is independent.
                </p>{/if}
            </article>
          {/each}
        </div>
        <details>
          <summary>Registry and attribution evidence</summary>
          <dl>
            <div>
              <dt>Identity registry</dt>
              <dd class="mono">{discovery.identityRegistry.address}</dd>
            </div>
            <div>
              <dt>Implementation / runtime hash</dt>
              <dd class="mono">
                {discovery.identityRegistry.implementation}<br />{discovery
                  .identityRegistry.implementationCodeHash}
              </dd>
            </div>
            <div>
              <dt>Registry owner</dt>
              <dd class="mono">{discovery.identityRegistry.owner}</dd>
            </div>
          </dl>
        </details>
        <div class="actions">
          <button
            class="secondary"
            onclick={() =>
              saveJson(discovery, 'ultratokenizer-discovery-observation.json')}
            >Save attribution evidence</button
          >
        </div>
      {/if}
      <p class="muted">
        This is current attribution under a configured RPC and reviewed index.
        It does not bootstrap independent trust or reconstruct the identities at
        a past mint. Registry outages and changes do not prevent issuance or
        offline receipt checks.
      </p>
    </section>
  {/if}
</PortalShell>

<style>
  .discovery-section {
    margin-top: 24px;
  }
  .service-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
    gap: 24px;
    margin-top: 24px;
  }
  article {
    min-width: 0;
    border-top: 1px solid var(--p-line);
    padding-top: 18px;
  }
  article h3 {
    margin-top: 8px;
  }
</style>
