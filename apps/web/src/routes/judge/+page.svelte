<script lang="ts">
  import { onMount } from 'svelte';
  import PortalShell from '$lib/components/PortalShell.svelte';

  import PageMeta from '$lib/components/PageMeta.svelte';
  import JudgeOverview from '$lib/visuals/JudgeOverview.svelte';
  // The Hedera "Tokenization of Anything" qualification requirements, each
  // bound to something a reviewer can open. The generated /llms-full.txt
  // carries the same mapping with every deployed address resolved.
  const qualification = [
    {
      requirement:
        'Use the Asset Tokenization Studio to issue or manage a tokenised asset',
      status: 'Met',
      met: true,
      evidence:
        'The Gate mint adapter holds the only issuance role, so minting is gated by a contract, not a key holder.',
      href: '/trust/',
      label: 'Inspect the token graph',
    },
    {
      requirement: 'Deploy and demonstrate on Hedera testnet',
      status: 'Met',
      met: true,
      evidence:
        'Gate, verifier, adapter and the full ATS facet graph are live on chain ID 296, read from chain on every visit.',
      href: '/trust/',
      label: 'Read live chain state',
    },
    {
      requirement: 'Public GitHub repo, contracts verified where applicable',
      status: 'Met',
      met: true,
      evidence:
        'Public repo. Gate, verifier and ATS graph are exact Sourcify matches, each pinned by runtime code hash.',
      href: 'https://github.com/trionlabs/ultratokenizer',
      label: 'Open the repository',
    },
    {
      requirement:
        'Demo video showing issuance, configuration and a lifecycle operation',
      status: 'Pending live result',
      met: false,
      evidence:
        'Closes only after a confirmed proof-gated mint and a 0.001 g transfer are recorded.',
      href: '/demo/',
      label: 'Follow the mechanism',
    },
  ];

  const documentNumbers = Array.from({ length: 50 }, (_, index) =>
    String(index + 1).padStart(2, '0'),
  );

  let service = $state<'checking' | 'ready' | 'busy' | 'unavailable'>(
    'checking',
  );
  let blocker = $state<string>();

  onMount(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12_000),
        ]);
        const [health, configuration] = await Promise.all([
          fetch('/api/health', { signal }),
          fetch('/api/config', { signal }),
        ]);
        if (!health.ok || !configuration.ok) throw new Error();
        const body = await configuration.json();
        if (body?.readiness?.canStart === true) service = 'ready';
        else {
          service = 'busy';
          blocker =
            body?.readiness?.blocker === 'verification_in_progress'
              ? 'A verification request is in progress.'
              : 'New verification is paused.';
        }
      } catch {
        if (!controller.signal.aborted) service = 'unavailable';
      }
    })();
    return () => controller.abort();
  });
</script>

<PageMeta route="/judge/" />

<PortalShell current="judge">
  <section class="hero">
    <div>
      <p class="eyebrow">Judge walkthrough · 5 minutes</p>
      <h1>No token mints without a proof of a signed document.</h1>
      <p class="intro">Everything here is inspectable without a wallet.</p>
    </div>
    <aside class="live" aria-live="polite">
      <span
        class:online={service === 'ready'}
        class:waiting={service === 'checking'}
      ></span>
      <div>
        <strong
          >{service === 'checking'
            ? 'Checking live service'
            : service === 'ready'
              ? 'Live service ready'
              : service === 'busy'
                ? 'Live service busy'
                : 'Live run is presenter-led'}</strong
        >
        <p>
          {service === 'ready'
            ? 'Demo 08 can begin after the designated wallet signs.'
            : service === 'busy'
              ? blocker
              : service === 'unavailable'
                ? 'The document service holds the issuer key and binds to loopback only. Everything else here reads from chain.'
                : 'Reading the document and proof service.'}
        </p>
      </div>
    </aside>
  </section>

  <section class="overview-section" aria-label="How issuance is gated">
    <JudgeOverview />
  </section>

  <section class="choice" aria-label="Choose a review path">
    <article>
      <p class="step">On your own</p>
      <h2>Inspect without a wallet</h2>
      <p>
        Download the signed allocation, upload it unchanged, and read back its
        fixed amount and issuer. Uploading spends nothing.
      </p>
      <div class="actions">
        <a class="primary" href="/jury/08-gold.pdf" download
          >Download Demo 08 PDF</a
        >
        <a href="/#engine">Open token engine</a>
      </div>
    </article>
    <article>
      <p class="step">With the presenter</p>
      <h2>Run proof and mint</h2>
      <p>
        The designated wallet signs the exact request, waits for SP1 proof
        verification, then confirms a separate Hedera mint.
      </p>
      <div class="actions">
        <a class="primary" href="/#engine">Start the live run</a>
        <a href="https://t.me/yamanc" target="_blank" rel="noreferrer"
          >Use your own wallet · @yamanc</a
        >
      </div>
    </article>
  </section>

  <section class="document-library" aria-labelledby="documents-title">
    <div>
      <p class="eyebrow">Signed test set</p>
      <h2 id="documents-title">Inspect 50 separate signed rights</h2>
      <p>
        Each is a distinct CMS-signed 1.000 g right. The engine admits Demo 08;
        the rest are for offline inspection.
      </p>
    </div>
    <div class="library-actions">
      <a href="/jury/ultratokenizer-jury-documents.zip" download
        >Download all 50 PDFs</a
      >
      <details>
        <summary>Choose one document</summary>
        <div class="document-grid">
          {#each documentNumbers as number (number)}
            <a href={`/jury/documents/${number}-gold.pdf`} download>{number}</a>
          {/each}
        </div>
      </details>
    </div>
  </section>

  <section class="track" aria-labelledby="track-title">
    <div class="section-head">
      <p class="eyebrow">Hedera track · Tokenization of Anything</p>
      <h2 id="track-title">Qualification requirements</h2>
    </div>
    <ul class="track-list">
      {#each qualification as item (item.requirement)}
        <li>
          <div class="track-head">
            <h3>{item.requirement}</h3>
            <span class="pill" class:pending={!item.met}>{item.status}</span>
          </div>
          <p>{item.evidence}</p>
          <a href={item.href}>{item.label} →</a>
        </li>
      {/each}
    </ul>
  </section>

  <section class="truth" aria-labelledby="truth-title">
    <div>
      <p class="eyebrow">Current boundary</p>
      <h2 id="truth-title">What the demo establishes</h2>
    </div>
    <div class="truth-grid">
      <p>
        <strong>Enforcement</strong> The checks are the proof, the holder signature,
        the issuer permit, the reservation and a single-use claim. One failure reverts
        the whole transaction.
      </p>
      <p>
        <strong>Identity</strong> An ERC-8004 record is attribution, never a licence
        or a mint authority.
      </p>
      <p>
        <strong>Asset</strong> The PDF and institution are synthetic. No backing,
        custody or redemption is claimed.
      </p>
      <p>
        <strong>Completion</strong> Reconciliation confirms what happened. It cannot
        authorize a mint, or repair one.
      </p>
    </div>
    <a
      class="report"
      href="https://github.com/trionlabs/ultratokenizer/blob/main/JUDGES.md"
      >Read the full judge report →</a
    >
  </section>
</PortalShell>

<style>
  .track {
    padding: 30px 0;
    border-top: 1px solid var(--p-line);
  }
  .document-library {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 0.8fr);
    gap: 22px 44px;
    padding: 30px 0;
    border-top: 1px solid var(--p-line);
  }
  .document-library h2 {
    margin-top: 6px;
    font-size: 1.7rem;
  }
  .document-library p {
    max-width: 42rem;
    margin-top: 10px;
    color: var(--p-muted);
    font-size: 0.8rem;
  }
  .library-actions {
    display: grid;
    align-content: start;
    gap: 12px;
  }
  .library-actions details {
    padding: 12px 16px;
    border: 1px solid var(--p-line);
    border-radius: 16px;
    background: var(--p-paper);
  }
  .library-actions summary {
    cursor: pointer;
    color: var(--p-accent);
    font-size: 0.78rem;
    font-weight: 650;
  }
  .document-grid {
    display: grid;
    grid-template-columns: repeat(10, minmax(0, 1fr));
    gap: 5px;
    margin-top: 12px;
  }
  .document-grid a {
    padding: 6px 2px;
    border: 1px solid var(--p-line);
    border-radius: 7px;
    color: var(--p-muted);
    font-size: 0.66rem;
    text-align: center;
    text-decoration: none;
  }
  .document-grid a:hover,
  .document-grid a:focus-visible {
    border-color: var(--p-iris);
    color: var(--p-accent);
  }
  .track-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
    gap: 18px;
    margin: 20px 0 0;
    padding: 0;
    list-style: none;
  }
  .track-list li {
    padding: 20px;
    border: 1px solid var(--p-line);
    border-radius: 18px;
    background: var(--p-paper);
  }
  .track-head {
    display: flex;
    gap: 12px;
    align-items: start;
    justify-content: space-between;
  }
  .track-head h3 {
    margin: 0;
    font-size: 0.94rem;
    line-height: 1.4;
  }
  .pill {
    flex: 0 0 auto;
    padding: 3px 10px 3px 8px;
    border-radius: 999px;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .pill::before {
    content: '\2713\00a0';
    font-weight: 700;
  }
  /* Done and not-done were the same badge, so the one open requirement read as
     finished at a glance. Hollow, and a ring instead of a tick. */
  .pill.pending {
    background: transparent;
    border: 1px solid var(--p-line);
    color: var(--p-muted);
  }
  .pill.pending::before {
    content: '\25cb\00a0';
    font-weight: 400;
  }
  .overview-section {
    margin: 4px 0 30px;
  }
  .track-list p {
    margin: 10px 0 14px;
    color: var(--p-muted);
    font-size: 0.8rem;
  }
  .track-list a {
    font-size: 0.78rem;
  }
  section p,
  section li {
    max-width: 68ch;
  }
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 52px;
    align-items: end;
    padding: 34px 0 30px;
    border-bottom: 1px solid var(--p-line);
  }
  .hero h1 {
    max-width: 760px;
  }
  .hero .intro {
    margin: 14px 0 0;
  }
  .live {
    display: flex;
    gap: 12px;
    padding: 18px;
    border: 1px solid var(--p-line);
    border-radius: 18px;
    background: color-mix(in srgb, var(--p-paper) 92%, var(--p-iris));
  }
  .live > span {
    width: 9px;
    height: 9px;
    margin-top: 6px;
    border-radius: 50%;
    background: #aa7b70;
    flex: 0 0 auto;
  }
  .live > span.online {
    background: var(--p-accent);
    box-shadow: 0 0 0 5px var(--p-accent-soft);
  }
  .live > span.waiting {
    background: var(--p-iris);
    animation: breathe 1.4s ease-in-out infinite;
  }
  .live strong {
    font-size: 0.86rem;
  }
  .live p {
    color: var(--p-muted);
    font-size: 0.76rem;
    margin-top: 4px;
  }
  .choice {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    padding: 28px 0;
  }
  .choice article {
    min-height: 238px;
    padding: 28px;
    border: 1px solid var(--p-line);
    border-radius: 22px;
    background: var(--p-paper);
    display: flex;
    flex-direction: column;
  }
  .step {
    color: var(--p-iris);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  .choice h2 {
    margin: 8px 0 10px;
    font-size: 1.4rem;
  }
  .choice article > p:not(.step) {
    color: var(--p-muted);
    max-width: 32rem;
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 18px;
    margin-top: auto;
    padding-top: 24px;
  }
  .actions a,
  .report {
    color: var(--p-accent);
    font-size: 0.78rem;
    font-weight: 650;
    text-decoration: none;
  }
  .actions .primary {
    padding: 11px 17px;
    color: white;
    background: var(--p-accent);
    border-radius: 999px;
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 20px;
  }
  .section-head h2 {
    font-size: 1.7rem;
  }
  .truth {
    margin: 6px 0 30px;
    padding: 28px;
    border-radius: 22px;
    background: var(--p-accent-soft);
  }
  .truth h2 {
    margin-top: 6px;
    font-size: 1.35rem;
  }
  .truth-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 28px;
    margin: 20px 0;
  }
  .truth-grid p {
    color: var(--p-muted);
    font-size: 0.79rem;
  }
  .truth-grid strong {
    display: block;
    color: var(--p-ink);
    margin-bottom: 3px;
  }
  @keyframes breathe {
    50% {
      opacity: 0.4;
    }
  }
  @media (max-width: 820px) {
    .hero,
    .choice {
      grid-template-columns: 1fr;
    }
    .hero {
      gap: 24px;
    }
    .live {
      max-width: 100%;
    }
    .truth-grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 480px) {
    .choice article,
    .truth {
      padding: 20px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live > span.waiting {
      animation: none;
    }
  }
  @media (max-width: 720px) {
    .document-library {
      grid-template-columns: 1fr;
    }
    .document-grid {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
  }
</style>
