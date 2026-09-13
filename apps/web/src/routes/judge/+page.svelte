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

  <section class="path" aria-labelledby="path-title">
    <h2 id="path-title" class="sr-only">What to do</h2>
    <ol>
      <li>
        <span aria-hidden="true">1</span>
        <div>
          <strong>Take a signed document</strong>
          <p>
            Fifty CMS-signed 1.000 g rights. Demo 08 is the one the engine
            admits.
          </p>
          <p class="path-links">
            <a class="primary" href="/jury/08-gold.pdf" download
              >Download Demo 08</a
            >
            <a href="/jury/ultratokenizer-jury-documents.zip" download>All 50</a
            >
          </p>
          <details>
            <summary>Pick another</summary>
            <div class="document-grid">
              {#each documentNumbers as number (number)}
                <a href={`/jury/documents/${number}-gold.pdf`} download
                  >{number}</a
                >
              {/each}
            </div>
          </details>
        </div>
      </li>
      <li>
        <span aria-hidden="true">2</span>
        <div>
          <strong>Upload it, unchanged</strong>
          <p>
            The engine reads back its fixed amount, its issuer and the one
            wallet it is bound to. Uploading spends nothing.
          </p>
          <p class="path-links">
            <a class="primary" href="/#engine">Open the engine</a>
          </p>
        </div>
      </li>
      <li>
        <span aria-hidden="true">3</span>
        <div>
          <strong>Check it on chain</strong>
          <p>
            Gate, verifier and ATS token, each read live and pinned by runtime
            code hash.
          </p>
          <p class="path-links">
            <a class="primary" href="/trust/">Read chain state</a>
          </p>
        </div>
      </li>
    </ol>
    <div class="path-foot">
      <p class="path-note">
        The proof and the mint are presenter-led: one designated wallet signs
        the exact request. Want your own wallet in a run?
        <a href="https://t.me/yamanc" target="_blank" rel="noreferrer"
          >Ask for a budget</a
        >.
      </p>
    </div>
  </section>

  <section class="overview-section" aria-label="How issuance is gated">
    <JudgeOverview />
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
    font-size: 0.7rem;
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
    font-size: 0.88rem;
    line-height: 1.4;
  }
  .pill {
    flex: 0 0 auto;
    padding: 3px 10px 3px 8px;
    border-radius: 999px;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    font-size: 0.7rem;
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
  .path ol {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 30px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .path li {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }
  .path li > span {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--p-accent);
    color: white;
    font-size: 0.88rem;
    font-weight: 700;
  }
  .path strong {
    display: block;
    font-size: 1rem;
    letter-spacing: -0.01em;
  }
  .path li p {
    margin: 6px 0 0;
    color: var(--p-muted);
    font-size: 0.88rem;
  }
  .path-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin-top: 12px !important;
  }
  .path-foot {
    margin-top: 26px;
    padding-top: 18px;
    border-top: 1px solid var(--p-line);
  }
  .path-note {
    margin: 0;
    color: var(--p-muted);
    font-size: 0.78rem;
    max-width: 68ch;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .overview-section {
    margin: 4px 0 30px;
  }
  .track-list p {
    margin: 10px 0 14px;
    color: var(--p-muted);
    font-size: 0.78rem;
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
    font-size: 0.88rem;
  }
  .live p {
    color: var(--p-muted);
    font-size: 0.78rem;
    margin-top: 4px;
  }
  .report {
    color: var(--p-accent);
    font-size: 0.78rem;
    font-weight: 600;
    text-decoration: none;
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
    font-size: 1.4rem;
  }
  .truth-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 28px;
    margin: 20px 0;
  }
  .truth-grid p {
    color: var(--p-muted);
    font-size: 0.78rem;
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
    .hero {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .path ol {
      grid-template-columns: 1fr;
      gap: 22px;
    }
    .live {
      max-width: 100%;
    }
    .truth-grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 480px) {
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
    .document-grid {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
  }
</style>
