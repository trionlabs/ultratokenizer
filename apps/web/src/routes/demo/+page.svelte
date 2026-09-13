<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import Glyph from '$lib/visuals/Glyph.svelte';
  import EngineStage from '$lib/visuals/EngineStage.svelte';
  import { fetchHostedDeployment } from '$lib/application/hosted-deployment';
  import { parseDeploymentConfig } from '$lib/issuance';
  import type { DeploymentConfig } from '$lib/issuance';
  import Step02Document from '$lib/visuals/steps/Step02Document.svelte';
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
      id: 'Prove',
      who: 'you',
      line: 'Your machine checks the signature and emits a small proof. The file never leaves.',
      why: 'Otherwise you would upload your document to a server and have to trust whoever runs it.',
      aside:
        'zkPDF reads the signature. SP1 is the VM it runs in. The on-chain verifier is a third thing — step three.',
      items: [
        {
          icon: 'lock' as const,
          label: 'Wallet bound',
          line: 'Your address sits inside the signed bytes.',
          why: 'So a leaked document is worthless to anyone else.',
          visual: Step02Document,
          href: `${repo}proofs/claim-evidence/src/capsule.rs`,
        },
        {
          icon: 'receipt' as const,
          label: 'One digest',
          line: 'Fifteen fields, one hash.',
          why: 'Fifteen request fields hash into one digest, and the EIP-712 domain binds it to this chain and this contract on top. That domain binding is why the same proof cannot be replayed anywhere else.',
          visual: Step04Digest,
          href: `${repo}packages/domain/README.md#request-format-version-1`,
        },
        {
          icon: 'shield' as const,
          label: 'Three languages',
          line: 'TypeScript, Rust and Solidity must agree.',
          why: 'So a bug in one implementation cannot quietly change what gets minted.',
          visual: Step05Parity,
          href: `${repo}proofs/tools/check-request-parity.mjs`,
        },
      ],
    },
    {
      id: 'Authorise',
      who: 'the institution',
      line: 'One gram is set aside on chain, then a permit that expires in minutes.',
      why: 'Otherwise the issuer could mint any amount it liked and call it backed.',
      aside: '',
      items: [
        {
          icon: 'lock' as const,
          label: 'Reserved, not issued',
          line: 'Cap 1000, reserved 1000, issued 0.',
          why: 'So the obligation is visible on chain before any token exists.',
          visual: Step07Reservation,
          href: `${repo}contracts/README.md#reservations-and-governance`,
        },
        {
          icon: 'check' as const,
          label: 'All or nothing',
          line: 'Exactly 1.000 g, or no mint at all.',
          why: 'So one right cannot be drained in slices across many mints.',
          visual: Step06Exact,
          href: `${repo}proofs/claim-evidence/src/lib.rs`,
        },
      ],
    },
    {
      id: 'Mint',
      who: 'the chain',
      line: 'Eleven ordered checks in one transaction. Any failure and nothing happens.',
      why: 'Otherwise the issuer could mint whatever it wanted and you would find out later.',
      aside: '',
      items: [
        {
          icon: 'shield' as const,
          label: 'One door',
          line: 'The adapter holds the only ISSUER role.',
          why: 'The ATS admin role is held by the profile contract, and its deployed runtime has no grantRole function at all, so no second minter can be added.',
          visual: Step09Ats,
          href: `${repo}contracts/ats/README.md#source-and-compiler-provenance`,
        },
        {
          icon: 'close' as const,
          label: 'Fail-closed',
          line: 'A failed check reverts the whole transaction.',
          why: 'So a partial failure can never leave a token minted without its accounting.',
          visual: Step08Gate,
          href: `${repo}contracts/src/IssuanceGate.sol`,
        },
      ],
    },
    {
      id: 'Evidence',
      who: 'anyone',
      line: 'The contracts are deployed and verified on Hedera testnet. The mint itself has not run yet.',
      why: 'Otherwise you would have to take our word for every claim on this page.',
      aside: '',
      items: [
        {
          icon: 'eye' as const,
          label: 'ERC-8004 registry',
          line: 'Names the issuer. Decides nothing.',
          why: 'So a reviewer resolves who the issuer is without asking us. Each record is cross-checked against live contract state before the app shows it, and the Gate still decides every mint. Be aware: our own deployment and auditor records share one key, so this deployment has no independent auditor.',
          visual: Step10Registry,
          href: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        },
      ],
    },
  ];

  let step = $state(0);

  function indexFromQuery(search: string) {
    const wanted = Number(new URLSearchParams(search).get('step'));
    const inRange =
      Number.isInteger(wanted) && wanted >= 1 && wanted <= steps.length;
    return inRange ? wanted - 1 : 0;
  }

  // Shallow routing carries the step, so Back returns to the previous one
  // instead of leaving the site. History entries this page did not create —
  // the first load, or Back onto it — carry no state, so the query string is
  // the fallback. `step` is read untracked so the effect does not re-run on
  // its own write. This runs in the browser only, which keeps the prerender
  // away from `url.searchParams`.
  $effect(() => {
    const carried = page.state.step;
    const index =
      typeof carried === 'number' ? carried : indexFromQuery(location.search);
    if (untrack(() => step) !== index) step = index;
  });

  const current = $derived(steps[step]);
  const last = $derived(step === steps.length - 1);

  function go(index: number) {
    const next = Math.min(Math.max(index, 0), steps.length - 1);
    pushState(`?step=${next + 1}`, { step: next });
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
          { label: 'Gate', value: deployment.auditPolicy.gate },
          { label: 'Token', value: deployment.auditPolicy.token },
          ...(adapter ? [{ label: 'Adapter', value: adapter }] : []),
          { label: 'Verifier', value: deployment.auditPolicy.verifierAddress },
        ]
      : [],
  );

  const required = [
    {
      need: 'Use ATS to issue or manage a tokenised asset',
      status: 'Partly met',
    },
    { need: 'Deploy and demonstrate on Hedera testnet', status: 'Deployed' },
    { need: 'Public repo, contracts verified', status: 'Met' },
    {
      need: 'Video: issuance, configuration, one lifecycle operation',
      status: 'Partly met',
    },
  ];

  function short(address: string) {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function hashscan(address: string) {
    return `https://hashscan.io/testnet/contract/${address}`;
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
    content="How a signed gold document becomes a token on Hedera: prove it, authorise the amount, mint on chain, then check the result."
  />
</svelte:head>

<PortalShell current="demo">
  <section class="masthead" aria-label="Summary">
    <p class="eyebrow">How it works</p>
    <h1>How a signed gold document becomes a token on Hedera</h1>
    <p class="standing">
      Everything below is deployed on Hedera testnet. <strong
        >No token has been minted yet</strong
      >: the Groth16 proof has not returned, so the Gate is still paused. The
      source document is synthetic, from no real bank.
    </p>
  </section>

  <section class="thesis" aria-label="What is different here">
    <p class="thesis-head">Three questions, three separate answers.</p>
    <ol>
      <li>
        <span class="q">Is the document real?</span>
        <span class="a">zkPDF, inside SP1</span>
      </li>
      <li>
        <span class="q">Who is the issuer?</span>
        <span class="a">ERC-8004 registry</span>
      </li>
      <li>
        <span class="q">May this mint happen?</span>
        <span class="a">the Gate, on Hedera</span>
      </li>
    </ol>
    <p class="thesis-foot">
      Most systems answer all three with one trusted server. Each answer here is
      checkable on its own, by someone who does not trust us.
    </p>
  </section>

  <section class="stage-wrap" aria-label="The engine">
    <EngineStage {step} />
  </section>

  <div class="reader">
    <nav class="rail" aria-label="Steps">
      {#each steps as item, index}
        <button
          class="rail-step"
          type="button"
          data-on={index === step}
          data-done={index < step}
          aria-current={index === step ? 'step' : undefined}
          onclick={() => go(index)}><span>{index + 1}</span>{item.id}</button
        >
      {/each}
    </nav>

    <section class="panel" aria-label={current.id}>
      <!-- Navigation rides with the heading so Next never falls below the
           fold, however long the detail under a step gets. -->
      <div class="panel-head">
        <div>
          <p class="who">{current.who}</p>
          <h2>{current.id}</h2>
        </div>
        <div class="nav">
          <button
            class="move"
            type="button"
            disabled={step === 0}
            onclick={() => go(step - 1)}
            aria-label="Previous step"><Glyph name="back" size={15} /></button
          >
          {#if last}
            <a class="move primary" href="/trust/"
              >See it on chain <Glyph name="arrow" size={15} /></a
            >
          {:else}
            <button
              class="move primary"
              type="button"
              onclick={() => go(step + 1)}
              >Next <Glyph name="arrow" size={15} /></button
            >
          {/if}
        </div>
      </div>
      <p class="line">{current.line}</p>
      <p class="why step-why"><span>Why</span>{current.why}</p>
      {#if current.aside}<p class="aside">{current.aside}</p>{/if}

      <ul class="items">
        {#each current.items as item (item.label)}
          <li>
            <details>
              <summary>
                <span class="icon" aria-hidden="true"
                  ><Glyph name={item.icon} size={15} /></span
                >
                <span class="item-copy">
                  <strong>{item.label}</strong>
                  <small>{item.line}</small>
                </span>
                <span class="more" aria-hidden="true"></span>
              </summary>
              <div class="item-body">
                <p class="why"><span>Why</span>{item.why}</p>
                <div class="item-visual"><item.visual /></div>
                <a href={item.href} target="_blank" rel="noopener noreferrer"
                  >Evidence <Glyph name="arrow" size={12} /></a
                >
              </div>
            </details>
          </li>
        {/each}

        {#if last}
          <li>
            <details>
              <summary>
                <span class="icon" aria-hidden="true"
                  ><Glyph name="check" size={15} /></span
                >
                <span class="item-copy">
                  <strong>Deployed contracts</strong>
                  <small>Twenty deployed, twenty runtimes verified.</small>
                </span>
                <span class="more" aria-hidden="true"></span>
              </summary>
              <div class="item-body">
                {#if deployment}
                  <ul class="chips">
                    {#each addresses as entry}
                      <li>
                        <a
                          class="chip"
                          href={hashscan(entry.value)}
                          target="_blank"
                          rel="noopener noreferrer"
                          >{entry.label}
                          <span class="mono">{short(entry.value)}</span></a
                        >
                      </li>
                    {/each}
                  </ul>
                {:else if configState === 'loading'}
                  <p class="small" role="status">Reading configuration.</p>
                {:else}
                  <p class="small">
                    This host has not published a configuration. The Trust page
                    reads the chain.
                  </p>
                {/if}
              </div>
            </details>
          </li>
          <li>
            <details>
              <summary>
                <span class="icon" aria-hidden="true"
                  ><Glyph name="receipt" size={15} /></span
                >
                <span class="item-copy">
                  <strong>Track requirements</strong>
                  <small
                    >One met, one deployed, two partly. Nothing hidden.</small
                  >
                </span>
              </summary>
              <div class="item-body">
                <ul class="criteria">
                  {#each required as row}
                    <li data-met={row.status !== 'Partly met'}>
                      <span>{row.status}</span>{row.need}
                    </li>
                  {/each}
                </ul>
                <a
                  href="https://ethglobal.com/events/ethonline2026/prizes#hedera"
                  target="_blank"
                  rel="noopener noreferrer"
                  >The requirements <Glyph name="arrow" size={12} /></a
                >
              </div>
            </details>
          </li>
        {/if}
      </ul>

      {#if last}
        <p class="pending">
          <strong>Not live yet.</strong> The Groth16 proof has not returned, so the
          Gate stays paused and nothing has been minted.
        </p>
      {/if}
    </section>

    <p class="tail">
      <a href="/trust/">Live chain state <Glyph name="arrow" size={12} /></a>
    </p>
  </div>
</PortalShell>

<style>
  .masthead {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  :global(.portal-shell .masthead h1) {
    font-size: clamp(1.5rem, 3vw, 2.15rem);
    letter-spacing: -0.04em;
    margin: 0;
  }

  .stage-wrap {
    margin: 6px 0 0;
  }

  .reader {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 0 40px;
    align-items: start;
    border-top: 1px solid var(--p-line);
    padding-top: 12px;
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  button.rail-step {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 38px;
    padding: 6px 12px 6px 7px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--p-muted);
    font-size: 0.82rem;
    justify-content: flex-start;
  }
  button.rail-step span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 23px;
    height: 23px;
    border-radius: 50%;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    font-size: 0.68rem;
    font-weight: 700;
  }
  button.rail-step[data-done='true'] span {
    background: var(--p-iris);
    color: white;
  }
  button.rail-step[data-on='true'] {
    background: var(--p-accent-soft);
    color: var(--p-ink);
    font-weight: 600;
  }
  button.rail-step[data-on='true'] span {
    background: var(--p-accent);
    color: white;
    opacity: 1;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .who {
    margin: 0;
    font-size: 0.63rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--p-accent);
    font-weight: 700;
  }
  :global(.portal-shell .panel h2) {
    margin: 0;
    font-size: clamp(1.4rem, 2.6vw, 1.85rem);
    font-weight: 650;
    letter-spacing: -0.035em;
    line-height: 1;
  }
  .line {
    margin: 0;
    font-size: 0.94rem;
    line-height: 1.5;
    max-width: 52ch;
  }
  .thesis {
    margin-top: 16px;
    padding: 14px 0 12px;
    border-top: 1px solid var(--p-line);
  }
  .thesis-head {
    margin: 0 0 9px;
    font-size: 0.86rem;
    font-weight: 650;
  }
  .thesis ol {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .thesis li {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 10px 13px;
    border-radius: 11px;
    background: var(--p-accent-soft);
  }
  .thesis .q {
    font-size: 0.78rem;
    color: var(--p-ink);
  }
  .thesis .a {
    font-size: 0.82rem;
    font-weight: 650;
    color: var(--p-accent);
  }
  .thesis-foot {
    margin: 9px 0 0;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--p-muted);
    max-width: 78ch;
  }
  .standing {
    margin: 8px 0 0;
    padding: 10px 13px;
    border-radius: 10px;
    background: #f6e9e6;
    color: #8b3f3f;
    font-size: 0.78rem;
    line-height: 1.5;
    max-width: 78ch;
  }
  .why {
    margin: 0;
    font-size: 0.79rem;
    line-height: 1.5;
    color: var(--p-muted);
    max-width: 74ch;
  }
  .why span {
    display: inline-block;
    margin-right: 7px;
    font-size: 0.6rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--p-accent);
    font-weight: 700;
  }
  .step-why {
    font-size: 0.85rem;
  }
  .more {
    flex: none;
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--p-accent);
  }
  .more::after {
    content: 'More';
  }
  details[open] .more::after {
    content: 'Less';
  }
  .aside {
    margin: 0;
    padding-left: 12px;
    border-left: 2px solid var(--p-accent);
    font-size: 0.76rem;
    line-height: 1.5;
    color: var(--p-muted);
    max-width: 80ch;
  }

  .items {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .items > li {
    border-top: 1px solid var(--p-line);
  }
  .items summary {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 7px 2px;
    cursor: pointer;
    list-style: none;
    min-height: 42px;
  }
  .items summary::-webkit-details-marker {
    display: none;
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--p-accent-soft);
    color: var(--p-accent);
  }
  .item-copy {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 3px 10px;
    min-width: 0;
  }
  .item-copy strong {
    font-size: 0.84rem;
    font-weight: 650;
  }
  .item-copy small {
    font-size: 0.76rem;
    color: var(--p-muted);
  }
  .item-body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 4px 0 16px 39px;
  }
  .item-visual :global(svg) {
    width: 100%;
    max-width: 250px;
    height: auto;
  }
  .item-body a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--p-accent);
    font-size: 0.74rem;
  }

  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  a.chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 11px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.74rem;
  }
  a.chip .mono {
    color: var(--p-muted);
    font-size: 0.7rem;
  }
  .small {
    margin: 0;
    font-size: 0.76rem;
    color: var(--p-muted);
  }
  .criteria {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.78rem;
  }
  .criteria li {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .criteria span {
    flex: none;
    width: 78px;
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--p-accent);
  }
  .criteria li[data-met='false'] span {
    color: #8b3f3f;
  }

  .pending {
    margin: 8px 0 0;
    padding: 8px 12px;
    border-radius: 10px;
    background: #f6e9e6;
    color: #8b3f3f;
    font-size: 0.78rem;
    line-height: 1.5;
    max-width: 62ch;
  }

  .panel-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px;
  }
  .nav {
    display: flex;
    gap: 7px;
    flex: none;
  }
  .tail {
    grid-column: 1 / -1;
    margin: 14px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--p-line);
    font-size: 0.76rem;
  }
  .tail a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--p-accent);
  }
  button.move {
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
  button.move.primary {
    background: var(--p-accent);
    border-color: var(--p-accent);
    color: white;
  }
  button.move:disabled {
    opacity: 0.32;
  }

  @media (max-width: 820px) {
    .reader {
      grid-template-columns: 1fr;
      gap: 16px;
    }
    .rail {
      flex-direction: row;
      flex-wrap: wrap;
    }
    button.rail-step {
      width: auto;
    }
    .item-body {
      padding-left: 0;
    }
  }
</style>
