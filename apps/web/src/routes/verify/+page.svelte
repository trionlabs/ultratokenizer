<script lang="ts">
  import ReceiptExchange from '$lib/components/ReceiptExchange.svelte';
  import Glyph from '$lib/prototype/Glyph.svelte';
</script>

<svelte:head>
  <title>Independent receipt verifier — Ultratokenizer</title>
  <meta
    name="description"
    content="Inspect exported sample receipts locally in a dedicated browser worker. No app backend, wallet or account required."
  />
</svelte:head>
<a class="skip-link" href="#verifier">Skip to verifier</a>
<div class="verifier-workspace">
  <header class="verifier-header">
    <a href="/" class="play-brand" aria-label="Ultratokenizer preview"
      ><span>u</span>ultratokenizer<i>.</i></a
    >
    <span class="verifier-mode"
      ><Glyph name="shield" size={15} /> Read-only · local</span
    >
  </header>
  <main id="verifier" tabindex="-1">
    <p class="p-overline">Independent verifier</p>
    <h1>A receipt.<br /><em>A closer look.</em></h1>
    <p class="verifier-lede">
      Open a saved sample receipt. Inspect what it says, and what it cannot
      establish.
    </p>
    <ReceiptExchange />
    <section
      class="verifier-boundary"
      aria-labelledby="verifier-boundary-title"
    >
      <h2 id="verifier-boundary-title">Consistency is one layer.</h2>
      <p>
        This verifier supports <code>ultratokenizer.sample-receipt.v1</code> only.
        A matching digest means the saved request is internally consistent. Anyone
        can calculate a new digest for a changed request.
      </p>
      <p>
        Document evidence, issuer signatures, ZK proofs and chain outcomes are <strong
          >not verified</strong
        >. Sample receipts grant no assets, issuance authority or redemption
        rights.
      </p>
      <p>
        Files stay in this browser. No app backend, wallet or account is
        contacted. This static page and its worker must be available from the
        host; no offline cache is installed.
      </p>
    </section>
    <a href="/" class="p-text"
      >Return to the simulated journey <Glyph name="arrow" size={15} /></a
    >
  </main>
</div>
