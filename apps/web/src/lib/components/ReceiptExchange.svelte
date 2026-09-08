<script lang="ts">
  import type { Journey } from '../domain/journey';
  import { formatGrams } from '../domain/journey';
  import {
    createSampleReceipt,
    verifySampleReceipt,
    MAX_RECEIPT_BYTES,
    type SampleReceipt,
  } from '../adapters/sample-receipt';
  import Glyph from '../prototype/Glyph.svelte';
  let { journey, onchecked }: { journey: Journey; onchecked: () => void } =
    $props();
  let result = $state<SampleReceipt | null>(null);
  let source = $state<'current' | 'file'>('current');
  let error = $state('');
  let busy = $state(false);
  let fileInput: HTMLInputElement;
  let readVersion = 0;
  $effect(() => {
    journey;
    readVersion += 1;
    result = null;
    error = '';
    busy = false;
  });

  function checkCurrent() {
    readVersion += 1;
    busy = false;
    result = null;
    error = '';
    try {
      result = verifySampleReceipt(
        JSON.stringify(createSampleReceipt(journey)),
      );
      source = 'current';
      onchecked();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'The receipt could not be checked.';
    }
  }
  function download() {
    error = '';
    try {
      const receipt = createSampleReceipt(journey);
      const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ultratokenizer-sample-receipt.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'The receipt could not be saved.';
    }
  }
  async function readFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const version = ++readVersion;
    result = null;
    error = '';
    busy = true;
    try {
      if (file.size > MAX_RECEIPT_BYTES)
        throw new Error('Choose a sample receipt smaller than 64 KB.');
      const checked = verifySampleReceipt(await file.text());
      if (version !== readVersion) return;
      result = checked;
      source = 'file';
    } catch (cause) {
      if (version !== readVersion) return;
      error =
        cause instanceof Error
          ? cause.message
          : 'The receipt could not be checked.';
    } finally {
      if (version === readVersion) busy = false;
    }
  }
</script>

<section class="receipt-exchange" aria-labelledby="receipt-check-title">
  <div class="receipt-exchange-heading">
    <Glyph name="shield" size={18} />
    <h3 id="receipt-check-title" tabindex="-1">Take it. Check it.</h3>
  </div>
  <p>A saved sample can be checked here, even after a fresh start.</p>
  <div class="receipt-exchange-actions">
    <button
      class="button primary"
      disabled={journey.receipt !== 'simulated'}
      onclick={checkCurrent}>Recalculate request digest</button
    >
    <button
      class="button secondary"
      disabled={journey.receipt !== 'simulated'}
      onclick={download}>Save sample receipt</button
    >
    <button
      class="button secondary"
      onclick={() => fileInput.click()}
      disabled={busy}>Check saved receipt</button
    >
    <input
      class="sr-only"
      tabindex="-1"
      type="file"
      accept=".json,application/json"
      aria-label="Choose sample receipt JSON"
      bind:this={fileInput}
      onchange={readFile}
    />
  </div>
  <small>JSON only · stays in this browser · 64 KB maximum</small>
  <div aria-live="polite" aria-atomic="true">
    {#if busy}<p class="receipt-read-status">Reading sample receipt…</p>{/if}
    {#if error}<p class="receipt-read-error">{error}</p>{/if}
    {#if result}
      <div class="receipt-read-result">
        <strong><Glyph name="check" size={16} />Request digest matches</strong>
        <span
          >{source === 'file' ? 'Saved sample' : 'Current sample'} · {formatGrams(
            result.request.amount,
          )} g GOLD</span
        >
        <code>{result.requestDigest}</code>
        <p>
          Internal consistency only. No issuer signature, proof or chain outcome
          was verified.
        </p>
      </div>
    {/if}
  </div>
</section>
