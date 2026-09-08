<script lang="ts">
  import { formatGrams, type Journey } from '../domain/journey';
  import { sampleRequest } from '../adapters/sample-request';
  let {
    journey,
    digest,
    compact = false,
  }: { journey: Journey; digest: string; compact?: boolean } = $props();
  let request = $derived(sampleRequest(journey.amountMg));
</script>

{#if !compact}
  <p class="eyebrow">Independent audit / Receipt design</p>
  <h1>Verify the boundaries.</h1>
  <p class="lead">
    A receipt should let another verifier reconstruct the issuance decision
    without accessing the private document.
  </p>
{/if}
<div class="receipt-card">
  <div class="receipt-heading">
    <span class="eyebrow">Sample issuance receipt</span><span
      class="badge neutral"
      >{journey.receipt === 'simulated'
        ? 'Simulated outcome'
        : 'Not issued'}</span
    >
  </div>
  <div class="receipt-amount">
    {formatGrams(journey.amountMg)} <span>g GOLD</span>
  </div>
  <dl class="detail-list">
    <div>
      <dt>Request digest</dt>
      <dd class="hash-value">{digest}</dd>
    </div>
    <div>
      <dt>Recipient</dt>
      <dd class="hash-value">{request.recipient}</dd>
    </div>
    <div>
      <dt>Token / gate</dt>
      <dd>Synthetic addresses · not deployed</dd>
    </div>
  </dl>
</div>
{#if !compact}
  <div class="audit-checks">
    <div>
      <span class="audit-marker calculated">01</span>
      <section>
        <h2>Request integrity</h2>
        <p>
          The EIP-712 digest above is calculated from the canonical request
          using the domain module.
        </p>
      </section>
      <span class="badge success">Calculated</span>
    </div>
    <div>
      <span class="audit-marker">02</span>
      <section>
        <h2>Evidence & proof</h2>
        <p>
          Verify the proof against the approved program and document-signing
          policy.
        </p>
      </section>
      <span class="badge pending">Not connected</span>
    </div>
    <div>
      <span class="audit-marker">03</span>
      <section>
        <h2>Issuer authority</h2>
        <p>
          Check the issuer signature, holder binding, reservation and policy
          version.
        </p>
      </section>
      <span class="badge pending">Not connected</span>
    </div>
    <div>
      <span class="audit-marker">04</span>
      <section>
        <h2>Chain outcome</h2>
        <p>
          Check the actual mint event, amount, recipient and consumed
          reservation on Hedera.
        </p>
      </section>
      <span class="badge pending">Not connected</span>
    </div>
  </div>
  <details class="request-details">
    <summary>Inspect the full sample request</summary>
    <pre>{JSON.stringify(request, null, 2)}</pre>
  </details>
  <div class="boundary-note">
    <strong>What this cannot establish</strong>
    <p>
      Cryptographic checks do not establish physical gold custody, enforce
      redemption or independently prove that an issuer’s off-chain statements
      are true.
    </p>
  </div>
{/if}
