<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { Journey } from '../domain/journey';
  import { formatGrams } from '../domain/journey';
  import { createSampleReceipt } from '../adapters/sample-receipt';
  import { createBrowserReceiptVerifier } from '../verification/browser-verifier';
  import {
    MAX_RECEIPT_BYTES,
    VerificationError,
    type ReceiptVerifier,
    type ReceiptVerification,
  } from '../verification/contracts';
  import Glyph from '../prototype/Glyph.svelte';
  let { journey, onchecked }: { journey?: Journey; onchecked?: () => void } =
    $props();
  let verifier: ReceiptVerifier | undefined;
  let result = $state<ReceiptVerification | null>(null);
  let source = $state<'current' | 'file'>('current');
  let error = $state('');
  let busy = $state(false);
  let status = $state('');
  let fileInput: HTMLInputElement;
  let fileButton: HTMLButtonElement;
  let readVersion = 0;
  let controller: AbortController | undefined;
  onMount(() => {
    verifier = createBrowserReceiptVerifier();
  });
  onDestroy(() => {
    invalidate();
    verifier?.dispose();
  });
  function invalidate() {
    readVersion += 1;
    controller?.abort();
    controller = undefined;
    result = null;
    error = '';
    busy = false;
  }
  $effect(() => {
    journey;
    invalidate();
  });
  function begin() {
    invalidate();
    controller = new AbortController();
    busy = true;
    return { version: readVersion, signal: controller.signal };
  }
  function showError(cause: unknown) {
    error =
      cause instanceof VerificationError
        ? cause.message
        : 'The sample receipt could not be read. Choose a supported JSON file.';
  }
  async function verify(
    text: string,
    origin: 'current' | 'file',
    version: number,
    signal: AbortSignal,
  ) {
    if (version !== readVersion) return;
    status = 'Verifying in a dedicated worker…';
    const checkedJourney = journey;
    if (!verifier) throw new VerificationError('unavailable');
    const checked = await verifier.verify(text, { signal });
    if (version !== readVersion || checkedJourney !== journey) return;
    result = checked;
    source = origin;
    if (origin === 'current') onchecked?.();
  }
  async function checkCurrent() {
    const { version, signal } = begin();
    try {
      if (!journey) throw new VerificationError('invalid_receipt');
      await verify(
        JSON.stringify(createSampleReceipt(journey)),
        'current',
        version,
        signal,
      );
    } catch (cause) {
      if (version === readVersion) showError(cause);
    } finally {
      if (version === readVersion) busy = false;
    }
  }
  function download() {
    error = '';
    try {
      if (!journey) return;
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
    } catch {
      error = 'Complete the sample journey before saving its receipt.';
    }
  }
  async function readFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const { version, signal } = begin();
    status = 'Reading sample receipt…';
    try {
      if (file.size > MAX_RECEIPT_BYTES)
        throw new VerificationError('too_large');
      const text = await file.text();
      await verify(text, 'file', version, signal);
    } catch (cause) {
      if (version === readVersion) showError(cause);
    } finally {
      if (version === readVersion) busy = false;
    }
  }
  async function cancelRead() {
    invalidate();
    error = 'Receipt verification was cancelled.';
    await tick();
    fileButton?.focus();
  }
</script>

<section class="receipt-exchange" aria-labelledby="receipt-check-title">
  <div class="receipt-exchange-heading">
    <Glyph name="shield" size={18} />
    <h3 id="receipt-check-title" tabindex="-1">Take it. Check it.</h3>
  </div>
  <p>
    A saved sample can be checked here, even after a fresh start. Verification
    runs in a dedicated browser worker.
  </p>
  <div class="receipt-exchange-actions">
    {#if journey}<button
        class="button primary"
        disabled={journey.receipt !== 'simulated'}
        onclick={checkCurrent}>Recalculate request digest</button
      >
      <button
        class="button secondary"
        disabled={journey.receipt !== 'simulated'}
        onclick={download}>Save sample receipt</button
      >{/if}
    <button
      class="button secondary"
      onclick={() => fileInput.click()}
      bind:this={fileButton}>Check saved receipt</button
    >
    {#if busy}<button class="button secondary" onclick={cancelRead}
        >Cancel verification</button
      >{/if}
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
    {#if busy}<p class="receipt-read-status">{status}</p>{/if}
    {#if error}<p class="receipt-read-error">{error}</p>{/if}
    {#if result}
      <div class="receipt-read-result">
        <strong><Glyph name="check" size={16} />Request digest matches</strong>
        <span
          >{source === 'file' ? 'Saved sample' : 'Current sample'} · {formatGrams(
            result.receipt.request.amount,
          )} g GOLD</span
        >
        <code>{result.receipt.requestDigest}</code>
        <p>
          Internal consistency only. No issuer signature, proof or chain outcome
          was verified.
        </p>
        <dl class="verification-levels" aria-label="Evidence levels">
          <div>
            <dt>Request integrity</dt>
            <dd>Consistent · dedicated worker</dd>
          </div>
          <div>
            <dt>Document evidence</dt>
            <dd>Not verified</dd>
          </div>
          <div>
            <dt>Issuer authority</dt>
            <dd>Not verified</dd>
          </div>
          <div>
            <dt>ZK proof</dt>
            <dd>Not verified</dd>
          </div>
          <div>
            <dt>Chain outcome</dt>
            <dd>Not verified</dd>
          </div>
        </dl>
      </div>
    {/if}
  </div>
</section>
