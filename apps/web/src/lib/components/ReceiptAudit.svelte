<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { formatGrams, readJsonFile, saveJson } from '../issuance';
  import { createBrowserReceiptVerifier } from '../verification/browser-verifier';
  import {
    MAX_RECEIPT_BYTES,
    MAX_POLICY_BYTES,
    VerificationError,
    type ReceiptVerifier,
    type ReceiptVerification,
  } from '../verification/contracts';

  let verifier: ReceiptVerifier | undefined;
  let receiptText = $state('');
  let policyText = $state('');
  let receiptName = $state('');
  let policyName = $state('');
  let rpcEnabled = $state(false);
  let rpcUrl = $state('');
  let busy = $state(false);
  let reading = $state(false);
  let error = $state('');
  let result = $state<ReceiptVerification>();
  let controller: AbortController | undefined;
  let version = 0;
  let checkButton: HTMLButtonElement;

  onMount(() => {
    verifier = createBrowserReceiptVerifier();
    return () => {
      version++;
      controller?.abort();
      verifier?.dispose();
    };
  });
  function invalidate() {
    version++;
    controller?.abort();
    controller = undefined;
    result = undefined;
    error = '';
    busy = false;
  }
  async function importFile(event: Event, kind: 'receipt' | 'policy') {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy || reading) return;
    invalidate();
    reading = true;
    if (kind === 'receipt') {
      receiptText = '';
      receiptName = '';
    } else {
      policyText = '';
      policyName = '';
    }
    const captured = version;
    try {
      const text = await readJsonFile(
        file,
        kind === 'receipt' ? MAX_RECEIPT_BYTES : MAX_POLICY_BYTES,
      );
      if (captured !== version) return;
      if (kind === 'receipt') {
        receiptText = text;
        receiptName = file.name;
      } else {
        policyText = text;
        policyName = file.name;
      }
    } catch {
      if (captured === version)
        error =
          'The file could not be read. Use receipt JSON up to 256 KB and policy JSON up to 8 KB.';
    } finally {
      reading = false;
    }
  }
  async function verify() {
    if (!verifier || !receiptText || !policyText || busy || reading) return;
    invalidate();
    const captured = version;
    controller = new AbortController();
    busy = true;
    try {
      const checked = await verifier.verify(receiptText, {
        policyText,
        ...(rpcEnabled ? { rpcUrl } : {}),
        signal: controller.signal,
      });
      if (captured === version) result = checked;
    } catch (cause) {
      if (captured === version)
        error =
          cause instanceof VerificationError
            ? cause.message
            : 'The receipt could not be checked.';
    } finally {
      if (captured === version) {
        busy = false;
        if (controller?.signal.aborted) {
          await tick();
          checkButton?.focus();
        }
      }
    }
  }
  function cancel() {
    controller?.abort();
  }
  function saveReport() {
    if (result) saveJson(result.report, 'ultratokenizer-audit-report.json');
  }
  function label(id: string) {
    return id
      .replaceAll('_', ' ')
      .replace(/^./, (first) => first.toUpperCase());
  }
</script>

<section class="audit-controls" aria-label="Receipt verification inputs">
  <div class="file-pair">
    <label class="file-control"
      ><span><b>01</b> Issuance receipt</span><small
        >{receiptName || 'Public receipt JSON · 256 KB max'}</small
      ><input
        type="file"
        accept=".json,application/json"
        aria-label="Choose issuance receipt JSON"
        disabled={busy || reading}
        onchange={(event) => importFile(event, 'receipt')}
      /></label
    >
    <label class="file-control"
      ><span><b>02</b> Independent trust policy</span><small
        >{policyName || 'Caller policy JSON · 8 KB max'}</small
      ><input
        type="file"
        accept=".json,application/json"
        aria-label="Choose independent audit policy JSON"
        disabled={busy || reading}
        onchange={(event) => importFile(event, 'policy')}
      /></label
    >
  </div>
  <p class="field-hint">
    Obtain trust pins independently. A policy supplied by the receipt's author
    cannot establish that author's authority.
  </p>
  <label class="disclosure-control"
    ><input
      type="checkbox"
      checked={rpcEnabled}
      disabled={busy || reading}
      onchange={(event) => {
        invalidate();
        rpcEnabled = event.currentTarget.checked;
      }}
    /><span
      >Enable an online proof check using my explicit RPC. This sends public
      proof bytes, public values and the program key to that provider.</span
    ></label
  >
  {#if rpcEnabled}<label class="text-field"
      >Proof verifier RPC URL<input
        type="url"
        placeholder="https://… or http://localhost:…"
        value={rpcUrl}
        disabled={busy}
        oninput={(event) => {
          invalidate();
          rpcUrl = event.currentTarget.value;
        }}
      /></label
    >
    <p class="field-hint">
      The worker checks the configured chain and pinned verifier code, then
      calls the real SP1 verifier. This is an online check; historical registry
      and transaction evidence remain incomplete.
    </p>{:else}<p class="field-hint">
      Offline mode checks canonical bindings and EOA signatures. Proof
      cryptography and chain history remain unverified. No RPC is contacted.
    </p>{/if}
  <div class="audit-actions">
    <button
      class="primary-button"
      bind:this={checkButton}
      disabled={!receiptText ||
        !policyText ||
        (rpcEnabled && !rpcUrl) ||
        busy ||
        reading}
      onclick={verify}
      >{rpcEnabled
        ? 'Check receipt + online proof'
        : 'Check receipt offline'}</button
    >{#if busy}<button class="secondary-button" onclick={cancel}
        >Cancel verification</button
      >{/if}{#if result}<button class="secondary-button" onclick={saveReport}
        >Save audit report</button
      >{/if}
  </div>
  {#if reading || busy}<p class="status-line" role="status">
      {reading ? 'Reading JSON locally…' : 'Checking in a dedicated worker…'}
    </p>{/if}
  {#if error}<p class="inline-error receipt-read-error" role="alert">
      {error}
    </p>{/if}
</section>

{#if result}
  <section class="audit-report" aria-labelledby="audit-result-title">
    <div class="audit-report-heading">
      <div>
        <h2 id="audit-result-title">
          {result.report.status === 'invalid'
            ? 'Receipt checks failed'
            : 'Checks completed · history incomplete'}
        </h2>
        <p>
          {formatGrams(result.receipt.request.amount)} g · {result.mode ===
          'offline'
            ? 'Offline checks'
            : 'Explicit online proof check'}
        </p>
      </div>
      <span class="status-pill">{result.report.status}</span>
    </div>
    <dl class="audit-checks">
      {#each result.report.checks as check}<div>
          <dt>{label(check.id)}</dt>
          <dd class="check-status" data-status={check.status}>
            {check.status === 'unverified'
              ? 'Unverified'
              : check.status === 'verified'
                ? 'Verified'
                : 'Failed'}
          </dd>
          <dd class="check-detail">{check.detail}</dd>
        </div>{/each}
    </dl>
    <div class="audit-limitations">
      {#each result.report.limitations as limitation}<p>{limitation}</p>{/each}
      <details class="technical-details">
        <summary>Request and transaction references</summary>
        <dl class="data-list">
          <div>
            <dt>Request digest</dt>
            <dd>{result.report.requestDigest}</dd>
          </div>
          <div>
            <dt>Recipient</dt>
            <dd>{result.receipt.request.recipient}</dd>
          </div>
          <div>
            <dt>Transaction reference</dt>
            <dd>{result.receipt.transaction?.hash ?? 'Not supplied'}</dd>
          </div>
        </dl>
      </details>
    </div>
  </section>
{/if}
