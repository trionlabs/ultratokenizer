<script lang="ts">
  import { onMount } from 'svelte';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import Glyph from '$lib/visuals/Glyph.svelte';
  import { fetchHostedDeployment } from '$lib/application/hosted-deployment';
  import { parseDeploymentConfig } from '$lib/issuance';
  import type { DeploymentConfig } from '$lib/issuance';
  import Step01Problem from '$lib/visuals/steps/Step01Problem.svelte';
  import Step02Document from '$lib/visuals/steps/Step02Document.svelte';
  import Step03Zkpdf from '$lib/visuals/steps/Step03Zkpdf.svelte';
  import Step04Digest from '$lib/visuals/steps/Step04Digest.svelte';
  import Step05Parity from '$lib/visuals/steps/Step05Parity.svelte';
  import Step06Exact from '$lib/visuals/steps/Step06Exact.svelte';
  import Step07Reservation from '$lib/visuals/steps/Step07Reservation.svelte';
  import Step08Gate from '$lib/visuals/steps/Step08Gate.svelte';
  import Step09Ats from '$lib/visuals/steps/Step09Ats.svelte';
  import Step10Registry from '$lib/visuals/steps/Step10Registry.svelte';

  const repo = 'https://github.com/trionlabs/ultratokenizer/blob/main/';

  const steps = [
    {
      id: 'The problem it solves',
      part: 'Claim',
      title: 'A paper allocation only moves inside one institution.',
      lead: 'You cannot send it, split it, or let anyone else check it.',
      contrast:
        'A token alone does not fix that. It moves the trust to whoever runs the minter.',
      sources: [{ label: 'Engine scope', href: `${repo}README.md` }],
      visual: Step01Problem,
    },
    {
      id: 'What the document carries',
      part: 'Claim',
      title: 'The wallet address sits inside the signature.',
      lead: 'A 196-byte block, eight fields, the holder at bytes 104 to 124.',
      contrast:
        'So a stolen document is useless. The circuit rejects any other recipient.',
      sources: [
        {
          label: 'Supported profile',
          href: `${repo}proofs/README.md#supported-profile`,
        },
        {
          label: 'capsule.rs',
          href: `${repo}proofs/claim-evidence/src/capsule.rs`,
        },
      ],
      visual: Step02Document,
    },
    {
      id: 'Proving the signature without showing the document',
      part: 'Proof',
      title: 'The document never leaves the holder.',
      lead: 'zkPDF checks its RSA-2048 signature inside an SP1 zkVM. Out comes 224 bytes.',
      contrast: 'This is zkPDF, not zkEmail. No DKIM and no email anywhere.',
      sources: [
        {
          label: 'Dependency provenance',
          href: `${repo}proofs/README.md#dependency-provenance-and-review-boundary`,
        },
        { label: 'zkPDF', href: 'https://github.com/privacy-ethereum/zkpdf' },
        {
          label: 'SP1 verifier',
          href: `${repo}contracts/src/vendor/sp1/README.md`,
        },
      ],
      visual: Step03Zkpdf,
    },
    {
      id: 'One hash for the whole request',
      part: 'Proof',
      title: 'One hash pins the whole issuance.',
      lead: 'An EIP-712 digest over thirteen fields: chain, contract, token, wallet, amount.',
      contrast: 'Change any one field and the proof stops matching.',
      note: 'The hash shown is the pinned test fixture, not a live issuance.',
      sources: [
        {
          label: 'Request format',
          href: `${repo}packages/domain/README.md#request-format-version-1`,
        },
        { label: 'EIP-712', href: 'https://eips.ethereum.org/EIPS/eip-712' },
      ],
      visual: Step04Digest,
    },
    {
      id: 'Three languages, one answer',
      part: 'Proof',
      title: 'Three programs must agree on it.',
      lead: 'TypeScript in the browser, Rust in the proof, Solidity in the contract. 64 adversarial cases in CI.',
      contrast:
        'You trust that three separate implementations agree, not that ours is right.',
      sources: [
        {
          label: 'The parity checker',
          href: `${repo}proofs/tools/check-request-parity.mjs`,
        },
      ],
      visual: Step05Parity,
    },
    {
      id: 'All of it, or none of it',
      part: 'Permission',
      title: '1.000 g mints 1.000 g, or nothing.',
      lead: 'The circuit rejects any amount below or above the authenticated capacity.',
      contrast:
        'A right is not a balance. Once minted, the token divides to 0.001 g.',
      sources: [
        {
          label: 'Claim profile 2',
          href: `${repo}proofs/claim-evidence/src/lib.rs`,
        },
      ],
      visual: Step06Exact,
    },
    {
      id: 'What the institution does',
      part: 'Permission',
      title: 'Capacity is reserved before any mint.',
      lead: 'Cap 1000 mg, reserved 1000, issued 0. Then a permit that expires in minutes.',
      contrast: 'Reserving is not issuing. No token exists yet.',
      sources: [
        {
          label: 'Reservations and governance',
          href: `${repo}contracts/README.md#reservations-and-governance`,
        },
      ],
      visual: Step07Reservation,
    },
    {
      id: 'The ten checks',
      part: 'Check',
      title: 'Ten checks, one transaction.',
      lead: 'Fixed order, fail-closed. Any failure reverts everything.',
      contrast:
        'The mint is not a step beside the accounting. They share one transaction.',
      sources: [
        {
          label: 'Authorization',
          href: `${repo}contracts/README.md#authorization-and-proof-contracts`,
        },
        {
          label: 'IssuanceGate.sol',
          href: `${repo}contracts/src/IssuanceGate.sol`,
        },
      ],
      visual: Step08Gate,
    },
    {
      id: 'One door into the token',
      part: 'Check',
      title: 'Exactly one address may mint.',
      lead: 'Nineteen contracts deployed. The adapter holds the sole ISSUER role; ten other roles have zero members.',
      contrast:
        'Those controls are off on purpose, or the Gate would not be the authority.',
      sources: [
        {
          label: 'ATS provenance',
          href: `${repo}contracts/ats/README.md#source-and-compiler-provenance`,
        },
        {
          label: 'Sole-issuer check',
          href: `${repo}packages/issuance/src/ats.ts`,
        },
      ],
      visual: Step09Ats,
    },
    {
      id: 'What the registry is for',
      part: 'Check',
      title: 'The registry says who. The Gate decides whether.',
      lead: 'Three agents on Hedera testnet, each record cross-checked against live contract state on eight points.',
      contrast: 'The registry has no concept of a mint.',
      note: 'Our auditor record shares the governor key, so it is not independent.',
      sources: [
        {
          label: 'ERC-8004',
          href: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        },
        {
          label: 'Registry contracts',
          href: 'https://github.com/erc-8004/erc-8004-contracts',
        },
        {
          label: 'Cross-check code',
          href: `${repo}apps/web/src/lib/application/discovery.ts`,
        },
      ],
      visual: Step10Registry,
    },
  ];

  const parts = ['Claim', 'Proof', 'Permission', 'Check'];
  const firstOfPart = parts.map((name) =>
    steps.findIndex((item) => item.part === name),
  );

  let active = $state(0);
  let showAll = $state(false);
  const step = $derived(steps[active]);

  function go(index: number) {
    active = Math.min(Math.max(index, 0), steps.length - 1);
  }

  let deployment = $state<DeploymentConfig>();
  let configState = $state<'loading' | 'ready' | 'absent'>('loading');

  const adapter = $derived(
    deployment && 'backend' in deployment && deployment.backend.kind === 'ats'
      ? deployment.backend.adapter.address
      : undefined,
  );

  const addresses = $derived(
    deployment
      ? [
          { label: 'Issuance Gate', value: deployment.auditPolicy.gate },
          { label: 'ATS token', value: deployment.auditPolicy.token },
          ...(adapter ? [{ label: 'Mint adapter', value: adapter }] : []),
          {
            label: 'SP1 verifier',
            value: deployment.auditPolicy.verifierAddress,
          },
        ]
      : [],
  );

  const required = [
    {
      need: 'Use the Asset Tokenization Studio to issue or manage a tokenised asset',
      status: 'Met',
      met: true,
      evidence:
        'Nineteen addresses live, the adapter holds the sole ISSUER role, issuance is managed through the Gate. No mint has executed yet.',
    },
    {
      need: 'Deploy and demonstrate on Hedera testnet',
      status: 'Deployed',
      met: true,
      evidence:
        'Chain 296. Every address below is live and readable by anyone.',
    },
    {
      need: 'Public repository with verified contracts on HashScan',
      status: 'Met',
      met: true,
      evidence:
        'Twenty of twenty source-verified with exact runtime matches. Three lack a creation match because the profile constructor made them.',
    },
    {
      need: 'Video showing issuance, configuration and one lifecycle operation',
      status: 'Partly met',
      met: false,
      evidence:
        'Configuration and the Gate decision path are demonstrable now. Issuance and a transfer cannot run while the Groth16 proof is outstanding.',
    },
  ];

  const extras = [
    'Secondary market',
    'Compliance controls: KYC, freezes, transfer restrictions, pauses',
    'Fee schedules, coupon or dividend distributions',
    'Oracle pricing',
    'Scheduled Transactions for vesting',
    'Upstream ATS contributions',
  ];

  let showUnmetOnly = $state(false);
  const shownRequired = $derived(
    showUnmetOnly ? required.filter((row) => !row.met) : required,
  );

  function hashscan(address: string) {
    return `https://hashscan.io/testnet/contract/${address}`;
  }

  function sourcify(address: string) {
    return `https://repo.sourcify.dev/296/${address}`;
  }

  onMount(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const text = await fetchHostedDeployment(controller.signal);
        if (!text) {
          configState = 'absent';
          return;
        }
        deployment = parseDeploymentConfig(text);
        configState = 'ready';
      } catch {
        configState = 'absent';
      }
    })();
    return () => controller.abort();
  });
</script>

<svelte:head>
  <title>How it works — Ultratokenizer</title>
  <meta
    name="description"
    content="Ten steps from a signed gold document to an exact, proof-gated token on Hedera: what each part is for, what it cannot do, and where to check it."
  />
</svelte:head>

<PortalShell current="demo">
  <section class="masthead" aria-label="Summary">
    <div>
      <p class="eyebrow">How it works</p>
      <h1>A signed document becomes exactly one token.</h1>
    </div>
    <button
      class="view-toggle"
      type="button"
      aria-pressed={showAll}
      onclick={() => (showAll = !showAll)}
      >{showAll ? 'Step through it' : 'Show everything'}</button
    >
  </section>

  {#if !showAll}
    <nav class="rail" aria-label="Parts">
      {#each parts as name, index}
        <button
          class="rail-step"
          type="button"
          data-on={step.part === name}
          aria-current={step.part === name ? 'step' : undefined}
          onclick={() => go(firstOfPart[index])}
          ><span class="rail-number">{index + 1}</span>{name}</button
        >
      {/each}
    </nav>
  {/if}

  <div class="steps" data-all={showAll}>
    {#each steps as item, index}
      <section
        class="step"
        aria-label={item.id}
        hidden={!showAll && index !== active}
      >
        <div class="step-visual"><item.visual /></div>
        <div class="step-copy">
          <p class="step-index">
            {item.part} · step {index + 1} of {steps.length}
          </p>
          <h2>{item.title}</h2>
          <p class="step-lead">{item.lead}</p>
          <p class="contrast">{item.contrast}</p>
          {#if item.note}<p class="step-note">{item.note}</p>{/if}
          <p class="sources">
            {#each item.sources as link, position}
              {#if position > 0}<span aria-hidden="true"> · </span>{/if}<a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer">{link.label}</a
              >
            {/each}
          </p>
        </div>
      </section>
    {/each}
  </div>

  {#if !showAll}
    <div class="step-controls">
      <button
        class="step-move"
        type="button"
        disabled={active === 0}
        onclick={() => go(active - 1)}
        ><Glyph name="back" size={15} /> Back</button
      >
      <ol class="dots" aria-label="Progress">
        {#each steps as item, index}
          <li>
            <button
              class="dot"
              type="button"
              data-on={index === active}
              aria-label={item.id}
              aria-current={index === active ? 'step' : undefined}
              onclick={() => go(index)}
            ></button>
          </li>
        {/each}
      </ol>
      <button
        class="step-move primary"
        type="button"
        disabled={active === steps.length - 1}
        onclick={() => go(active + 1)}
        >Next <Glyph name="arrow" size={15} /></button
      >
    </div>
  {/if}

  <section class="reference" aria-label="Current state">
    <h2>What is true right now</h2>
    {#if configState === 'loading'}
      <p class="muted" role="status">Reading the published configuration.</p>
    {:else if deployment}
      <dl class="addresses">
        {#each addresses as item}
          <div>
            <dt>{item.label}</dt>
            <dd>
              <span class="mono">{item.value}</span>
              <span class="link-pair">
                <a
                  href={hashscan(item.value)}
                  target="_blank"
                  rel="noopener noreferrer">HashScan</a
                >
                <a
                  href={sourcify(item.value)}
                  target="_blank"
                  rel="noopener noreferrer">Sourcify</a
                >
              </span>
            </dd>
          </div>
        {/each}
      </dl>
    {:else}
      <p class="notice">
        This host has not published a deployment configuration, so no addresses
        are shown here. The Trust page reads them from the chain.
      </p>
    {/if}
    <ul class="state-list">
      <li><strong>Gate</strong> paused, pending a verified proof.</li>
      <li>
        <strong>Backing pool</strong> cap 1000 mg, 1000 mg reserved, 0 issued.
      </li>
      <li class="pending">
        <strong>Groth16 proof</strong> outstanding. Two paid requests stalled at Executed
        and Assigned, and returned no artifact.
      </li>
      <li><strong>Mint and receipt</strong> do not exist yet.</li>
    </ul>
    <p class="note-line">
      This page makes no chain calls. It reads only the configuration this host
      publishes. The Trust page reads the chain.
    </p>
  </section>

  <section class="reference" aria-label="Prize criteria">
    <h2>Against the track requirements</h2>
    <div class="actions">
      <button
        class="filter"
        type="button"
        data-on={!showUnmetOnly}
        aria-pressed={!showUnmetOnly}
        onclick={() => (showUnmetOnly = false)}>All requirements</button
      >
      <button
        class="filter"
        type="button"
        data-on={showUnmetOnly}
        aria-pressed={showUnmetOnly}
        onclick={() => (showUnmetOnly = true)}>Not fully met</button
      >
    </div>
    <ul class="criteria">
      {#each shownRequired as row}
        <li class="criterion" data-met={row.met}>
          <span class="criterion-status">{row.status}</span>
          <strong>{row.need}</strong>
          <span class="muted">{row.evidence}</span>
        </li>
      {/each}
    </ul>
    <h3 class="extras-head">Extra-point items, none implemented</h3>
    <ul class="extras">
      {#each extras as item}
        <li class="mono">{item}</li>
      {/each}
    </ul>
    <p class="note-line">
      The work went into proof-gated issuance authority instead. None of these
      are implemented and none are claimed.
      <a
        href="https://ethglobal.com/events/ethonline2026/prizes#hedera"
        target="_blank"
        rel="noopener noreferrer">The track requirements</a
      >.
    </p>
  </section>

  <section class="reference" aria-label="Where to look next">
    <h2>Check it yourself</h2>
    <div class="actions">
      <a class="portal-button" href="/trust/">Live chain state</a>
      <a class="portal-button secondary" href="/">Token engine</a>
      <a class="portal-button secondary" href="/institution/">Issuer console</a>
      <a class="portal-button secondary" href="/verify/">Receipt verifier</a>
    </div>
  </section>
</PortalShell>

<style>
  /* masthead: one row, so the frame belongs to the step */
  .masthead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 16px 24px;
  }
  :global(.portal-shell .masthead h1) {
    font-size: clamp(1.5rem, 2.9vw, 2.1rem);
    letter-spacing: -0.035em;
    margin: 2px 0 0;
    max-width: 26ch;
  }
  button.view-toggle,
  button.filter {
    min-height: 42px;
    padding: 9px 17px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.8rem;
  }
  button.view-toggle[aria-pressed='true'],
  button.filter[data-on='true'] {
    background: var(--p-accent);
    color: white;
    border-color: var(--p-accent);
  }

  /* rail */
  .rail {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--p-line);
  }
  button.rail-step {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 5px 13px 5px 6px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--p-muted);
    font-size: 0.76rem;
  }
  button.rail-step[data-on='true'] {
    background: var(--p-accent-soft);
    color: var(--p-ink);
  }
  .rail-number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    font-size: 0.68rem;
    font-weight: 650;
  }
  button.rail-step[data-on='true'] .rail-number {
    background: var(--p-accent);
    color: white;
  }

  /* one step fills the frame */
  .step {
    display: grid;
    grid-template-columns: minmax(0, 1.02fr) minmax(0, 1fr);
    gap: 44px;
    align-items: center;
    padding: 12px 0 6px;
  }
  .steps[data-all='true'] .step {
    padding: 34px 0;
    border-bottom: 1px solid var(--p-line);
  }
  .step-visual {
    display: flex;
    justify-content: center;
    min-width: 0;
  }
  /* The art is 320x280, so capping width by viewport height keeps one step
     inside a 16:9 frame on short screens without letterboxing it. */
  .step-visual :global(svg) {
    width: 100%;
    max-width: min(470px, 52vh);
    height: auto;
  }
  .step-copy {
    display: flex;
    flex-direction: column;
    gap: 11px;
    min-width: 0;
  }
  .step-index {
    font-size: 0.64rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--p-accent);
    font-weight: 700;
    margin: 0;
  }
  :global(.portal-shell .step-copy h2) {
    margin: 0;
    font-size: clamp(1.25rem, 2.2vw, 1.55rem);
    font-weight: 650;
    letter-spacing: -0.025em;
    line-height: 1.22;
    text-wrap: balance;
  }
  .step-lead {
    margin: 0;
    font-size: 0.92rem;
    line-height: 1.6;
  }
  .contrast {
    margin: 0;
    border-left: 2px solid var(--p-accent);
    padding-left: 13px;
    font-size: 0.83rem;
    line-height: 1.55;
    color: var(--p-muted);
  }
  .step-note {
    margin: 0;
    font-size: 0.73rem;
    line-height: 1.5;
    color: var(--p-muted);
  }
  .sources {
    margin: 3px 0 0;
    font-size: 0.72rem;
    color: var(--p-muted);
    line-height: 1.7;
  }
  .sources a {
    color: var(--p-accent);
  }

  /* controls */
  .step-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 0 2px;
    border-top: 1px solid var(--p-line);
  }
  button.step-move {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    padding: 9px 18px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.84rem;
  }
  button.step-move.primary {
    background: var(--p-accent);
    border-color: var(--p-accent);
    color: white;
  }
  button.step-move:disabled {
    opacity: 0.35;
  }
  .dots {
    display: flex;
    align-items: center;
    gap: 7px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  button.dot {
    display: block;
    width: 8px;
    height: 8px;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--p-line);
    transition:
      background 200ms ease,
      transform 200ms ease;
  }
  button.dot[data-on='true'] {
    background: var(--p-accent);
    transform: scale(1.5);
  }

  /* reference blocks */
  .reference {
    margin-top: 52px;
    border-top: 1px solid var(--p-line);
    padding-top: 30px;
  }
  .note-line {
    margin-top: 16px;
    color: var(--p-muted);
    font-size: 0.75rem;
    max-width: 620px;
    line-height: 1.6;
  }
  .note-line a {
    color: var(--p-accent);
  }
  .addresses dd {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
  }
  .link-pair {
    display: inline-flex;
    gap: 12px;
  }
  .link-pair a {
    color: var(--p-accent);
    font-size: 0.73rem;
  }
  .state-list {
    list-style: none;
    margin: 22px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
    font-size: 0.82rem;
  }
  .state-list strong {
    font-weight: 650;
  }
  .state-list .pending {
    animation: pending 2s ease-in-out infinite;
  }
  @keyframes pending {
    50% {
      opacity: 0.55;
    }
  }
  .criteria {
    list-style: none;
    margin: 20px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .criterion {
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 6px 16px;
    padding: 15px 18px;
    border: 1px solid var(--p-line);
    border-radius: 14px;
    background: var(--p-paper);
  }
  .criterion strong {
    font-size: 0.85rem;
    font-weight: 650;
  }
  .criterion .muted {
    grid-column: 2;
    font-size: 0.76rem;
    line-height: 1.6;
  }
  .criterion-status {
    grid-row: span 2;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--p-accent);
  }
  .criterion[data-met='false'] .criterion-status {
    color: #8b3f3f;
  }
  .extras-head {
    margin-top: 26px;
  }
  .extras {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .extras li {
    padding: 6px 10px;
    border: 1px dashed var(--p-line);
    border-radius: 8px;
    color: var(--p-muted);
    font-size: 0.68rem;
  }

  @media (max-width: 860px) {
    .step {
      grid-template-columns: 1fr;
      gap: 22px;
      padding-top: 18px;
    }
    .step-visual :global(svg) {
      max-width: 340px;
    }
    .dots {
      display: none;
    }
    .criterion {
      grid-template-columns: 1fr;
    }
    .criterion .muted,
    .criterion-status {
      grid-column: 1;
      grid-row: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .state-list .pending {
      animation: none;
    }
    button.dot {
      transition: none;
    }
  }
</style>
