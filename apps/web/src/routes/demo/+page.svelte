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
      short: 'The problem',
      title: 'A paper allocation only works inside one institution.',
      lead: 'A gold allocation on paper is a promise from one institution to one person. You cannot send it, split it, or let anyone else check it without asking that institution first.',
      contrast: {
        head: 'Not this, but that',
        body: 'Minting a token for it does not fix that by itself. It moves the trust to whoever runs the minter. This engine removes that step: the minter cannot mint without a proof.',
      },
      sources: [
        {
          label: 'Engine scope and its four separate claims',
          href: `${repo}README.md`,
        },
      ],
      visual: Step01Problem,
    },
    {
      id: 'What the document carries',
      short: 'The document',
      title: "The wallet address is inside the signature's reach.",
      lead: 'The signed document carries a 196-byte block, and the recipient wallet address sits inside it.',
      evidence:
        'Eight fields at fixed offsets: magic, source id, claim id, issuer id, holder address at bytes 104 to 124, a capacity of 1000 milligrams, a unit binding, and an expiry. The signature covers all of them.',
      contrast: {
        head: 'Not this, but that',
        body: 'A stolen document is useless to a thief. The circuit rejects any recipient other than the one signed in.',
      },
      sources: [
        {
          label: 'Supported profile',
          href: `${repo}proofs/README.md#supported-profile`,
        },
        {
          label: 'Exact byte layout in capsule.rs',
          href: `${repo}proofs/claim-evidence/src/capsule.rs`,
        },
      ],
      visual: Step02Document,
    },
    {
      id: 'Proving the signature without showing the document',
      short: 'The proof',
      title: 'The document never leaves the holder.',
      lead: "The proof checks the document's signature without the document ever leaving the holder's machine.",
      evidence:
        'zkPDF verifies the RSA-2048 and SHA-256 signature inside an SP1 zero-knowledge VM. What comes out is 224 bytes.',
      contrast: {
        head: 'Not this, but that',
        body: 'This is zkPDF, not zkEmail. There is no DKIM and no email anywhere in this system.',
      },
      sources: [
        {
          label: 'Dependency provenance',
          href: `${repo}proofs/README.md#dependency-provenance-and-review-boundary`,
        },
        {
          label: 'zkPDF upstream',
          href: 'https://github.com/privacy-ethereum/zkpdf',
        },
        {
          label: 'SP1 verifier provenance',
          href: `${repo}contracts/src/vendor/sp1/README.md`,
        },
      ],
      visual: Step03Zkpdf,
    },
    {
      id: 'One hash for the whole request',
      short: 'The digest',
      title: 'One hash pins down the entire issuance.',
      lead: 'A single 32-byte hash fixes which chain, which contract, which token, which wallet and how much.',
      evidence:
        'It is an EIP-712 digest over thirteen fields. Change any one of them and the proof no longer matches.',
      contrast: {
        head: 'Not this, but that',
        body: 'Signing an amount is not the same as signing a whole request.',
      },
      note: 'The hash shown here is the pinned synthetic test fixture from the domain package, kept so a regression is caught in CI. It is not a live issuance.',
      sources: [
        {
          label: 'Request format, version 1',
          href: `${repo}packages/domain/README.md#request-format-version-1`,
        },
        { label: 'EIP-712', href: 'https://eips.ethereum.org/EIPS/eip-712' },
      ],
      visual: Step04Digest,
    },
    {
      id: 'Three languages, one answer',
      short: 'Three languages',
      title: 'Three separate programs must agree.',
      lead: 'Three independently written programs compute that hash and they have to produce the same answer.',
      evidence:
        'TypeScript in the browser, Rust inside the proof, Solidity inside the contract. A parity check runs 64 adversarial cases in CI.',
      contrast: {
        head: 'Not this, but that',
        body: 'You do not have to trust our implementation. You have to trust that three of them, written separately, agree.',
      },
      note: 'The value they agree on here is the same pinned test fixture, not a live issuance.',
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
      short: 'Exact amount',
      title: 'A 1.000 g right mints 1.000 g, or nothing.',
      lead: 'The circuit rejects any amount that is not the full authenticated capacity.',
      evidence:
        'Of the four amounts a holder might request against a 1.000 g right, exactly one is accepted.',
      contrast: {
        head: 'Not this, but that',
        body: 'A right is not a balance you draw down. Once minted, the token divides normally, down to 0.001 g.',
      },
      sources: [
        {
          label: 'Claim profile 2 in claim-evidence',
          href: `${repo}proofs/claim-evidence/src/lib.rs`,
        },
      ],
      visual: Step06Exact,
    },
    {
      id: 'What the institution does',
      short: 'The institution',
      title: 'Capacity is set aside before anything is minted.',
      lead: 'The institution reserves the exact amount on chain, then signs a permit that authorizes this one request and expires in minutes.',
      evidence: 'Cap 1000 mg, reserved 1000 mg, issued 0.',
      contrast: {
        head: 'Not this, but that',
        body: 'Reserving is not issuing. At this point no token exists.',
      },
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
      short: 'The Gate',
      title: 'One contract decides, in a fixed order.',
      lead: 'The Gate runs ten checks in sequence and reverts the whole transaction if any one fails.',
      evidence:
        'Not paused, request well formed, digest recomputed in Solidity, four replay registers clear, holder signature, issuer permit, registered rights, SP1 proof, reservation match, then mint.',
      contrast: {
        head: 'Not this, but that',
        body: 'The mint is not a separate step running alongside the accounting. They share one transaction.',
      },
      sources: [
        {
          label: 'Authorization and proof contracts',
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
      short: 'Hedera ATS',
      title: 'Exactly one address may mint.',
      lead: "The token lives in Hedera's Asset Tokenization Studio, and the mint adapter holds the sole ISSUER role.",
      evidence:
        'Nineteen addresses are deployed. Ten other roles, including pauser, controller and control list, are checked to have zero members.',
      contrast: {
        head: 'Not this, but that',
        body: 'Those controls are off on purpose. If anyone else could change supply, the Gate would not be the authority.',
      },
      sources: [
        {
          label: 'Source and compiler provenance',
          href: `${repo}contracts/ats/README.md#source-and-compiler-provenance`,
        },
        {
          label: 'Sole-issuer verification',
          href: `${repo}packages/issuance/src/ats.ts`,
        },
      ],
      visual: Step09Ats,
    },
    {
      id: 'What the registry is for',
      short: 'ERC-8004',
      title: 'The registry says who. The Gate decides whether.',
      lead: 'The registry tells you who the issuer is. It never decides whether a token gets minted.',
      evidence:
        'Three agents are registered on Hedera testnet: issuer 116, deployment 117, auditor 118. Before the app shows any of it, every claim in the record is checked against live contract state on eight points.',
      contrast: {
        head: 'Not this, but that',
        body: 'The registry has no concept of a mint. It can hold a pointer and a hash, nothing more.',
      },
      note: 'Our auditor record shares the governor key, so it is not independent, and the Trust page says so wherever it appears.',
      sources: [
        {
          label: 'ERC-8004 registration',
          href: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        },
        {
          label: 'Registry contracts',
          href: 'https://github.com/erc-8004/erc-8004-contracts',
        },
        {
          label: 'How this app cross-checks a record',
          href: `${repo}apps/web/src/lib/application/discovery.ts`,
        },
      ],
      visual: Step10Registry,
    },
  ];

  const chapters = [
    {
      key: 'Claim',
      thesis: 'A signed document, and the wallet address is inside it.',
      from: 0,
      to: 2,
    },
    {
      key: 'Proof',
      thesis:
        'Verified inside a zkVM, and out comes one hash that three languages agree on.',
      from: 2,
      to: 5,
    },
    {
      key: 'Permission',
      thesis:
        'The exact amount is reserved on chain, and the permit expires in minutes.',
      from: 5,
      to: 7,
    },
    {
      key: 'Check',
      thesis:
        'Ten ordered checks, one door into the token, and a registry that decides nothing.',
      from: 7,
      to: 10,
    },
  ];

  let active = $state(0);
  let showAll = $state(false);
  const chapter = $derived(chapters[active]);

  function go(index: number) {
    active = Math.min(Math.max(index, 0), chapters.length - 1);
  }

  function inChapter(index: number) {
    return index >= chapter.from && index < chapter.to;
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
        'ATS compiled from pinned upstream sources. Nineteen addresses live, the adapter holds the sole ISSUER role, issuance is managed through the Gate. No mint has executed yet.',
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
        'Twenty of twenty source-verified with exact runtime matches. Three lack a creation match because they have no creation transaction of their own: the profile constructor made them.',
    },
    {
      need: 'Video showing issuance, configuration and one lifecycle operation',
      status: 'Partly met',
      met: false,
      evidence:
        'Configuration, authority registration and the Gate decision path are demonstrable now. Issuance and a transfer cannot run while the Groth16 proof is outstanding.',
    },
  ];

  const extras = [
    'Secondary market for ATS-issued assets',
    'Compliance controls: KYC, freezes, transfer restrictions, pauses',
    'Custom fee schedules, coupon or dividend distributions',
    'Oracle integration for asset pricing',
    'Scheduled Transactions for vesting or coupons',
    'Upstream contributions to ATS',
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
  <section aria-label="Summary">
    <p class="eyebrow">How it works</p>
    <h1>A signed document becomes exactly one token.</h1>
    <p class="intro">
      Ten steps, one idea each. Each step says what the part is for, what it
      cannot do, and where to check the claim yourself.
    </p>
    <div class="actions">
      <button
        class="view-toggle"
        type="button"
        aria-pressed={showAll}
        onclick={() => (showAll = !showAll)}
        >{showAll ? 'Step through them' : 'Show everything'}</button
      >
      <span class="muted counter"
        >{showAll
          ? `${chapters.length} parts, ${steps.length} steps`
          : `Part ${active + 1} of ${chapters.length}`}</span
      >
    </div>
  </section>

  {#if !showAll}
    <nav class="rail" aria-label="Parts">
      {#each chapters as item, index}
        <button
          class="rail-step"
          type="button"
          data-on={index === active}
          aria-current={index === active ? 'step' : undefined}
          onclick={() => go(index)}
          ><span class="rail-number">{index + 1}</span><span class="rail-label"
            >{item.key}</span
          ></button
        >
      {/each}
    </nav>
    <div class="chapter-head">
      <h2>{chapter.key}</h2>
      <p>{chapter.thesis}</p>
    </div>
  {/if}

  <div class="steps" data-all={showAll}>
    {#each steps as item, index}
      <section
        class="step"
        aria-label={item.id}
        hidden={!showAll && !inChapter(index)}
      >
        <div class="step-visual">
          <item.visual />
        </div>
        <div class="step-copy">
          <p class="step-index">Step {index + 1} of {steps.length}</p>
          <h3>{item.title}</h3>
          <p class="step-lead">{item.lead}</p>
          {#if item.evidence}
            <p class="step-evidence">{item.evidence}</p>
          {/if}
          {#if item.contrast}
            <div class="contrast">
              <p class="contrast-head">{item.contrast.head}</p>
              <p>{item.contrast.body}</p>
            </div>
          {/if}
          {#if item.note}
            <p class="step-note">{item.note}</p>
          {/if}
          <p class="sources">
            <span class="sources-head">Check it</span>
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
      <button
        class="step-move primary"
        type="button"
        disabled={active === chapters.length - 1}
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
  .counter {
    font-size: 0.78rem;
  }
  button.view-toggle,
  button.filter {
    min-height: 44px;
    padding: 10px 18px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.82rem;
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
    gap: 6px;
    margin-top: 34px;
    padding-bottom: 22px;
    border-bottom: 1px solid var(--p-line);
  }
  button.rail-step {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 38px;
    padding: 6px 13px 6px 8px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--p-muted);
    font-size: 0.76rem;
  }
  button.rail-step[data-on='true'] {
    background: var(--p-accent-soft);
    border-color: var(--p-line);
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

  /* steps */
  .step {
    display: grid;
    grid-template-columns: minmax(0, 0.85fr) minmax(0, 1fr);
    gap: 40px;
    align-items: center;
    padding: 40px 0 8px;
  }
  .steps[data-all='true'] .step {
    padding: 44px 0;
    border-bottom: 1px solid var(--p-line);
  }
  .step-visual {
    display: flex;
    justify-content: center;
    min-width: 0;
  }
  .step-copy {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .step-index {
    font-size: 0.66rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--p-accent);
    font-weight: 700;
    margin: 0;
  }
  .step-copy h3 {
    margin: 0;
    font-size: 1.18rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.3;
    text-wrap: balance;
  }
  .chapter-head {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 30px 0 2px;
  }
  .chapter-head h2 {
    margin: 0;
    font-size: clamp(1.7rem, 3.4vw, 2.3rem);
    letter-spacing: -0.035em;
    line-height: 1.05;
  }
  .chapter-head p {
    margin: 0;
    max-width: 620px;
    font-size: 0.95rem;
    line-height: 1.55;
    color: var(--p-muted);
  }
  .step-lead {
    margin: 0;
    font-size: 0.94rem;
    line-height: 1.6;
  }
  .step-evidence {
    margin: 0;
    font-size: 0.83rem;
    line-height: 1.65;
    color: var(--p-muted);
  }
  .contrast {
    border-left: 2px solid var(--p-accent);
    padding: 2px 0 2px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .contrast p {
    margin: 0;
    font-size: 0.83rem;
    line-height: 1.6;
  }
  .contrast-head {
    font-size: 0.64rem !important;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--p-accent);
    font-weight: 700;
  }
  .step-note {
    margin: 0;
    font-size: 0.79rem;
    line-height: 1.6;
    color: var(--p-muted);
  }
  .sources {
    margin: 4px 0 0;
    font-size: 0.75rem;
    color: var(--p-muted);
    line-height: 1.8;
  }
  .sources-head {
    display: block;
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--p-muted);
    margin-bottom: 2px;
  }
  .sources a {
    color: var(--p-accent);
  }

  .step-controls {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 0 8px;
    border-top: 1px solid var(--p-line);
  }
  button.step-move {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 46px;
    padding: 10px 20px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.86rem;
  }
  button.step-move.primary {
    background: var(--p-accent);
    border-color: var(--p-accent);
    color: white;
  }
  button.step-move:disabled {
    opacity: 0.4;
  }

  /* reference blocks */
  .reference {
    margin-top: 56px;
    border-top: 1px solid var(--p-line);
    padding-top: 32px;
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
    padding: 16px 18px;
    border: 1px solid var(--p-line);
    border-radius: 14px;
    background: var(--p-paper);
  }
  .criterion strong {
    font-size: 0.86rem;
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
    margin-top: 28px;
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

  @media (max-width: 820px) {
    .step {
      grid-template-columns: 1fr;
      gap: 26px;
      padding-top: 30px;
    }
    .rail-label {
      display: none;
    }
    button.rail-step {
      padding: 6px 8px;
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
  }
</style>
