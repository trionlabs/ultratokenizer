<script lang="ts">
  // Three temporary interaction prototypes on /, selected with ?variant=A|B|C.
  import '../styles.css';
  import '../play.css';
  import '../orbit.css';
  import '../discoveries.css';
  import { onMount, tick } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import {
    createJourney,
    transition,
    failures,
    formatGrams,
    type Event,
    type Role,
  } from '$lib/domain/journey';
  import { sampleDigest, sampleRequest } from '$lib/adapters/sample-request';
  import VariantOrbit from '$lib/prototype/VariantOrbit.svelte';
  import VariantWorkbench from '$lib/prototype/VariantWorkbench.svelte';
  import VariantPassport from '$lib/prototype/VariantPassport.svelte';
  import PrototypeSwitcher from '$lib/prototype/PrototypeSwitcher.svelte';
  import Glyph from '$lib/prototype/Glyph.svelte';
  import {
    readVariant,
    stageCopy,
    type Variant,
    type InspectorTab,
  } from '$lib/prototype/visual-model';
  import AuditReceipt from '$lib/components/AuditReceipt.svelte';
  import Disclosure from '$lib/components/Disclosure.svelte';
  import ReceiptExchange from '$lib/components/ReceiptExchange.svelte';
  import DiscoveryPanel from '$lib/components/DiscoveryPanel.svelte';
  import {
    createDiscoveries,
    discoveryCount,
    recordDiscovery,
    recordReceiptCheck,
    type Discoveries,
    type Discovery,
  } from '$lib/domain/discoveries';

  let journey = $state(createJourney());
  let discoveries = $state(createDiscoveries());
  let discoveryNotice = $state('');
  let role = $state<Role>('holder');
  let variant = $state<Variant>('A');
  let error = $state('');
  let inspectorTab = $state<InspectorTab>('request');
  let panel: HTMLElement;
  let inspector: HTMLDialogElement;
  let digest = $derived(sampleDigest(journey.amountMg));
  let request = $derived(sampleRequest(journey.amountMg));
  const tabs: Array<{ id: InspectorTab; name: string }> = [
    { id: 'request', name: 'Request' },
    { id: 'privacy', name: 'Privacy' },
    { id: 'audit', name: 'Audit' },
    { id: 'scenarios', name: 'Try a failure' },
    { id: 'discoveries', name: 'Discoveries' },
  ];
  onMount(() => {
    const syncVariant = () => {
      variant = readVariant(
        new URL(window.location.href).searchParams.get('variant'),
      );
    };
    syncVariant();
    window.addEventListener('popstate', syncVariant);
    return () => window.removeEventListener('popstate', syncVariant);
  });
  function changeVariant(next: Variant) {
    variant = next;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    replaceState(url, page.state);
  }
  async function focusPanel() {
    await tick();
    panel?.focus({ preventScroll: true });
  }
  function changeRole(next: Role) {
    role = next;
    error = '';
    void focusPanel();
  }
  function inspect(tab: InspectorTab) {
    inspectorTab = tab;
    if (!inspector.open) inspector.showModal();
  }
  function act(event: Event) {
    try {
      const previous = journey.stage;
      const before = journey;
      journey = transition(journey, event);
      updateDiscoveries(recordDiscovery(discoveries, before, journey, event));
      error = '';
      if (event.type === 'reset' || event.type === 'authorize') role = 'holder';
      if (previous !== journey.stage) void focusPanel();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'This step could not be completed.';
    }
  }
  function scenario(events: Event[]) {
    for (const event of events) act(event);
    inspector.close();
    void focusPanel();
  }
  function startDiscovery(scenarioName: 'supported' | 'tampered') {
    role = 'holder';
    scenario([
      { type: 'reset' },
      { type: 'load_sample', scenario: scenarioName },
    ]);
  }
  function updateDiscoveries(next: Discoveries) {
    const names = {
      orbit: 'First orbit',
      integrity: 'Catch the edit',
      recovery: 'Find your way back',
    };
    const earned = (Object.keys(names) as Discovery[]).find(
      (key) => next[key] && !discoveries[key],
    );
    discoveries = next;
    if (earned)
      discoveryNotice = `${names[earned]} stamp collected. ${discoveryCount(next)} of 3 discoveries.`;
  }
  async function openDiscoveryReceipt() {
    inspectorTab = 'audit';
    await tick();
    inspector.querySelector<HTMLElement>('#receipt-check-title')?.focus();
  }
</script>

<svelte:head
  ><title>Ultratokenizer — A new form</title><meta
    name="description"
    content="A tactile, private-document tokenization preview. Synthetic evidence, deliberate approval and an inspectable sample receipt."
  /></svelte:head
>

<a class="skip-link" href="#journey">Skip to journey</a>
<div class="play-shell" data-variant={variant} data-stage={journey.stage}>
  <span class="sr-only" aria-live="polite" aria-atomic="true"
    >{discoveryNotice}</span
  >
  <header class="play-header">
    <a class="play-brand" href="/" aria-label="Ultratokenizer home"
      ><span>u</span>ultratokenizer<i>.</i></a
    ><span class="play-demo"><i></i>Demo · no real proof or mint</span>
    <div class="play-tools">
      <nav class="play-roles" aria-label="Preview role">
        <button
          class:active={role === 'holder'}
          aria-pressed={role === 'holder'}
          onclick={() => changeRole('holder')}>Holder</button
        ><button
          class:active={role === 'issuer'}
          aria-pressed={role === 'issuer'}
          onclick={() => changeRole('issuer')}>Test issuer</button
        >
      </nav>
      <button
        class="p-icon"
        aria-label="Inspect details"
        onclick={() => inspect('request')}><Glyph name="eye" /></button
      >
    </div>
  </header>
  <main id="journey" tabindex="-1" bind:this={panel} class="play-main">
    <span class="sr-only" aria-live="polite"
      >{stageCopy[journey.stage].label} step. Simulation only.</span
    >
    {#if error || journey.failure}<div class="play-error" role="alert">
        <span
          ><strong
            >{error ||
              (journey.failure && failures[journey.failure].title)}</strong
          >{#if journey.failure}<small
              >{failures[journey.failure].recovery}</small
            >{/if}</span
        ><span class="failure-label">Sample</span>
      </div>{/if}
    {#if variant === 'A'}<VariantOrbit
        {journey}
        {discoveries}
        {role}
        onaction={act}
        onrole={changeRole}
        oninspect={inspect}
      />
    {:else if variant === 'B'}<VariantWorkbench
        {journey}
        {role}
        onaction={act}
        onrole={changeRole}
        oninspect={inspect}
      />
    {:else}<VariantPassport
        {journey}
        {role}
        onaction={act}
        onrole={changeRole}
        oninspect={inspect}
      />{/if}
  </main>
  <footer class="play-footer">
    <button class="p-text" onclick={() => inspect('privacy')}
      ><Glyph name="lock" size={13} />Private by design</button
    ><span>Synthetic gold · No asset backing</span><button
      class="p-text"
      onclick={() => act({ type: 'reset' })}
      ><Glyph name="reset" size={13} />Reset</button
    >
  </footer>
  <PrototypeSwitcher current={variant} onchange={changeVariant} />
</div>

<dialog
  class="play-inspector"
  bind:this={inspector}
  aria-labelledby="inspector-title"
>
  <span class="sr-only" aria-live="polite" aria-atomic="true"
    >{discoveryNotice}</span
  >
  <div class="inspector-header">
    <div>
      <span class="p-overline">Under the surface</span>
      <h2 id="inspector-title">The details are yours.</h2>
    </div>
    <button
      class="p-icon"
      aria-label="Close details"
      onclick={() => inspector.close()}><Glyph name="close" /></button
    >
  </div>
  <nav class="inspector-tabs" aria-label="Inspection section">
    {#each tabs as tab}<button
        class:active={inspectorTab === tab.id}
        aria-pressed={inspectorTab === tab.id}
        onclick={() => {
          inspectorTab = tab.id;
        }}>{tab.name}</button
      >{/each}
  </nav>
  <div class="inspector-body">
    {#if inspectorTab === 'request'}
      <p class="inspector-note">
        Synthetic sample. No PDF verification, permit, proof or transaction is
        created by this preview.
      </p>
      <dl class="detail-list">
        <div>
          <dt>Amount</dt>
          <dd>{formatGrams(journey.amountMg)} g GOLD</dd>
        </div>
        <div>
          <dt>Recipient</dt>
          <dd class="hash-value">{request.recipient}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>Hedera testnet · planned</dd>
        </div>
        <div>
          <dt>Rights</dt>
          <dd>No assets or redemption rights</dd>
        </div>
      </dl>
      <div class="hash-block">
        <span class="field-label">EIP-712 request digest · calculated</span
        ><code>{digest}</code>
      </div>
      <h3>What the issuer must establish</h3>
      <ol class="inspector-criteria">
        <li>
          <strong>Holder binding</strong>
          <p>
            A trusted identity check links the document subject to the recipient
            wallet. Having the PDF is insufficient.
          </p>
        </li>
        <li>
          <strong>Exclusive reservation</strong>
          <p>
            The custodian reserves the amount and prevents reuse across
            documents and statements.
          </p>
        </li>
        <li>
          <strong>Explicit rights</strong>
          <p>
            A signed permit authorizes the exact request, including amount,
            destination, policy and expiry.
          </p>
        </li>
      </ol>
      <p class="inspector-note">
        The three seals are sample controls, not identity checks or custody
        services. Browser state never grants mint authority.
      </p>
      <details class="request-details">
        <summary>Canonical sample request</summary>
        <pre>{JSON.stringify(request, null, 2)}</pre>
      </details>
      <details class="request-details">
        <summary>Prototype state</summary>
        <pre>{JSON.stringify({ variant, role, journey }, null, 2)}</pre>
      </details>
    {:else if inspectorTab === 'privacy'}
      <Disclosure amountMg={journey.amountMg} reviewed={journey.reviewed} />
      <div class="inspector-note">
        Sample recipient: <code>{request.recipient}</code>. Issuer, policy,
        reservation and other issuance identifiers are public. The app holds
        only synthetic session data in memory.
      </div>
    {:else if inspectorTab === 'audit'}
      <ReceiptExchange
        {journey}
        onchecked={() => {
          updateDiscoveries(recordReceiptCheck(discoveries, journey));
        }}
      />
      <AuditReceipt {journey} {digest} />
    {:else if inspectorTab === 'discoveries'}
      <DiscoveryPanel
        {discoveries}
        {journey}
        onstart={() => startDiscovery('supported')}
        onedited={() => startDiscovery('tampered')}
        onrejection={() => scenario([{ type: 'prove', succeeds: false }])}
        onreceipt={openDiscoveryReceipt}
      />
    {:else}
      <h3>Make something go wrong.</h3>
      <p class="inspector-note">
        Document tests restart the sample. Proof and wallet tests apply to their
        matching step.
      </p>
      <div class="scenario-buttons">
        <button
          onclick={() =>
            scenario([
              { type: 'reset' },
              { type: 'load_sample', scenario: 'tampered' },
            ])}>Edited document <Glyph name="arrow" size={17} /></button
        ><button
          onclick={() =>
            scenario([
              { type: 'reset' },
              { type: 'load_sample', scenario: 'unsupported' },
            ])}>Unsupported format <Glyph name="arrow" size={17} /></button
        ><button
          disabled={journey.stage !== 'proof'}
          onclick={() => scenario([{ type: 'prove', succeeds: false }])}
          >Rejected proof <Glyph name="arrow" size={17} /></button
        ><button
          disabled={journey.stage !== 'mint'}
          onclick={() => scenario([{ type: 'mint', succeeds: false }])}
          >Declined wallet confirmation <Glyph name="arrow" size={17} /></button
        >
      </div>
      {#if ['authorization', 'proof', 'mint'].includes(journey.stage)}<button
          class="button secondary"
          onclick={() => scenario([{ type: 'edit_request' }])}
          >Edit request and clear its approval</button
        >{/if}
    {/if}
  </div>
</dialog>
