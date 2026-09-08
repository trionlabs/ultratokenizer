<script lang="ts">
  import { tick } from 'svelte';
  import type { Journey, Event } from '../domain/journey';
  import { formatGrams } from '../domain/journey';
  import type { Discoveries } from '../domain/discoveries';
  import { sampleRequest } from '../adapters/sample-request';
  import type { InspectorTab } from '../prototype/visual-model';
  import Glyph from '../prototype/Glyph.svelte';
  import AuditReceipt from './AuditReceipt.svelte';
  import Disclosure from './Disclosure.svelte';
  import ReceiptExchange from './ReceiptExchange.svelte';
  import DiscoveryPanel from './DiscoveryPanel.svelte';
  let {
    journey,
    discoveries,
    discoveryNotice,
    digest,
    onscenario,
    onreceiptchecked,
  }: {
    journey: Journey;
    discoveries: Discoveries;
    discoveryNotice: string;
    digest: string;
    onscenario: (events: Event[]) => void;
    onreceiptchecked: (journey: Journey) => void;
  } = $props();
  let request = $derived(sampleRequest(journey.amountMg));
  const tabs: Array<{ id: InspectorTab; name: string }> = [
    { id: 'request', name: 'Request' },
    { id: 'privacy', name: 'Privacy' },
    { id: 'audit', name: 'Audit' },
    { id: 'scenarios', name: 'Try a failure' },
    { id: 'discoveries', name: 'Discoveries' },
  ];
  let inspectorTab = $state<InspectorTab>('request');
  let dialog: HTMLDialogElement;
  export function open(tab: InspectorTab) {
    inspectorTab = tab;
    if (!dialog.open) dialog.showModal();
  }
  export function close() {
    dialog.close();
  }
  function scenario(events: Event[]) {
    onscenario(events);
  }
  function startDiscovery(scenario: 'supported' | 'tampered') {
    onscenario([{ type: 'reset' }, { type: 'load_sample', scenario }]);
  }
  async function openDiscoveryReceipt() {
    inspectorTab = 'audit';
    await tick();
    dialog.querySelector<HTMLElement>('#receipt-check-title')?.focus();
  }
</script>

<dialog
  class="play-inspector"
  bind:this={dialog}
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
      onclick={() => dialog.close()}><Glyph name="close" /></button
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
        <pre>{JSON.stringify({ journey }, null, 2)}</pre>
      </details>
    {:else if inspectorTab === 'privacy'}
      <Disclosure amountMg={journey.amountMg} reviewed={journey.reviewed} />
      <div class="inspector-note">
        Sample recipient: <code>{request.recipient}</code>. Issuer, policy,
        reservation and other issuance identifiers are public. The app holds
        only synthetic session data in memory.
      </div>
    {:else if inspectorTab === 'audit'}
      <ReceiptExchange {journey} onchecked={() => onreceiptchecked(journey)} />
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
