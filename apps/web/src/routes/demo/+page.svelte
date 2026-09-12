<script lang="ts">
  import { onMount } from 'svelte';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import JourneyOverview from '$lib/visuals/JourneyOverview.svelte';
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

  // Three acts, three parties, shown side by side. The shape of the system is
  // visible before anyone clicks; depth opens underneath each act.
  const acts = [
    {
      id: 'Prove',
      who: 'you and your machine',
      title: 'Prove',
      plain:
        'You open the signed document. Your machine checks its signature and produces a small proof. The file never leaves your computer.',
      tech: 'zkPDF verifies RSA-2048 and SHA-256 inside an SP1 zero-knowledge VM. The output is 224 bytes of public values.',
      names:
        'Three names that get confused. zkPDF is the library that reads the PDF and checks its signature. SP1 is the zero-knowledge VM that library runs inside, which is what makes the run itself provable. The on-chain verifier is a third thing, and it checks the result later, in act three.',
      visual: Step03Zkpdf,
      deeper: [
        {
          heading: 'First, what the document actually carries',
          body: 'The document carries a 196-byte capsule. Your address sits at bytes 104 to 124, inside the region the signature covers, so a stolen document cannot be redirected to anyone else.',
          visual: Step02Document,
        },
        {
          heading: 'Then, what the proof commits to',
          body: 'An EIP-712 digest over thirteen fields fixes the chain, the contract, the token, the recipient and the amount. Change any one of them and the proof stops matching. The hash drawn here is a pinned test fixture, not a live issuance.',
          visual: Step04Digest,
        },
        {
          heading: 'Last, why that hash can be trusted',
          body: 'TypeScript in the browser, Rust inside the proof, Solidity inside the contract. A parity check runs 64 adversarial cases in CI. You do not have to trust our implementation, only that three separate ones agree.',
          visual: Step05Parity,
        },
      ],
      sources: [
        { label: 'zkPDF', href: 'https://github.com/privacy-ethereum/zkpdf' },
        {
          label: 'Provenance',
          href: `${repo}proofs/README.md#dependency-provenance-and-review-boundary`,
        },
        { label: 'EIP-712', href: 'https://eips.ethereum.org/EIPS/eip-712' },
      ],
    },
    {
      id: 'Authorise',
      who: 'the institution',
      title: 'Authorise',
      plain:
        'The institution sets aside exactly one gram on the blockchain and signs a permission for this one request that expires in minutes.',
      tech: 'Backing pool cap 1000 mg, reserved 1000 mg, issued 0, plus an EIP-712 permit bound to this request digest. Reserving is not issuing.',
      names: '',
      visual: Step07Reservation,
      deeper: [
        {
          heading: 'All of it, or none of it',
          body: 'The request amount has to equal the complete authenticated capacity. A one gram right issues exactly one gram or nothing. A right is not a balance you draw down. Once issued, the token divides normally, down to a thousandth of a gram.',
          visual: Step06Exact,
        },
      ],
      sources: [
        {
          label: 'Reservations',
          href: `${repo}contracts/README.md#reservations-and-governance`,
        },
        {
          label: 'Claim profile 2',
          href: `${repo}proofs/claim-evidence/src/lib.rs`,
        },
      ],
    },
    {
      id: 'Mint',
      who: 'the chain, then anyone',
      title: 'Mint',
      plain:
        'One contract checks ten things in a fixed order and mints in a single transaction. If any check fails, nothing happens. Afterwards anyone can replay the whole issuance from the receipt.',
      tech: 'IssuanceGate.issue() is fail-closed. The mint and the accounting share one reverting transaction.',
      names: '',
      visual: Step08Gate,
      deeper: [
        {
          heading: 'First, only one address may mint',
          body: 'The token lives in Hedera Asset Tokenization Studio. Nineteen contracts are deployed and the mint adapter holds the only ISSUER role; ten other roles, including pauser and controller, are checked to have zero members. Those controls are off on purpose, or the Gate would not be the authority.',
          visual: Step09Ats,
        },
        {
          heading: 'Then, how a reviewer knows who the issuer is',
          body: 'An ERC-8004 registry entry names the issuer, the deployment and the auditor, so a reviewer can resolve them without asking us. Before the app shows any record, every claim in it is checked against live contract state on eight points. The registry says who; the Gate decides whether. It has no concept of a mint. Our own auditor record shares the governor key, so it is not independent.',
          visual: Step10Registry,
        },
      ],
      sources: [
        {
          label: 'IssuanceGate.sol',
          href: `${repo}contracts/src/IssuanceGate.sol`,
        },
        {
          label: 'ATS provenance',
          href: `${repo}contracts/ats/README.md#source-and-compiler-provenance`,
        },
        {
          label: 'ERC-8004',
          href: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        },
      ],
    },
  ];

  let expanded = $state(false);

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
        'Chain 296. Every address above is live and readable by anyone.',
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
    content="Prove, authorise, mint. How a signed gold document becomes a token anyone can verify, and what each party is actually responsible for."
  />
</svelte:head>

<PortalShell current="demo">
  <section class="masthead" aria-label="Summary">
    <div class="masthead-copy">
      <p class="eyebrow">How it works</p>
      <h1>A gold allocation on paper cannot move. This makes it move.</h1>
      <p class="intro">
        Your institution signed a paper saying one gram is yours. You cannot
        send it, split it, or let anyone check it without calling them. Three
        things fix that.
      </p>
    </div>
    <button
      class="expand-toggle"
      type="button"
      aria-pressed={expanded}
      onclick={() => (expanded = !expanded)}
      >{expanded ? 'Hide the detail' : 'Show the detail'}</button
    >
  </section>

  <section class="overview" aria-label="The whole process">
    <JourneyOverview />
  </section>

  <div class="acts">
    {#each acts as act, index}
      <section class="act" aria-label={act.id}>
        <p class="act-index"><span>{index + 1}</span>{act.who}</p>
        <h2>{act.title}</h2>
        <div class="act-visual"><act.visual /></div>
        <p class="plain">{act.plain}</p>
        <p class="tech"><span>In engineering terms</span>{act.tech}</p>
        {#if act.names}
          <p class="names">{act.names}</p>
        {/if}
        <details class="deeper" open={expanded}>
          <summary
            >Under the hood — {act.deeper.length}
            {act.deeper.length === 1 ? 'step' : 'steps'}</summary
          >
          {#each act.deeper as item, position}
            <div class="deeper-item">
              <p class="deeper-index">
                {index + 1}.{position + 1}
              </p>
              <h3>{item.heading}</h3>
              <div class="deeper-visual"><item.visual /></div>
              <p>{item.body}</p>
            </div>
          {/each}
        </details>
        <p class="sources">
          {#each act.sources as link, position}
            {#if position > 0}<span aria-hidden="true"> · </span>{/if}<a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer">{link.label}</a
            >
          {/each}
        </p>
      </section>
    {/each}
  </div>

  <p class="pending-badge">
    <strong>Not live yet.</strong> The Groth16 proof has not come back, so the Gate
    is paused and no token has been minted. Everything up to that line is deployed
    on Hedera testnet and readable by anyone.
  </p>

  <section class="closing" aria-label="Where to look next">
    <h2>Check any of this yourself</h2>
    <div class="actions">
      <a class="portal-button" href="/trust/">Live chain state</a>
      <a class="portal-button secondary" href="/">Token engine</a>
      <a class="portal-button secondary" href="/institution/">Issuer console</a>
      <a class="portal-button secondary" href="/verify/">Receipt verifier</a>
    </div>
    <p class="note-line">
      This page makes no chain calls of its own. It reads only the configuration
      this host publishes; the Trust page reads the chain live.
    </p>

    <details class="reference" aria-label="Why this is needed">
      <summary>Why a token at all</summary>
      <div class="reason">
        <div class="reason-visual"><Step01Problem /></div>
        <p>
          A paper allocation is a promise from one institution to one person.
          Minting a token for it does not fix that on its own; it moves the
          trust to whoever runs the minter. This engine removes that step: the
          minter cannot mint without a proof, a reservation and a permit it did
          not issue to itself.
        </p>
      </div>
    </details>

    <details class="reference" aria-label="Current state">
      <summary>Deployed contracts and current state</summary>
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
          This host has not published a deployment configuration, so no
          addresses are shown. The Trust page reads them from the chain.
        </p>
      {/if}
      <ul class="state-list">
        <li><strong>Gate</strong> paused, pending a verified proof.</li>
        <li>
          <strong>Backing pool</strong> cap 1000 mg, 1000 mg reserved, 0 issued.
        </li>
        <li>
          <strong>Groth16 proof</strong> outstanding. Two paid requests stalled at
          Executed and Assigned, and returned no artifact.
        </li>
        <li><strong>Mint and receipt</strong> do not exist yet.</li>
      </ul>
    </details>

    <details class="reference" aria-label="Prize criteria">
      <summary>Against the Hedera track requirements</summary>
      <ul class="criteria">
        {#each required as row}
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
    </details>
  </section>
</PortalShell>

<style>
  .masthead {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px 24px;
  }
  .masthead-copy {
    min-width: 0;
  }
  :global(.portal-shell .masthead h1) {
    font-size: clamp(1.45rem, 2.7vw, 2rem);
    letter-spacing: -0.035em;
    margin: 2px 0 7px;
    max-width: 26ch;
  }
  :global(.portal-shell .masthead .intro) {
    margin: 0;
    font-size: 0.86rem;
    max-width: 62ch;
  }
  button.expand-toggle {
    min-height: 42px;
    padding: 9px 17px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.8rem;
  }
  button.expand-toggle[aria-pressed='true'] {
    background: var(--p-accent);
    color: white;
    border-color: var(--p-accent);
  }

  .overview {
    margin-top: 12px;
    padding: 7px 0 2px;
    border-top: 1px solid var(--p-line);
    border-bottom: 1px solid var(--p-line);
  }

  /* three acts, side by side: the shape of the system with no clicking */
  .acts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 30px;
    margin-top: 16px;
    align-items: start;
  }
  .act {
    display: flex;
    flex-direction: column;
    gap: 9px;
    min-width: 0;
  }
  .act-index {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    font-size: 0.68rem;
    color: var(--p-muted);
  }
  .act-index span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--p-accent);
    color: white;
    font-size: 0.68rem;
    font-weight: 700;
  }
  :global(.portal-shell .act h2) {
    margin: 0;
    font-size: clamp(1.3rem, 2.3vw, 1.7rem);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  .act-visual {
    display: flex;
    justify-content: center;
    padding: 2px 0;
    min-width: 0;
  }
  .act-visual :global(svg) {
    width: 100%;
    max-width: min(215px, 24vh);
    height: auto;
  }
  .plain {
    margin: 0;
    font-size: 0.88rem;
    line-height: 1.6;
    color: var(--p-ink);
  }
  .tech {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--p-muted);
    border-left: 2px solid var(--p-line);
    padding-left: 12px;
  }
  .tech span {
    display: block;
    font-size: 0.58rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--p-accent);
    font-weight: 700;
    margin-bottom: 3px;
  }
  /* zkPDF, SP1 and the on-chain verifier are three different things and the
     page has to say which is which before anyone can follow the rest. */
  .names {
    margin: 0;
    padding: 11px 13px;
    border-radius: 10px;
    background: var(--p-accent-soft);
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--p-ink);
  }
  .deeper-index {
    margin: 0 0 4px;
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    color: var(--p-accent);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  details.deeper {
    margin: 0;
  }
  details.deeper > summary {
    font-size: 0.75rem;
    color: var(--p-accent);
    cursor: pointer;
    min-height: 30px;
    display: flex;
    align-items: center;
  }
  .deeper-item {
    padding: 13px 0;
    border-top: 1px solid var(--p-line);
  }
  .deeper-visual {
    display: flex;
    justify-content: center;
    margin-bottom: 9px;
  }
  .deeper-visual :global(svg) {
    width: 100%;
    max-width: 210px;
    height: auto;
  }
  .deeper-item h3 {
    margin: 0 0 5px;
    font-size: 0.8rem;
    font-weight: 650;
  }
  .deeper-item p {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--p-muted);
  }

  .sources {
    margin: 2px 0 0;
    font-size: 0.7rem;
    color: var(--p-muted);
    line-height: 1.7;
  }
  .sources a {
    color: var(--p-accent);
  }

  .pending-badge {
    margin: 26px 0 0;
    padding: 13px 16px;
    border-radius: 12px;
    background: #f6e9e6;
    color: #8b3f3f;
    font-size: 0.79rem;
    line-height: 1.55;
    max-width: 74ch;
  }
  .pending-badge strong {
    font-weight: 700;
  }

  /* closing */
  .closing {
    margin-top: 44px;
    border-top: 1px solid var(--p-line);
    padding-top: 26px;
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
  details.reference {
    margin-top: 16px;
    border-top: 1px solid var(--p-line);
    padding-top: 13px;
  }
  details.reference > summary {
    font-size: 0.82rem;
    color: var(--p-accent);
    cursor: pointer;
    min-height: 32px;
    display: flex;
    align-items: center;
  }
  .reason {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 22px;
    align-items: center;
    margin-top: 10px;
  }
  .reason-visual :global(svg) {
    width: 100%;
    max-width: 230px;
    height: auto;
  }
  .reason p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.65;
    color: var(--p-muted);
  }
  .addresses {
    margin-top: 10px;
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
    margin: 18px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.8rem;
  }
  .state-list strong {
    font-weight: 650;
  }
  .criteria {
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .criterion {
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 5px 16px;
    padding: 14px 16px;
    border: 1px solid var(--p-line);
    border-radius: 12px;
    background: var(--p-paper);
  }
  .criterion strong {
    font-size: 0.83rem;
    font-weight: 650;
  }
  .criterion .muted {
    grid-column: 2;
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .criterion-status {
    grid-row: span 2;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--p-accent);
  }
  .criterion[data-met='false'] .criterion-status {
    color: #8b3f3f;
  }
  .extras-head {
    margin-top: 22px;
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

  @media (max-width: 900px) {
    .acts {
      grid-template-columns: 1fr;
      gap: 34px;
    }
    .act-visual :global(svg) {
      max-width: 300px;
    }
    .reason {
      grid-template-columns: 1fr;
      gap: 14px;
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
</style>
