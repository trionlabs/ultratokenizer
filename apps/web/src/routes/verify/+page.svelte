<script lang="ts">
  import ReceiptAudit from '$lib/components/ReceiptAudit.svelte';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import PageMeta from '$lib/components/PageMeta.svelte';
</script>

<PageMeta route="/verify/" />

<a class="skip-link" href="#verifier">Skip to verifier</a>
<div class="live-shell">
  <AppHeader current="verify" />
  <main id="verifier" tabindex="-1" class="verifier-main">
    <div class="verifier-intro">
      <p class="scene-kicker">Independent verifier</p>
      <h1>Verify a receipt.</h1>
      <p>Compare it with trust settings you obtained separately.</p>
      <p class="audit-context">
        No wallet needed. <a href="/trust/">Inspect deployment records</a> ·
        <a href="/demo/">Explore the roles</a>
      </p>
    </div>
    <ReceiptAudit />
  </main>
</div>

<style>
  .audit-context {
    margin-top: 12px;
    font-size: 0.85rem;
  }
</style>
