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
      class="mode-pill">Read-only · no wallet needed</span
    ><a class="text-link" href="/"
      >Issuance workspace <Glyph name="arrow" size={15} /></a
    >
  </header>
  <main id="verifier" tabindex="-1" class="verifier-main">
    <div class="verifier-intro">
      <p class="overline">Independent verifier</p>
      <h1>A receipt.<br /><em>A closer look.</em></h1>
      <p>
        Open a saved receipt. Check it against your own trust policy. See what
        passed, what failed and what is still unknown.
      </p>
    </div>
    <ReceiptAudit />
    <section
      class="verifier-boundary"
      aria-labelledby="verifier-boundary-title"
    >
      <h2 id="verifier-boundary-title">Know what the result means.</h2>
      <p>
        Offline checks compare the receipt's fields and wallet signatures.
        Enable the optional online check to test the proof against the verifier
        in your policy. Neither mode establishes the full history of an
        issuance.
      </p>
      <p>
        The current source is a synthetic test claim. A valid signature or proof
        does not establish real gold backing or a redemption right.
      </p>
      <p>
        Files are read in this browser. The default check sends no receipt data
        to an application backend or RPC. The online option shares only public
        proof inputs with the provider you choose.
      </p>
    </section>
  </main>
</div>
