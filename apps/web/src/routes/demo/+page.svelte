<script lang="ts">
  import { onMount } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';
  import PortalShell from '$lib/components/PortalShell.svelte';
  import Glyph from '$lib/visuals/Glyph.svelte';
  import { fetchHostedDeployment } from '$lib/application/hosted-deployment';
  import { parseDeploymentConfig } from '$lib/issuance';
  import type { DeploymentConfig } from '$lib/issuance';

  let deployment = $state<DeploymentConfig>();
  let configState = $state<'loading' | 'ready' | 'absent'>('loading');

  const stages = [
    {
      name: 'Signed document',
      body: 'A synthetic PDF carries a 196-byte capsule. The signature covers the capsule bytes.',
      limit: 'A signature proves authorship, not authority to issue.',
      carries: 'signed bytes',
    },
    {
      name: 'SP1 guest',
      body: 'zkPDF verifies the CMS signature inside the zkVM and re-derives the claim in Rust.',
      limit: 'Local execution is not proof acceptance.',
      carries: 'proof + 7 words',
    },
    {
      name: 'Public values',
      body: '224 bytes: profile, request digest, signer fingerprint, source, usage id, commitment, expiry.',
      limit: 'The Gate rejects any other length.',
      carries: 'request digest',
    },
    {
      name: 'Institution',
      body: 'The issuer reserves exact capacity on chain, then signs a short-lived permit for this one request.',
      limit: 'Reserving is not issuing. No token exists yet.',
      carries: 'permit',
    },
    {
      name: 'Issuance Gate',
      body: 'Ten ordered checks. The Gate recomputes the digest in Solidity and is the sole mint authority.',
      limit: 'It is paused until a real proof verifies.',
      carries: 'mint call',
    },
    {
      name: 'ATS token',
      body: 'The adapter mints through Hedera Asset Tokenization Studio in the same reverting transaction.',
      limit: 'An event is not physical backing.',
      carries: '',
    },
  ];

  const capsuleFields = [
    { key: 'magic', at: 0, len: 8, label: 'Magic', note: 'UTSG0001' },
    {
      key: 'source',
      at: 8,
      len: 32,
      label: 'Source id',
      note: 'which institution signed',
    },
    {
      key: 'claim',
      at: 40,
      len: 32,
      label: 'Claim id',
      note: 'random per right; the unlinkable identity',
    },
    {
      key: 'issuer',
      at: 72,
      len: 32,
      label: 'Issuer id',
      note: 'who may authorize the mint',
    },
    {
      key: 'holder',
      at: 104,
      len: 20,
      label: 'Holder address',
      note: 'the only wallet this document can mint to',
    },
    {
      key: 'capacity',
      at: 124,
      len: 32,
      label: 'Capacity',
      note: '1000 milligrams, the complete amount',
    },
    {
      key: 'unit',
      at: 156,
      len: 32,
      label: 'Unit binding',
      note: 'keccak256 of XAU_MILLIGRAM',
    },
    {
      key: 'expiry',
      at: 188,
      len: 8,
      label: 'Valid until',
      note: 'uint64, big endian',
    },
  ];

  const cells = capsuleFields.flatMap((field) =>
    Array.from({ length: field.len }, () => field.key),
  );

  const parity = [
    {
      lang: 'TypeScript',
      where: 'packages/domain',
      runs: 'in the browser and the issuer console',
    },
    {
      lang: 'Rust',
      where: 'proofs/claim-evidence',
      runs: 'inside the SP1 guest',
    },
    {
      lang: 'Solidity',
      where: 'contracts/RequestHash.sol',
      runs: 'inside the Gate',
    },
  ];

  const bound = [
    'chainId',
    'gate',
    'token',
    'recipient',
    'amount',
    'issuerId',
    'reservationId',
    'claimCommitment',
    'claimUsageId',
    'policyVersion',
    'rightsVersion',
    'nonce',
    'validUntil',
  ];

  const amounts = ['0.250', '0.500', '1.000', '1.500'];
  let amountIndex = $state(2);
  const amountExact = $derived(amounts[amountIndex] === '1.000');

  const checks = [
    { name: 'Gate is not paused', revert: 'Paused' },
    { name: 'Request is well formed and unexpired', revert: 'InvalidRequest' },
    { name: 'Digest recomputed in Solidity', revert: '' },
    { name: 'Four replay registers are clear', revert: 'Replay' },
    { name: 'Holder signature, EOA or ERC-1271', revert: 'InvalidSignature' },
    {
      name: 'Issuer permit, fresh nonce, within request expiry',
      revert: 'InvalidPermit',
    },
    {
      name: 'Registered rights and adapter code hash',
      revert: 'InactiveRecord',
    },
    {
      name: 'SP1 proof through the registered verifier',
      revert: 'InvalidEvidence',
    },
    {
      name: 'Reservation matches, amount equals capacity',
      revert: 'ReservationMismatch',
    },
    { name: 'Accounting and mint in one reverting transaction', revert: '' },
  ];

  let run = $state<'idle' | 'ok' | 'replay'>('idle');
  let cursor = $state(-1);
  let runTimer: ReturnType<typeof setInterval> | undefined;

  const failAt = $derived(run === 'replay' ? 3 : -1);

  function checkState(index: number) {
    if (run === 'idle') return 'idle';
    if (failAt >= 0 && index > failAt)
      return cursor >= index ? 'skipped' : 'idle';
    if (failAt === index) return cursor >= index ? 'fail' : 'idle';
    return cursor >= index ? 'pass' : 'idle';
  }

  const verdict = $derived(
    run === 'idle'
      ? 'No run yet. Choose a request above.'
      : cursor < checks.length - 1
        ? 'Running.'
        : run === 'replay'
          ? 'Reverted with Replay. The remaining checks were never reached and no token was minted.'
          : 'All ten checks passed. The mint and the accounting share one transaction.',
  );

  function startRun(kind: 'ok' | 'replay') {
    clearInterval(runTimer);
    run = kind;
    if (prefersReducedMotion.current) {
      cursor = checks.length - 1;
      return;
    }
    cursor = -1;
    runTimer = setInterval(() => {
      if (cursor >= checks.length - 1) {
        clearInterval(runTimer);
        return;
      }
      cursor += 1;
    }, 260);
  }

  const absentRoles = [
    'Agent',
    'Cap',
    'ControlList',
    'TrexOwner',
    'Pauser',
    'AdjustmentBalance',
    'Controller',
    'ProtectedPartitions',
    'Snapshot',
    'CorporateAction',
  ];

  const agents = [
    { id: '116', role: 'Issuer', note: 'the wallet that signs permits' },
    {
      id: '117',
      role: 'Deployment',
      note: 'the operator that registered this authority',
    },
    {
      id: '118',
      role: 'Auditor',
      note: 'owned by the governor key, so not independent',
    },
  ];

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
        'Chain 296. Every address on this page is live and readable by anyone.',
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

  let stage = $state(0);
  let pinned = $state(false);
  let field = $state<string | null>(null);
  let spinTimer: ReturnType<typeof setInterval> | undefined;

  function pinStage(index: number) {
    pinned = true;
    stage = index;
    clearInterval(spinTimer);
  }

  function hashscan(address: string) {
    return `https://hashscan.io/testnet/contract/${address}`;
  }

  function sourcify(address: string) {
    return `https://repo.sourcify.dev/296/${address}`;
  }

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
    if (!prefersReducedMotion.current) {
      spinTimer = setInterval(() => {
        if (pinned) return;
        stage = (stage + 1) % stages.length;
      }, 2400);
    } else {
      stage = stages.length - 1;
    }
    return () => {
      controller.abort();
      clearInterval(spinTimer);
      clearInterval(runTimer);
    };
  });
</script>

<svelte:head>
  <title>How it works — Ultratokenizer</title>
  <meta
    name="description"
    content="A signed document becomes exactly one token: zkPDF inside SP1, one digest in three languages, and an on-chain Gate that mints through Hedera Asset Tokenization Studio."
  />
</svelte:head>

<PortalShell current="demo">
  <section aria-label="Summary">
    <p class="eyebrow">How it works</p>
    <h1>A signed document becomes exactly one token.</h1>
    <p class="intro">
      A synthetic signed PDF carries a 196-byte capsule. zkPDF verifies its
      signature inside an SP1 zkVM, the same request digest is recomputed in
      three languages, and an on-chain Gate mints through Hedera Asset
      Tokenization Studio — or mints nothing at all.
    </p>
    <p class="candour">
      Everything below is deployed on Hedera testnet. The Groth16 proof has not
      come back yet, so no mint and no receipt exist. Each section says so where
      it matters.
    </p>
  </section>

  <section class="block" aria-label="The issuance spine">
    <h2>What is handed between the stages</h2>
    <p class="muted lede">
      Nothing downstream exists until the artifact above it exists. Select a
      stage to hold it.
    </p>
    <div class="spine">
      {#each stages as item, index}
        <div class="spine-slot">
          <button
            class="stage-card"
            type="button"
            data-active={index === stage}
            aria-pressed={index === stage}
            onclick={() => pinStage(index)}
          >
            <span class="step-index">{index + 1}</span>
            <strong>{item.name}</strong>
            <span class="stage-body">{item.body}</span>
            <span class="stage-limit">{item.limit}</span>
          </button>
          {#if item.carries}
            <div class="carry" aria-hidden="true">
              <span class="carry-fill" style="--fill: {index < stage ? 1 : 0}"
              ></span>
              <em>{item.carries}</em>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section class="block" aria-label="What zkPDF proves">
    <h2>zkPDF proves a signature, not an authority</h2>
    <div class="portal-grid">
      <div>
        <p class="muted">
          The public zkPDF <span class="mono">signature-validator</span> checks
          CMS/PKCS#7 with RSA-2048 and SHA-256
          <strong>inside the SP1 guest</strong>. The guest then re-derives the
          claim and commits to it. This is zkPDF: there is no DKIM, no zkEmail
          and no text extraction anywhere in this system.
        </p>
        <p class="muted">
          The capsule sits inside the signed region. Because the holder address
          is one of its fields, a stolen document cannot be redirected to
          another wallet — the circuit rejects a recipient that does not match.
        </p>
        <p class="note-line">
          The source document is synthetic and self-signed. It represents no
          bank, no regulator and no physical gold.
        </p>
      </div>
      <div class="capsule-panel">
        <div class="capsule-grid" aria-hidden="true">
          {#each cells as cell, index}
            <span
              class="cell"
              data-field={cell}
              data-on={field === cell}
              data-first={index === 104}
            ></span>
          {/each}
        </div>
        <ul class="legend">
          {#each capsuleFields as item}
            <li>
              <button
                class="legend-row"
                type="button"
                data-on={field === item.key}
                aria-pressed={field === item.key}
                onmouseenter={() => (field = item.key)}
                onmouseleave={() => (field = null)}
                onfocus={() => (field = item.key)}
                onblur={() => (field = null)}
                onclick={() => (field = field === item.key ? null : item.key)}
              >
                <span class="swatch" data-field={item.key}></span>
                <span class="legend-name">{item.label}</span>
                <span class="legend-range mono"
                  >{item.at}–{item.at + item.len}</span
                >
                <span class="legend-note">{item.note}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  </section>

  <section class="block" aria-label="Cross-language digest">
    <h2>One digest, computed three times</h2>
    <p class="muted lede">
      The EIP-712 request digest binds thirteen fields. Three independent
      implementations produce it, and a parity check runs 64 adversarial cases
      across them. Nobody has to trust a single implementation.
    </p>
    <ul class="chips">
      {#each bound as name}
        <li class="chip mono">{name}</li>
      {/each}
    </ul>
    <div class="parity">
      {#each parity as item}
        <div class="parity-lane">
          <strong>{item.lang}</strong>
          <span class="mono where">{item.where}</span>
          <span class="muted">{item.runs}</span>
          <span class="sweep" aria-hidden="true"></span>
        </div>
      {/each}
    </div>
    <p class="note-line">
      The Gate recomputes the digest itself. A proof that commits to a different
      digest cannot satisfy it.
    </p>
  </section>

  <section class="block" aria-label="Exact quantity rule">
    <h2>A right is not a balance</h2>
    <p class="muted lede">
      Claim profile 2 is all-or-nothing. The request amount must equal the
      complete authenticated capacity of the right.
    </p>
    <div class="amount-row" role="group" aria-label="Try a request amount">
      {#each amounts as value, index}
        <button
          class="amount"
          type="button"
          data-on={index === amountIndex}
          aria-pressed={index === amountIndex}
          onclick={() => (amountIndex = index)}>{value} g</button
        >
      {/each}
    </div>
    <p class="verdict" data-ok={amountExact} role="status">
      {#if amountExact}
        Accepted. The amount equals the full authenticated capacity of this
        1.000 g right.
      {:else}
        Rejected inside the circuit. A 1.000 g right issues exactly 1.000 g or
        nothing at all.
      {/if}
    </p>
    <p class="note-line">
      Once issued, the token divides normally: transfers go down to 0.001 g. The
      restriction is on issuance, not on the asset.
    </p>
  </section>

  <section class="block" aria-label="The Gate decision">
    <h2>Ten ordered checks, one transaction</h2>
    <p class="muted lede">
      The Gate is the only contract that can mint. Run a request and watch where
      it stops.
    </p>
    <div class="actions">
      <button
        class="run-button"
        type="button"
        data-on={run === 'ok'}
        onclick={() => startRun('ok')}>Run an authorized request</button
      >
      <button
        class="run-button"
        type="button"
        data-on={run === 'replay'}
        onclick={() => startRun('replay')}>Run a replayed request</button
      >
    </div>
    <p class="verdict" data-ok={run !== 'replay'} role="status">{verdict}</p>
    <ol class="checks">
      {#each checks as item, index}
        <li class="check" data-state={checkState(index)}>
          <span class="check-mark" aria-hidden="true">
            {#if checkState(index) === 'pass'}<Glyph name="check" size={15} />
            {:else if checkState(index) === 'fail'}<Glyph
                name="close"
                size={15}
              />{/if}
          </span>
          <span class="check-name">{item.name}</span>
          {#if item.revert}
            <span class="check-revert mono">{item.revert}</span>
          {/if}
        </li>
      {/each}
    </ol>
  </section>

  <section class="block" aria-label="Hedera Asset Tokenization Studio">
    <h2>One door into the ATS token</h2>
    <div class="portal-grid">
      <div>
        <p class="muted">
          Nineteen addresses: ten facets, four libraries, the Gate, the profile
          initializer, and the resolver, mint adapter and token that the profile
          constructor created in one transaction. The adapter holds the sole ATS
          <span class="mono">ISSUER</span> role, and the verification routine asserts
          that the other role sets are empty.
        </p>
        <p class="muted">
          The prize lists compliance controls as extra points. This profile
          deliberately proves the opposite: pausers, controllers and control
          lists are unassigned, because the Gate must be the only authority that
          can change supply. That is a choice, not an omission.
        </p>
      </div>
      <div>
        <p class="role-head">
          <span class="role-filled"
            >ISSUER <Glyph name="arrow" size={13} /> mint adapter</span
          >
        </p>
        <ul class="roles">
          {#each absentRoles as name}
            <li class="role-empty mono">{name}</li>
          {/each}
        </ul>
        <p class="note-line">
          Every role above is asserted to have no members.
        </p>
      </div>
    </div>
  </section>

  <section class="block" aria-label="ERC-8004 attribution">
    <h2>ERC-8004 carries attribution, never authority</h2>
    <div class="portal-grid">
      <div>
        <p class="muted">
          Three agents are registered on the Hedera testnet identity registry so
          that a reviewer can resolve an issuer id to a published record without
          asking the operator first.
        </p>
        <dl>
          {#each agents as item}
            <div>
              <dt>{item.role} · agent {item.id}</dt>
              <dd>{item.note}</dd>
            </div>
          {/each}
        </dl>
      </div>
      <div>
        <p class="muted">
          The registry has no concept of a mint. It can hold a pointer and a
          hash — metadata written by an agent owner, or feedback written by a
          counterparty, which the standard forbids an agent from writing about
          itself. Neither is the issuance record. That lives in the Gate event
          and its transaction.
        </p>
        <p class="note-line">
          Our auditor entry shares the governor key, so no independent audit is
          claimed. ERC-8004 is an extra-points item in a different Hedera track,
          not this one. It is here because it is part of the system.
        </p>
      </div>
    </div>
  </section>

  <section class="block" aria-label="Current state">
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

  <section class="block" aria-label="Prize criteria">
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
    </p>
  </section>

  <section class="block" aria-label="Where to look next">
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
  .block {
    margin-top: 64px;
    border-top: 1px solid var(--p-line);
    padding-top: 34px;
  }
  .candour {
    max-width: 680px;
    color: var(--p-ink);
    font-size: 0.86rem;
    background: var(--p-accent-soft);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .lede {
    max-width: 640px;
    margin-bottom: 22px;
  }
  .note-line {
    margin-top: 16px;
    color: var(--p-muted);
    font-size: 0.75rem;
    max-width: 620px;
    line-height: 1.6;
  }

  /* spine */
  .spine {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
  }
  .spine-slot {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  button.stage-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
    width: 100%;
    min-height: 0;
    padding: 18px;
    text-align: left;
    border: 1px solid var(--p-line);
    border-radius: 16px;
    background: var(--p-paper);
    color: var(--p-ink);
    transition:
      border-color 260ms ease,
      background 260ms ease,
      transform 260ms ease;
  }
  button.stage-card[data-active='true'] {
    border-color: var(--p-accent);
    background: var(--p-accent-soft);
    transform: translateY(-3px);
  }
  .step-index {
    font-size: 0.62rem;
    letter-spacing: 0.16em;
    color: var(--p-accent);
    font-weight: 700;
  }
  button.stage-card strong {
    font-size: 0.92rem;
    font-weight: 650;
  }
  .stage-body {
    font-size: 0.78rem;
    color: var(--p-muted);
    line-height: 1.55;
  }
  .stage-limit {
    font-size: 0.71rem;
    color: var(--p-accent);
    line-height: 1.5;
  }
  .carry {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 4px 0;
  }
  .carry-fill {
    flex: 1;
    height: 2px;
    background: var(--p-line);
    border-radius: 2px;
    position: relative;
    overflow: hidden;
  }
  .carry-fill::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--p-accent);
    transform: scaleX(var(--fill));
    transform-origin: left;
    transition: transform 420ms ease;
  }
  .carry em {
    font-style: normal;
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    color: var(--p-muted);
    white-space: nowrap;
  }

  /* capsule */
  .capsule-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }
  .capsule-grid {
    display: grid;
    grid-template-columns: repeat(14, 1fr);
    gap: 3px;
    max-width: 280px;
  }
  .cell {
    aspect-ratio: 1;
    min-width: 0;
    border-radius: 2px;
    background: var(--p-line);
    transition:
      background 200ms ease,
      transform 200ms ease;
  }
  .cell[data-field='magic'] {
    background: #c9c2d4;
  }
  .cell[data-field='source'] {
    background: #b6aac6;
  }
  .cell[data-field='claim'] {
    background: #a99cbd;
  }
  .cell[data-field='issuer'] {
    background: #9c8db3;
  }
  .cell[data-field='holder'] {
    background: var(--p-accent);
  }
  .cell[data-field='capacity'] {
    background: #8f7ea8;
  }
  .cell[data-field='unit'] {
    background: #bdb3ca;
  }
  .cell[data-field='expiry'] {
    background: #d0cad9;
  }
  .cell[data-on='true'] {
    transform: scale(1.18);
  }
  .cell[data-field='holder'] {
    animation: holder-pulse 3s ease-in-out infinite;
  }
  @keyframes holder-pulse {
    50% {
      opacity: 0.5;
    }
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  button.legend-row {
    display: grid;
    grid-template-columns: 12px 104px 62px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 5px 6px;
    text-align: left;
    background: transparent;
    color: var(--p-ink);
    border-radius: 7px;
    font-size: 0.73rem;
  }
  button.legend-row[data-on='true'] {
    background: var(--p-accent-soft);
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--p-line);
  }
  .swatch[data-field='magic'] {
    background: #c9c2d4;
  }
  .swatch[data-field='source'] {
    background: #b6aac6;
  }
  .swatch[data-field='claim'] {
    background: #a99cbd;
  }
  .swatch[data-field='issuer'] {
    background: #9c8db3;
  }
  .swatch[data-field='holder'] {
    background: var(--p-accent);
  }
  .swatch[data-field='capacity'] {
    background: #8f7ea8;
  }
  .swatch[data-field='unit'] {
    background: #bdb3ca;
  }
  .swatch[data-field='expiry'] {
    background: #d0cad9;
  }
  .legend-name {
    font-weight: 600;
  }
  .legend-range {
    color: var(--p-muted);
  }
  .legend-note {
    color: var(--p-muted);
    overflow-wrap: anywhere;
  }

  /* parity */
  .chips {
    list-style: none;
    margin: 0 0 22px;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 4px 9px;
    border-radius: 999px;
    background: var(--p-accent-soft);
    color: var(--p-accent);
    font-size: 0.68rem;
  }
  .parity {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }
  .parity-lane {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--p-line);
    border-radius: 14px;
    background: var(--p-paper);
    font-size: 0.78rem;
  }
  .parity-lane strong {
    font-size: 0.88rem;
  }
  .where {
    color: var(--p-accent);
    overflow-wrap: anywhere;
  }
  .sweep {
    height: 3px;
    border-radius: 2px;
    margin-top: 6px;
    background: linear-gradient(
      90deg,
      var(--p-line) 0%,
      var(--p-accent) 45%,
      var(--p-line) 90%
    );
    background-size: 260% 100%;
    animation: sweep 3.5s linear infinite;
  }
  @keyframes sweep {
    from {
      background-position: 130% 0;
    }
    to {
      background-position: -130% 0;
    }
  }

  /* amounts */
  .amount-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button.amount {
    min-height: 44px;
    padding: 10px 18px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.84rem;
  }
  button.amount[data-on='true'] {
    background: var(--p-accent);
    color: white;
    border-color: var(--p-accent);
  }
  .verdict {
    margin-top: 16px;
    padding: 13px 16px;
    border-radius: 12px;
    font-size: 0.82rem;
    background: #f6e9e6;
    color: #8b3f3f;
    max-width: 620px;
    transition:
      background 220ms ease,
      color 220ms ease;
  }
  .verdict[data-ok='true'] {
    background: var(--p-accent-soft);
    color: var(--p-ink);
  }

  /* gate run */
  button.run-button,
  button.filter {
    min-height: 44px;
    padding: 10px 18px;
    border-radius: 999px;
    border: 1px solid var(--p-line);
    background: var(--p-paper);
    color: var(--p-ink);
    font-size: 0.82rem;
  }
  button.run-button[data-on='true'],
  button.filter[data-on='true'] {
    background: var(--p-accent);
    color: white;
    border-color: var(--p-accent);
  }
  .checks {
    list-style: none;
    margin: 20px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .check {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    border-left: 2px solid var(--p-line);
    background: var(--p-paper);
    font-size: 0.81rem;
    transition:
      border-color 200ms ease,
      background 200ms ease,
      opacity 200ms ease;
  }
  .check[data-state='pass'] {
    border-left-color: var(--p-accent);
  }
  .check[data-state='fail'] {
    border-left-color: #8b3f3f;
    background: #f6e9e6;
  }
  .check[data-state='skipped'] {
    opacity: 0.45;
  }
  .check-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--p-accent);
  }
  .check[data-state='fail'] .check-mark {
    color: #8b3f3f;
  }
  .check-name {
    overflow-wrap: anywhere;
  }
  .check-revert {
    color: var(--p-muted);
    font-size: 0.68rem;
    white-space: nowrap;
  }

  /* ats roles */
  .role-head {
    margin: 0 0 12px;
  }
  .role-filled {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--p-accent);
    color: white;
    font-size: 0.78rem;
    font-weight: 600;
  }
  .roles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .role-empty {
    padding: 6px 10px;
    border: 1px dashed var(--p-line);
    border-radius: 8px;
    color: var(--p-muted);
    font-size: 0.68rem;
    text-decoration: line-through;
  }

  /* addresses */
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

  /* criteria */
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

  @media (max-width: 900px) {
    .spine,
    .parity {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 700px) {
    .block {
      margin-top: 44px;
    }
    .spine,
    .parity {
      grid-template-columns: 1fr;
    }
    button.legend-row {
      grid-template-columns: 12px minmax(0, 1fr);
      align-items: start;
    }
    .legend-range {
      display: none;
    }
    .legend-note {
      grid-column: 2;
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
    button.stage-card,
    .carry-fill::after,
    .cell,
    .check,
    .verdict {
      transition: none;
    }
    .sweep,
    .state-list .pending,
    .cell[data-field='holder'] {
      animation: none;
    }
  }
</style>
