<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { formatGrams, readJsonFile, saveJson } from '../issuance';
  import { createBrowserReceiptVerifier } from '../verification/browser-verifier';
  import JsonFileInput from './JsonFileInput.svelte';
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
  async function importFile(file: File, kind: 'receipt' | 'policy') {
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
  <div class="audit-input-heading">
    <p class="overline">Verification run</p>
    <h2>Load both files</h2>
  </div>
  <div class="file-pair">
    <JsonFileInput
      class="file-control"
      label="Choose issuance receipt JSON"
      disabled={busy || reading}
      onfile={(file) => importFile(file, 'receipt')}
      onerror={(message) => (error = message)}
      ><span><b>01</b> Receipt</span><small
        >{receiptName || 'Drop JSON here or choose · 256 KB max'}</small
      ></JsonFileInput
    >
    <JsonFileInput
      class="file-control"
      label="Choose independent audit policy JSON"
      disabled={busy || reading}
      onfile={(file) => importFile(file, 'policy')}
      onerror={(message) => (error = message)}
      ><span><b>02</b> Trust policy</span><small
        >{policyName || 'Drop JSON here or choose · 8 KB max'}</small
      ></JsonFileInput
    >
  </div>
  <p class="field-hint">
    Get the policy separately. A receipt cannot choose who you trust.
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
      ><strong>Online proof check</strong><br />Shares public proof inputs with
      the RPC URL you enter.</span
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
      This does not prove transaction history or authority at issuance.
    </p>{:else}<p class="field-hint">
      Offline checks validate fields and signatures only. No RPC is contacted.
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
      {reading ? 'Reading the file locally…' : 'Checking your receipt…'}
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
    <p class="audit-check-summary" role="status">
      {#each ['verified', 'failed', 'unverified'] as status}
        <span class="status-pill" data-status={status}
          ><strong
            >{result.report.checks.filter((check) => check.status === status)
              .length}</strong
          >
          {status === 'verified'
            ? 'Passed'
            : status === 'failed'
              ? 'Failed'
              : 'Unverified'}</span
        >
      {/each}
    </p>
    <details
      class="audit-check-details"
      open={result.report.status === 'invalid'}
    >
      <summary>Review each check</summary>
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
    </details>
    <div class="audit-limitations">
      <p>
        Transaction history, issuer authority, backing, and redemption remain
        unverified.
      </p>
      <details class="technical-details">
        <summary>Limits of this report</summary>
        {#each result.report.limitations as limitation}<p>
            {limitation}
          </p>{/each}
      </details>
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
      {#if result.report.proofVerification}
        <details class="technical-details">
          <summary>Online proof check references</summary>
          <p class="field-hint">
            Saved RPC references are provider observations, not independent
            chain history.
          </p>
          <dl class="data-list">
            {#each [['RPC origin', result.report.proofVerification.rpcOrigin], ['Chain ID', result.report.proofVerification.chainId], ['Block number', result.report.proofVerification.blockNumber], ['Block hash', result.report.proofVerification.blockHash], ['Verifier', result.report.proofVerification.verifierAddress], ['Verifier code hash', result.report.proofVerification.verifierCodeHash], ['Verifier version', result.report.proofVerification.outerVersion], ['Program key', result.report.proofVerification.programVKey], ['Public values hash', result.report.proofVerification.publicValuesHash], ['Proof bytes hash', result.report.proofVerification.proofBytesHash], ['Verifier result', result.report.proofVerification.result]] as [name, value]}
              <div>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            {/each}
          </dl>
        </details>
      {/if}
    </div>
  </section>
{/if}
