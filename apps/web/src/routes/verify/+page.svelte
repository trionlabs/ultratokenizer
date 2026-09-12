<script lang="ts">
  import ReceiptAudit from '$lib/components/ReceiptAudit.svelte';
  import Glyph from '$lib/visuals/Glyph.svelte';
</script>

<svelte:head
  ><title>Independent receipt verifier — Ultratokenizer</title><meta
    name="description"
    content="Check an issuance receipt against a trust policy obtained separately. Verify local signatures and bindings, with an optional online SP1 proof check."
  /></svelte:head
>
<a class="skip-link" href="#verifier">Skip to verifier</a>
<div class="live-shell">
  <header class="live-header">
    <a class="live-brand" href="/"><span>u</span>ultratokenizer<i>.</i></a><span
      class="mode-pill">Read-only</span
    ><a class="text-link" href="/"
      >Issuance workspace <Glyph name="arrow" size={15} /></a
    >
  </header>
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
