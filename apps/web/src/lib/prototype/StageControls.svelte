<script lang="ts">
  import {
    canAuthorize,
    formatGrams,
    parseSampleAmount,
    type IssuerCheck,
  } from '../domain/journey';
  import type { FlowProps } from './visual-model';
  import Glyph from './Glyph.svelte';
  let {
    journey,
    role,
    onaction,
    onrole,
    oninspect,
    refined = false,
  }: FlowProps & { refined?: boolean } = $props();
  let grams = $state('1.000');
  let consent = $state(false);
  let checksSelected = $derived(
    Object.values(journey.issuerChecks).filter(Boolean).length,
  );
  let amount = $derived.by(() => {
    try {
      return parseSampleAmount(grams);
    } catch {
      return null;
    }
  });
  const checks: Array<{
    id: IssuerCheck;
    label: string;
    glyph: 'wallet' | 'lock' | 'shield';
  }> = [
    { id: 'subject', label: 'Holder', glyph: 'wallet' },
    { id: 'reservation', label: 'Reservation', glyph: 'lock' },
    { id: 'rights', label: 'Rights', glyph: 'shield' },
  ];
  $effect(() => {
    if (journey.stage === 'review') {
      grams = formatGrams(journey.amountMg);
      consent = false;
    }
  });
</script>

<div class="stage-controls" class:refined>
  {#if role === 'issuer' && ['document', 'review'].includes(journey.stage)}
    <p class="p-muted">No request yet.</p>
    <button class="p-primary" onclick={() => onrole('holder')}
      >Start as holder <Glyph name="arrow" /></button
    >
  {:else if journey.stage === 'document'}
    <button
      class="p-primary"
      onclick={() => onaction({ type: 'load_sample', scenario: 'supported' })}
      >Try a sample <Glyph name="arrow" /></button
    >
    <span class="p-micro">Synthetic PDF · personal uploads unavailable</span>
  {:else if journey.stage === 'review'}
    <form
      class="amount-play"
      onsubmit={(event) => {
        event.preventDefault();
        onaction({ type: 'review', grams, consent });
      }}
    >
      <div class="amount-display">
        <label for="play-amount" class="sr-only">Gold amount in grams</label
        ><input
          id="play-amount"
          inputmode="decimal"
          maxlength="12"
          autocomplete="off"
          bind:value={grams}
          aria-invalid={amount === null}
        /><span>g</span>
      </div>
      <label class="sr-only" for="amount-slider"
        >Adjust gold amount in milligrams</label
      ><input
        id="amount-slider"
        class="amount-slider"
        type="range"
        min="1"
        max="10000"
        step="1"
        aria-valuetext={amount
          ? `${formatGrams(amount)} grams`
          : 'Enter a valid gold amount'}
        value={amount ?? '1000'}
        oninput={(event) => {
          grams = formatGrams(event.currentTarget.value);
        }}
        style={`--fill: ${Number(amount ?? '1000') / 100}%`}
      />
      {#if refined}<div class="amount-ruler" aria-hidden="true"></div>{/if}
      <div class="amount-presets">
        {#each ['1000', '5000', '10000'] as preset}<button
            type="button"
            class:chosen={amount === preset}
            aria-pressed={amount === preset}
            onclick={() => {
              grams = formatGrams(preset);
            }}>{Number(preset) / 1000} g</button
          >{/each}<span>10 g sample balance</span>
      </div>
      <div class="recipient-preview">
        <Glyph name="wallet" size={14} /><span>0x3333…3333</span><small
          >Sample wallet</small
        >
      </div>
      <div class="disclosure-strip">
        <Glyph name="eye" size={15} /><span
          >Public: {amount ? `${formatGrams(amount)} g` : 'amount'}, wallet &
          issuance IDs</span
        ><button
          type="button"
          class="p-icon small"
          aria-label="Inspect public disclosure"
          onclick={() => oninspect('privacy')}
          ><Glyph name="plus" size={14} /></button
        >
      </div>
      <label class="minimal-consent"
        ><input type="checkbox" bind:checked={consent} /><span
          >I accept public disclosure.</span
        ></label
      >
      <button
        class="p-primary"
        type="submit"
        disabled={!consent || amount === null}
        >Request approval <Glyph name="arrow" /></button
      >
      {#if amount === null}<p class="p-inline-error" role="status">
          Use 0.001–10.000 g, with up to 3 decimals.
        </p>{/if}
    </form>
  {:else if journey.stage === 'authorization'}
    <div class="recipient-preview">
      <Glyph name="wallet" size={14} /><span>0x3333…3333</span><small
        >Sample wallet</small
      >
    </div>
    {#if journey.failure === 'issuer_rejected'}
      <button
        class="p-primary"
        onclick={() => {
          onaction({ type: 'edit_request' });
          onrole('holder');
        }}>Revise request <Glyph name="back" /></button
      >
    {:else if role === 'issuer'}
      <div class="check-tokens">
        {#each checks as check}<button
            aria-pressed={journey.issuerChecks[check.id]}
            class:checked={journey.issuerChecks[check.id]}
            onclick={() =>
              onaction({
                type: 'issuer_check',
                check: check.id,
                checked: !journey.issuerChecks[check.id],
              })}
            ><span
              ><Glyph
                name={journey.issuerChecks[check.id] ? 'check' : check.glyph}
                size={22}
              /></span
            >{check.label}</button
          >{/each}
      </div>
      <div class="approval-caption">
        <span aria-live="polite">{checksSelected} / 3 sample checks</span
        ><button class="p-text" onclick={() => oninspect('request')}
          >Review criteria <Glyph name="plus" size={13} /></button
        >
      </div>
      <button
        class="p-primary"
        disabled={!canAuthorize(journey)}
        onclick={() => onaction({ type: 'authorize' })}
        >Simulate approval <Glyph name="arrow" /></button
      >
      <button
        class="p-text p-danger"
        onclick={() => onaction({ type: 'reject_authorization' })}
        >Decline request</button
      >
    {:else}
      <div class="waiting-chips">
        <span><Glyph name="wallet" size={16} />Holder</span><span
          ><Glyph name="lock" size={16} />Reservation</span
        ><span><Glyph name="shield" size={16} />Rights</span>
      </div>
      <button class="p-primary" onclick={() => onrole('issuer')}
        >Review as test issuer <Glyph name="arrow" /></button
      >
      <button class="p-text" onclick={() => onaction({ type: 'edit_request' })}
        >Edit amount</button
      >
    {/if}
  {:else if journey.stage === 'proof'}
    <div class="proof-chips">
      <span><Glyph name="lock" size={14} />Private source</span><Glyph
        name="arrow"
        size={15}
      /><span><Glyph name="shield" size={14} />Public claim</span>
    </div>
    <button
      class="p-primary"
      onclick={() => onaction({ type: 'prove', succeeds: true })}
      >Simulate proof <Glyph name="arrow" /></button
    >
    <button class="p-text" onclick={() => oninspect('request')}
      >Inspect request</button
    >
  {:else if journey.stage === 'mint'}
    <div class="mint-summary">
      <strong>{formatGrams(journey.amountMg)} <small>g GOLD</small></strong
      ><span><Glyph name="wallet" size={14} />0x3333…3333</span>
    </div>
    <div class="mint-terms">
      <span>Hedera testnet · planned</span><span>No redemption rights</span>
    </div>
    <button
      class="p-primary"
      onclick={() => onaction({ type: 'mint', succeeds: true })}
      >Simulate mint <Glyph name="arrow" /></button
    >
    <button class="p-text" onclick={() => onaction({ type: 'edit_request' })}
      >Edit request</button
    >
  {:else}
    <button class="p-primary" onclick={() => oninspect('audit')}
      >Inspect receipt <Glyph name="eye" /></button
    >
    <button class="p-text" onclick={() => onaction({ type: 'reset' })}
      >Start again</button
    >
  {/if}
</div>
