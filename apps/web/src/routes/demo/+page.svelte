<script lang="ts">
  import PortalShell from '$lib/components/PortalShell.svelte';

  const roles = [
    {
      name: 'Holder',
      title: 'Turn your allocation into tokens.',
      description:
        'A person or organization receiving the exact approved gold quantity.',
      steps: [
        [
          'Connect',
          'Use the recipient wallet on Hedera testnet. The site supplies the network settings.',
        ],
        [
          'Review & sign',
          'Import the prepared issuance package, verify the proof and sign the request.',
        ],
        [
          'Mint & transfer',
          'Confirm the mint transaction, save its receipt, then transfer any whole-milligram amount.',
        ],
      ],
      material:
        'A funded EVM wallet and a verified proof package with a fresh issuer permit.',
      action: 'Open token engine',
      href: '/',
    },
    {
      name: 'Institution',
      title: 'Attest the right. Authorize issuance.',
      description:
        'The document source authenticates the allocation; the issuer authorizes its mint.',
      steps: [
        [
          'Record & seal',
          'The institution tooling records an exclusive right and seals its synthetic PDF. Source signing runs outside the browser.',
        ],
        [
          'Prove & reserve',
          'SP1 proves the document rules for the exact request. The issuer console checks the proof and reconciles the reservation.',
        ],
        [
          'Authorize',
          'The registered issuer wallet signs a short-lived permit. Send the public issuance package to the holder.',
        ],
      ],
      material:
        'A public proof export and registered issuer wallet for this console. The institution maintains the source signing key and right ledger outside the browser.',
      action: 'Open institution console',
      href: '/institution/',
    },
    {
      name: 'Auditor',
      title: 'Inspect the evidence behind the token.',
      description:
        'Anyone can examine a receipt. Publishing an audit identity is optional.',
      steps: [
        [
          'Establish trust',
          'Obtain the trusted Gate and program pins independently. Inspect current contract and ERC-8004 records.',
        ],
        [
          'Check the receipt',
          'Import the saved receipt and trust policy. Local checks cover signatures and bindings; proof verification is an explicit RPC check.',
        ],
        [
          'Export findings',
          'Save the report with its passed, failed and unverified checks. Historical authority and inclusion remain unverified.',
        ],
      ],
      material:
        'An actual mint receipt and independently obtained audit policy. No wallet or test HBAR is needed to inspect them.',
      action: 'Open receipt verifier',
      href: '/verify/',
    },
  ];
  let selected = $state(0);
  const role = $derived(roles[selected]);
</script>

<svelte:head>
  <title>Three roles, one token engine — Ultratokenizer</title>
  <meta
    name="description"
    content="Explore the holder, institution and auditor journeys for exact-quantity, proof-backed tokenization on Hedera."
  />
</svelte:head>

<PortalShell current="demo">
  <p class="eyebrow">Inside the token engine</p>
  <h1>One asset. Three perspectives.</h1>
  <p class="intro">
    A signed allocation becomes a transferable token through proof verification,
    issuer authorization and holder consent.
  </p>

  <section class="journey" aria-label="Illustrated issuance flow">
    <div class="object paper" aria-hidden="true">
      <span>u.</span><i></i><i></i><i></i>
    </div>
    <div class="connection" aria-hidden="true"><span></span></div>
    <div class="object proof" aria-hidden="true">✓</div>
    <div class="connection" aria-hidden="true"><span></span></div>
    <div class="object coin" aria-hidden="true">Au</div>
    <div class="caption">
      <b>Signed allocation</b><small>Document source</small>
    </div>
    <div class="caption">
      <b>Bound proof + approvals</b><small>SP1 · issuer · holder</small>
    </div>
    <div class="caption">
      <b>Token + receipt</b><small>Gate → Hedera ATS</small>
    </div>
  </section>
  <p class="diagram-note">
    Flow illustration · completed transactions appear in the token engine.
  </p>

  <div class="role-picker" role="group" aria-label="Explore a role">
    {#each roles as item, index}
      <button
        class:secondary={selected !== index}
        aria-pressed={selected === index}
        onclick={() => (selected = index)}
      >
        <span>0{index + 1}</span>{item.name}
      </button>
    {/each}
  </div>
  <section class="role-panel" aria-live="polite" aria-atomic="true">
    <div>
      <h2>{role.title}</h2>
      <p class="muted">{role.description}</p>
      <ol>
        {#each role.steps as [title, text]}
          <li>
            <h3>{title}</h3>
            <p class="muted">{text}</p>
          </li>
        {/each}
      </ol>
    </div>
    <aside class="materials">
      <p class="eyebrow">Bring to this step</p>
      <p>{role.material}</p>
      <a class="portal-button" href={role.href}>{role.action} →</a>
    </aside>
  </section>

  <section class="boundaries" aria-label="Demo scope">
    <div>
      <h2>Exact means exact.</h2>
      <p class="muted">
        An approved 1.000 g allocation permits one 1.000 g mint. After issuance,
        transfers can divide it into 0.001 g units.
      </p>
    </div>
    <div>
      <h2>Attribution, then authority.</h2>
      <p class="muted">
        ERC-8004 identifies published services. The Gate authorizes issuance.
        The demo authority is an operator, not a regulator.
      </p>
    </div>
    <div>
      <h2>A test of the engine.</h2>
      <p class="muted">
        This demo uses a sealed synthetic PDF and Hedera testnet. It does not
        represent Enpara approval, physical backing or redemption. The browser
        imports a proof package, not an email or PDF.
      </p>
    </div>
  </section>
  <div class="actions">
    <a class="portal-button secondary" href="/trust/"
      >Inspect contracts & service records →</a
    >
  </div>
</PortalShell>

<style>
  .journey {
    display: grid;
    grid-template-columns: 1fr 0.5fr 1fr 0.5fr 1fr;
    align-items: center;
    justify-items: center;
    gap: 22px 0;
    padding: 28px 0 18px;
  }
  .object {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96px;
    height: 112px;
    color: var(--p-accent);
    border: 1px solid var(--p-line);
    background: var(--p-paper);
  }
  .paper {
    flex-direction: column;
    align-items: start;
    gap: 10px;
    padding: 18px;
    border-radius: 8px;
    transform: rotate(-6deg);
  }
  .paper span {
    font-size: 1.3rem;
    font-weight: 650;
  }
  .paper i {
    width: 100%;
    height: 1px;
    background: var(--p-line);
  }
  .paper i:last-child {
    width: 65%;
  }
  .proof {
    width: 80px;
    height: 80px;
    border-radius: 24px;
    background: var(--p-accent-soft);
    font-size: 1.8rem;
  }
  .coin {
    width: 106px;
    height: 106px;
    border-radius: 50%;
    outline: 1px solid var(--p-line);
    outline-offset: -8px;
    font-family: Georgia, serif;
    font-size: 2rem;
  }
  .connection {
    width: 100%;
    height: 1px;
    background: var(--p-line);
    overflow: hidden;
  }
  .connection span {
    display: block;
    width: 30%;
    height: 1px;
    background: var(--p-accent);
    animation: travel 4s ease-in-out infinite;
  }
  .caption {
    text-align: center;
    grid-row: 2;
  }
  .caption:nth-last-child(3) {
    grid-column: 1;
  }
  .caption:nth-last-child(2) {
    grid-column: 3;
  }
  .caption:last-child {
    grid-column: 5;
  }
  .caption b {
    font-size: 0.85rem;
    font-weight: 550;
  }
  .caption small {
    display: block;
    color: var(--p-muted);
    font-size: 0.73rem;
    margin-top: 6px;
  }
  .diagram-note {
    text-align: center;
    color: var(--p-muted);
    font-size: 0.72rem;
    margin-bottom: 36px;
  }
  .role-picker {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .role-picker button {
    gap: 12px;
  }
  .role-picker span {
    opacity: 0.7;
    font-size: 0.73rem;
  }
  .role-panel {
    display: grid;
    grid-template-columns: 1.65fr 1fr;
    gap: 48px;
    border-block: 1px solid var(--p-line);
    padding: 30px 0;
  }
  ol {
    padding-left: 22px;
    margin: 24px 0 0;
  }
  li {
    padding-left: 10px;
    margin-top: 20px;
  }
  li::marker {
    color: var(--p-accent);
    font-size: 0.8rem;
  }
  li h3 {
    margin-bottom: 4px;
  }
  .materials {
    padding: 22px;
    align-self: start;
    border-radius: 16px;
    background: var(--p-accent-soft);
  }
  .materials > p:not(.eyebrow) {
    font-size: 0.84rem;
    margin: 12px 0 20px;
  }
  .boundaries {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 28px;
    margin-top: 32px;
  }
  @keyframes travel {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .connection span {
      animation: none;
    }
  }
  @media (max-width: 700px) {
    .role-panel,
    .boundaries {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .journey {
      grid-template-columns: 1fr 0.15fr 1fr 0.15fr 1fr;
    }
    .object {
      transform: none;
      scale: 0.85;
    }
    .caption b {
      font-size: 0.75rem;
    }
    .caption small {
      font-size: 0.67rem;
    }
  }
</style>
