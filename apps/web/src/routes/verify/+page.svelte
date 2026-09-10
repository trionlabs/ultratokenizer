<script lang="ts">
  import ReceiptAudit from '$lib/components/ReceiptAudit.svelte';
  import Glyph from '$lib/prototype/Glyph.svelte';
</script>

<svelte:head
  ><title>Independent receipt verifier — Ultratokenizer</title><meta
    name="description"
    content="Check actual issuance receipts against independently supplied trust pins. Local signature and binding checks, with an optional explicit online SP1 proof check."
  /></svelte:head
>
<a class="skip-link" href="#verifier">Skip to verifier</a>
<div class="live-shell">
  <header class="live-header">
    <a class="live-brand" href="/"><span>u</span>ultratokenizer<i>.</i></a><span
      class="mode-pill">Read-only · caller-controlled trust</span
    ><a class="text-link" href="/"
      >Issuance workspace <Glyph name="arrow" size={15} /></a
    >
  </header>
  <main id="verifier" tabindex="-1" class="verifier-main">
    <div class="verifier-intro">
      <p class="overline">Independent verifier</p>
      <h1>A receipt.<br /><em>A closer look.</em></h1>
      <p>
        Check a saved issuance receipt against your own trust pins. See each
        verified fact and each missing piece.
      </p>
    </div>
    <ReceiptAudit />
    <section
      class="verifier-boundary"
      aria-labelledby="verifier-boundary-title"
    >
      <h2 id="verifier-boundary-title">Verification has distinct layers.</h2>
      <p>
        Local checks cover request bindings and EOA signatures. Proof bytes are
        checked only when you explicitly enable the pinned RPC verifier. A
        transaction hash does not establish chain inclusion, historical
        authority, reserve consumption or finality.
      </p>
      <p>
        The current issuance source is a synthetic test capsule. Cryptographic
        validity grants no real gold backing or redemption right. This page
        accepts actual issuance receipt format; former sample receipts are
        rejected.
      </p>
      <p>
        Files are read in this browser. Offline mode needs the page and worker
        assets from the host, but no application backend, account or wallet.
        Nothing is uploaded unless you explicitly enable the public-proof RPC
        check.
      </p>
    </section>
  </main>
</div>
