<script lang="ts">
  import { formatGrams } from '../domain/journey';
  let { amountMg, reviewed }: { amountMg: string; reviewed: boolean } =
    $props();
</script>

<aside class="disclosure" aria-label="Privacy and public disclosure">
  <p class="eyebrow">Privacy boundary</p>
  <h2>Share the claim.<br />{' '}Keep the document.</h2>
  <div class="privacy-group">
    <span class="label-dot private-dot"></span>
    <h3>Private witness</h3>
    <ul>
      <li>Original PDF</li>
      <li>Name & account details</li>
      <li>Full statement balance</li>
    </ul>
  </div>
  <div class="privacy-group">
    <span class="label-dot public-dot"></span>
    <h3>Public on issuance</h3>
    <ul>
      <li>Requested amount{reviewed ? ` · ${formatGrams(amountMg)} g` : ''}</li>
      <li>Recipient wallet</li>
      <li>Issuer, policy & request identifiers</li>
      <li>Proof & transaction receipt</li>
    </ul>
  </div>
  <p class="small-note">
    Public identifiers can link activity. A proof does not hide the wallet or
    mint amount.
  </p>
  <div class="boundary-note">
    Production flow: prove on a user-controlled machine. A remote prover would
    require a separate disclosure decision.
  </div>
</aside>
