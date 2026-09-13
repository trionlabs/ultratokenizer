<script lang="ts">
  import { onMount } from 'svelte';
  import PortalShell from '$lib/components/PortalShell.svelte';

  import PageMeta from '$lib/components/PageMeta.svelte';
  // The Hedera "Tokenization of Anything" qualification requirements, each
  // bound to something a reviewer can open. The generated /llms-full.txt
  // carries the same mapping with every deployed address resolved.
  const qualification = [
    {
      requirement:
        'Use the Asset Tokenization Studio to issue or manage a tokenised asset',
      status: 'Met',
      evidence:
        'The asset is an ATS token graph built from a pinned upstream commit and compiled in-repo. Its issuance role belongs to the Gate mint adapter, so ATS is extended rather than wrapped: minting is held by a proof-gated contract instead of a key holder.',
      href: '/trust/',
      label: 'Inspect the token graph',
    },
    {
      requirement: 'Deploy and demonstrate on Hedera testnet',
      status: 'Met',
      evidence:
        'Gate, SP1 Groth16 verifier, mint adapter and the complete ATS facet graph are deployed on chain ID 296. The Trust page reads their state from chain on every visit, and the graph was admitted by a reviewed atomic creation transaction pinned to a block.',
      href: '/trust/',
      label: 'Read live chain state',
    },
    {
      requirement: 'Public GitHub repo, contracts verified where applicable',
      status: 'Met',
      evidence:
        'Both repositories are public. The Gate, the verifier and the ATS graph have exact runtime source matches in Sourcify, and every address is additionally pinned by runtime code hash in deployment.json, so a swapped implementation fails the check instead of passing silently.',
      href: 'https://github.com/trionlabs/ultratokenizer',
      label: 'Open the repository',
    },
    {
      requirement:
        'Demo video showing issuance, configuration and a lifecycle operation',
      status: 'Runbook published',
      evidence:
        'Configuration is the Trust page. Issuance is the complete run in the token engine. The lifecycle operation is an ATS transfer of the minted token in 0.001 g units, which exercises the transfer and balance-tracker facets rather than bypassing them.',
      href: 'https://github.com/trionlabs/ultratokenizer/blob/main/PRESENTATION.md',
      label: 'Five-minute runbook',
    },
  ];

  const beyondBaseline = [
    'Compliance facets are deployed with the graph: a control list for transfer restrictions, a supply cap, and ERC-1400 partitions.',
    'Scheduled-task libraries ship in the deployed topology for later vesting, coupon and maturity work.',
    'A compliance control the Studio does not have today: issuance itself requires a zero-knowledge proof of an authenticated off-chain right, checked on chain before any supply moves.',
    'Independent verification is a product surface, not a promise: a third party re-checks an exported receipt offline against a trust policy obtained separately.',
  ];

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
      <h1>Review the claim. Follow the proof. Check the chain.</h1>
      <p class="intro">
        You can inspect the document, architecture and deployed contracts
        yourself. The presenter controls the recipient wallet for the live proof
        and mint.
      </p>
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
                : 'Live service unavailable'}</strong
        >
        <p>
          {service === 'ready'
            ? 'Demo 08 can begin after the designated wallet signs.'
            : service === 'busy'
              ? blocker
              : service === 'unavailable'
                ? 'Use the architecture and chain links while the presenter restores it.'
                : 'Reading the document and proof service.'}
        </p>
      </div>
    </aside>
  </section>

  <section class="choice" aria-label="Choose a review path">
    <article>
      <p class="step">On your own</p>
      <h2>Inspect without a wallet</h2>
      <p>
        Download the synthetic signed allocation, upload it unchanged, and
        inspect the fixed amount and issuer. Uploading does not request a proof
        or spend funds.
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
        verification, then confirms a separate Hedera mint transaction.
      </p>
      <div class="actions">
        <a class="primary" href="/#engine">Start the live run</a>
        <a href="/demo/">See the mechanism</a>
      </div>
    </article>
  </section>

  <section class="route" aria-labelledby="review-order">
    <div class="section-head">
      <p class="eyebrow">Recommended order</p>
      <h2 id="review-order">What to check</h2>
    </div>
    <ol>
      <li>
        <span>01</span>
        <div>
          <strong>Document</strong>
          <p>Upload Demo 08. Confirm 1.000 g, one issuer and one recipient.</p>
        </div>
        <a href="/#engine">Open</a>
      </li>
      <li>
        <span>02</span>
        <div>
          <strong>Proof path</strong>
          <p>
            See what SP1 proves, what becomes public and why execution is not a
            completed proof.
          </p>
        </div>
        <a href="/demo/">Explain</a>
      </li>
      <li>
        <span>03</span>
        <div>
          <strong>Authority</strong>
          <p>
            Inspect the Gate, ATS token, verifier and ERC-8004 Identity records.
          </p>
        </div>
        <a href="/trust/">Inspect</a>
      </li>
      <li>
        <span>04</span>
        <div>
          <strong>Result</strong>
          <p>
            After mint confirmation, verify the receipt and compare it with the
            chain.
          </p>
        </div>
        <a href="/verify/">Verify</a>
      </li>
    </ol>
  </section>

  <section class="track" aria-labelledby="track-title">
    <div class="section-head">
      <p class="eyebrow">Hedera track · Tokenization of Anything</p>
      <h2 id="track-title">Qualification requirements and their evidence</h2>
    </div>
    <ul class="track-list">
      {#each qualification as item (item.requirement)}
        <li>
          <div class="track-head">
            <h3>{item.requirement}</h3>
            <span class="pill">{item.status}</span>
          </div>
          <p>{item.evidence}</p>
          <a href={item.href}>{item.label} →</a>
        </li>
      {/each}
    </ul>
    <div class="beyond">
      <strong>Beyond the baseline</strong>
      <ul>
        {#each beyondBaseline as line (line)}
          <li>{line}</li>
        {/each}
      </ul>
      <p class="beyond-note">
        Not claimed for this submission: a staffed compliance operation, a
        secondary market, coupon or royalty distribution, price or NAV oracles,
        physical custody and redemption.
      </p>
    </div>
  </section>

  <section class="truth" aria-labelledby="truth-title">
    <div>
      <p class="eyebrow">Current boundary</p>
      <h2 id="truth-title">What the demo establishes</h2>
    </div>
    <div class="truth-grid">
      <p>
        <strong>On chain</strong> Gate, SP1 verifier and ATS token are deployed on
        Hedera testnet.
      </p>
      <p>
        <strong>Identity</strong> ERC-8004 records provide attribution, not a licence
        or mint authority.
      </p>
      <p>
        <strong>Asset</strong> The PDF and institution are synthetic; no physical
        backing or redemption is claimed.
      </p>
      <p>
        <strong>Completion</strong> A mint counts only after proof acceptance, wallet
        confirmation and receipt reconciliation.
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
  .track-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
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
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .track-list p {
    margin: 10px 0 14px;
    color: var(--p-muted);
    font-size: 0.8rem;
  }
  .track-list a {
    font-size: 0.78rem;
  }
  .beyond {
    margin-top: 18px;
    padding: 20px;
    border: 1px solid var(--p-line);
    border-radius: 18px;
    background: color-mix(in srgb, var(--p-paper) 92%, var(--p-iris));
  }
  .beyond strong {
    font-size: 0.86rem;
  }
  .beyond ul {
    margin: 10px 0 0;
    padding-left: 18px;
    color: var(--p-muted);
    font-size: 0.8rem;
  }
  .beyond li {
    margin-top: 6px;
  }
  .beyond-note {
    margin: 14px 0 0;
    color: var(--p-muted);
    font-size: 0.76rem;
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
  .route {
    padding: 30px 0;
    border-top: 1px solid var(--p-line);
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
  ol {
    list-style: none;
    margin: 18px 0 0;
    padding: 0;
    border-top: 1px solid var(--p-line);
  }
  li {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;
    padding: 18px 4px;
    border-bottom: 1px solid var(--p-line);
  }
  li > span {
    color: var(--p-iris);
    font-size: 0.7rem;
    font-weight: 700;
  }
  li strong {
    font-size: 0.9rem;
  }
  li p {
    color: var(--p-muted);
    font-size: 0.78rem;
    margin-top: 2px;
  }
  li a {
    color: var(--p-accent);
    font-size: 0.74rem;
    font-weight: 650;
    text-decoration: none;
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
    li {
      grid-template-columns: 32px minmax(0, 1fr);
    }
    li a {
      grid-column: 2;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live > span.waiting {
      animation: none;
    }
  }
</style>
