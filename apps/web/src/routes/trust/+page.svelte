<script lang="ts">
  import { onMount } from 'svelte';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import PageMeta from '$lib/components/PageMeta.svelte';
  import {
    fetchHostedDeployment,
    fetchHostedDiscovery,
  } from '$lib/application/hosted-deployment';
  import {
    discoveryErrorMessage,
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
    missing = false;
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
      discoveryError = discoveryErrorMessage(cause);
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

<PageMeta route="/trust/" />

<PortalShell current="trust">
  <p class="eyebrow">Deployment provenance</p>
  <h1>Every address this app trusts, read from chain.</h1>
  <p class="intro">
    Contracts, signing roles and the source profile behind this deployment. The
    Gate decides whether a token can be issued.
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
    {#snippet chainAddress(address: string, kind: 'contract' | 'account')}
      {#if policy.chainId === '296'}
        <a
          class="addr"
          href={`https://hashscan.io/testnet/${kind}/${address}`}
          target="_blank"
          rel="noopener noreferrer">{address}</a
        >{#if kind === 'contract'}<a
            class="src"
            href={`https://repo.sourcify.dev/296/${address}`}
            target="_blank"
            rel="noopener noreferrer">source</a
          >{/if}
      {:else}{address}{/if}
    {/snippet}
    {@const checks = [
      ['Gate open', !snapshot.paused],
      ['Issuer pinned', snapshot.matches.issuer],
      ['Program pinned', snapshot.matches.program],
      ['Source pinned', snapshot.matches.source],
      ['Token pinned', snapshot.matches.rights],
      [
        'Key in date',
        snapshot.issuer.validUntil !== '0' && !snapshot.issuer.revoked,
      ],
      ['Program live', !snapshot.program.revoked],
      ['Source live', !snapshot.source.revoked],
      ['Policy live', !snapshot.policy.revoked],
      ['Rights live', !snapshot.rights.revoked],
    ]}
    <ul class="checks" aria-label="Conditions checked at this block">
      {#each checks as [label, ok] (label)}
        <li class:ok>
          <span aria-hidden="true">{ok ? '●' : '○'}</span>{label}<span
            class="sr-only">{ok ? ' holds' : ' does not hold'}</span
          >
        </li>
      {/each}
    </ul>

    <section class="standing" aria-label="Backing at this block">
      <div>
        <span>Accepted cap</span>
        <strong>{formatGrams(snapshot.pool.cap)} g</strong>
      </div>
      <div>
        <span>Reserved</span>
        <strong>{formatGrams(snapshot.pool.pending)} g</strong>
      </div>
      <div class="issued">
        <span>Issued</span>
        <strong>{formatGrams(snapshot.pool.outstanding)} g</strong>
      </div>
      <p class="standing-note">
        {snapshot.active
          ? 'Authority is active at this block. Each request still needs its own proof, permit and reservation.'
          : 'Issuance is paused, expired, revoked, or a configured record does not match.'}
        The cap is a governance assertion. It does not prove physical gold or a right
        to redeem it.
      </p>
    </section>

    <div class="portal-grid">
      <div>
        <section class="portal-card">
          <h2>Issuance authority</h2>
          {#if snapshot.active && snapshot.pool.available === '0'}
            <p class="muted">
              No capacity remains for new reservations. Existing reservations
              are checked separately.
            </p>
          {/if}
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
              <dd class="mono">
                {@render chainAddress(policy.gate, 'contract')}
              </dd>
            </div>
            <div>
              <dt>Governor</dt>
              <dd class="mono">
                {@render chainAddress(snapshot.governor, 'account')}
              </dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd class="mono">
                {@render chainAddress(snapshot.rights.token, 'contract')}
              </dd>
            </div>
            <div>
              <dt>Permit signer · version {policy.issuerKeyVersion}</dt>
              <dd class="mono">
                {@render chainAddress(snapshot.issuer.signer, 'account')}
              </dd>
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
          <details>
            <summary>Issuer identifier</summary>
            <p class="mono hash">{policy.issuerId}</p>
          </details>
        </section>
      </div>
      <div>
        <section class="portal-card">
          <h2>Proof and source</h2>
          <p class="muted">
            zkPDF · SP1 Groth16. The profile authenticates one sealed synthetic
            PDF, its embedded capsule and the exact quantity. Nothing else.
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
              <dt>Verifier</dt>
              <dd class="mono">
                {@render chainAddress(snapshot.program.verifier, 'contract')}
              </dd>
            </div>
          </dl>
          <details>
            <summary>Program and source hashes</summary>
            <dl>
              <div>
                <dt>Program vkey</dt>
                <dd class="mono">{snapshot.program.vkey}</dd>
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
            </dl>
          </details>
          <dl>
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
            These are current reads through this app's own RPC, checked against
            the pins this app ships. They are not an independent trust root, and
            they do not reconstruct who held authority at a past block. Obtain
            your own Gate and pins before treating a receipt as evidence.
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
                  <dt>NFT owner</dt>
                  <dd class="mono">
                    {@render chainAddress(entry.owner, 'account')}
                  </dd>
                </div>
                <div>
                  <dt>Service wallet</dt>
                  <dd class="mono">
                    {@render chainAddress(entry.wallet, 'account')}
                  </dd>
                </div>
              </dl>
              <details>
                <summary>Declaration hash</summary>
                <p class="mono hash">{entry.metadataHash}</p>
              </details>
              {#if entry.role === 'auditor'}
                {@const accounts = [
                  entry.owner.toLowerCase(),
                  entry.wallet.toLowerCase(),
                ]}
                {@const sharedGovernor = accounts.includes(
                  snapshot.governor.toLowerCase(),
                )}
                {@const sharedIssuer = accounts.includes(
                  snapshot.issuer.signer.toLowerCase(),
                )}
                {#if sharedGovernor || sharedIssuer}<p class="notice">
                    Shared control: this audit record's NFT owner or service
                    wallet matches {sharedGovernor
                      ? 'the Gate governor'
                      : ''}{sharedGovernor && sharedIssuer
                      ? ' and '
                      : ''}{sharedIssuer ? 'the issuer signer' : ''}. Auditor
                    independence is not established.
                  </p>{/if}
                <p class="muted">
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
              <dd class="mono">
                {@render chainAddress(
                  discovery.identityRegistry.address,
                  'contract',
                )}
              </dd>
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
              <dd class="mono">
                {@render chainAddress(
                  discovery.identityRegistry.owner,
                  'account',
                )}
              </dd>
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
        A registry outage does not block issuance or offline receipt checks.
      </p>
    </section>
  {/if}
</PortalShell>

<style>
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    margin: 0 0 26px;
    padding: 0;
    list-style: none;
  }
  .checks li {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--p-muted);
    font-size: 0.7rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .checks li span[aria-hidden] {
    font-size: 0.62rem;
    line-height: 1;
  }
  .checks li.ok {
    color: var(--p-ink);
  }
  .checks li:not(.ok) span[aria-hidden] {
    color: var(--p-accent);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .hash {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
    color: var(--p-muted);
    font-size: 0.7rem;
  }

  /* Rank one. No card, no border: the figures carry themselves, and the space
     around them is what says they matter. */
  .standing {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: start;
    gap: 4px 40px;
    margin: 0 0 34px;
    padding-bottom: 26px;
    border-bottom: 1px solid var(--p-line);
  }
  .standing span {
    display: block;
    color: var(--p-muted);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .standing strong {
    display: block;
    margin-top: 6px;
    font-size: 1.7rem;
    font-weight: 400;
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  /* Nothing minted is the whole claim of the page, so it is the one figure
     that takes the accent. */
  .standing .issued strong {
    color: var(--p-accent);
  }
  .standing-note {
    grid-column: 1 / -1;
    margin: 22px 0 0;
    max-width: 68ch;
    color: var(--p-muted);
    font-size: 0.78rem;
  }
  @media (max-width: 640px) {
    .standing {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .addr {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px solid var(--p-line);
  }
  .addr:hover,
  .addr:focus-visible {
    color: var(--p-accent);
    border-bottom-color: currentColor;
  }
  .src {
    margin-left: 10px;
    color: var(--p-accent);
    font-size: 0.7rem;
    text-decoration: none;
  }
  .src:hover,
  .src:focus-visible {
    text-decoration: underline;
  }

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
