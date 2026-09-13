<script lang="ts">
  import { prefersReducedMotion } from 'svelte/motion';

  // The whole mechanism in one picture, for a reviewer who has ninety seconds.
  // It teaches four things the judge page previously only asserted in prose:
  // the signature is already in the file, the file never leaves the guest,
  // one contract decides, and nothing has been minted. The last stage is drawn
  // dashed and empty on purpose: the honest state is part of the diagram, not a
  // footnote under it.
  //
  // Depth belongs on /demo/, which walks the same four stages one at a time.
  // This is the overview that sends them there.

  // The ordered guard count in IssuanceGate.issue() before the mint. Pinned to
  // the contract by test/demo-claims.test.mjs, and drawn one rung per check so
  // the number can be counted rather than taken on trust.
  const CHECKS = 11;
  const rungs = Array.from({ length: CHECKS }, (_, i) => 84 + i * 10.8);

  const stages = [
    {
      id: 'document',
      title: 'Signed document',
      line: 'The institution already signed the PDF. We add no new standard.',
    },
    {
      id: 'proof',
      title: 'zkPDF inside SP1',
      line: 'The signature is checked in a zero-knowledge VM. 224 bytes come out, not the file.',
    },
    {
      id: 'gate',
      title: 'The Gate',
      line: `${CHECKS} ordered checks in one transaction. One failure reverts everything.`,
    },
    {
      id: 'token',
      title: 'Token',
      line: 'Not minted. The Groth16 proof has not returned, and the Gate needs it.',
    },
  ];

  const still = $derived(prefersReducedMotion.current);
</script>

<figure class="overview" class:still>
  <svg
    class="diagram"
    viewBox="0 0 900 258"
    fill="none"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <!-- 1 · the document, with the seal that is already in it -->
    <g>
      <rect
        x="34"
        y="52"
        width="104"
        height="126"
        rx="10"
        fill="var(--p-paper)"
        stroke="var(--p-line)"
      />
      <path d="M56 84h60M56 102h60M56 120h38" stroke="var(--p-line)" />
      <circle
        cx="116"
        cy="146"
        r="15"
        fill="var(--p-accent-soft)"
        stroke="var(--p-accent)"
      />
      <path d="M109 146l5 5 9-10" stroke="var(--p-accent)" stroke-width="2" />
      <text x="86" y="212" class="cap">SIGNED PDF</text>
      <text x="86" y="228" class="sub">RSA-2048, in the file</text>
    </g>

    <path d="M152 115h74" stroke="var(--p-line)" />
    <path d="M220 109l8 6-8 6" stroke="var(--p-line)" />

    <!-- 2 · the guest. Nothing leaves it but the public values. -->
    <g>
      <rect
        x="242"
        y="52"
        width="150"
        height="126"
        rx="12"
        fill="var(--p-paper)"
        stroke="var(--p-accent)"
      />
      <text x="317" y="98" class="mid">SP1 GUEST</text>
      <text x="317" y="119" class="midsub">zkPDF</text>
      <rect
        x="272"
        y="132"
        width="90"
        height="26"
        rx="8"
        fill="var(--p-accent-soft)"
        stroke="var(--p-accent)"
      />
      <text x="317" y="149" class="chip">224 B</text>
      <text x="317" y="212" class="cap">PROVED, NOT SHOWN</text>
      <text x="317" y="228" class="sub">seven public values</text>
    </g>

    <path d="M406 115h74" stroke="var(--p-line)" />
    <path d="M474 109l8 6-8 6" stroke="var(--p-line)" />

    <!-- 3 · one contract decides. One rung per ordered check. -->
    <g>
      <rect
        x="496"
        y="48"
        width="158"
        height="150"
        rx="12"
        fill="var(--p-paper)"
        stroke="var(--p-accent)"
      />
      <text x="575" y="68" class="mid">THE GATE</text>
      {#each rungs as y, index (y)}
        <path
          class="rung"
          style="--r: {index}"
          d="M524 {y}h102"
          stroke="var(--p-accent)"
        />
      {/each}
      <text x="575" y="212" class="cap">{CHECKS} ORDERED CHECKS</text>
      <text x="575" y="228" class="sub">one transaction, or none</text>
    </g>

    <path d="M668 115h44" stroke="var(--p-line)" />
    <path d="M706 109l8 6-8 6" stroke="var(--p-line)" />

    <!-- 4 · dashed and empty: nothing has been minted, and the picture says so -->
    <g>
      <circle
        cx="790"
        cy="115"
        r="52"
        stroke="var(--p-line)"
        stroke-dasharray="5 5"
      />
      <text x="790" y="110" class="mid">1.000 g</text>
      <text x="790" y="130" class="midsub">not minted</text>
      <text x="790" y="212" class="cap">AWAITING THE PROOF</text>
      <text x="790" y="228" class="sub">totalSupply 0</text>
    </g>

    <!-- ERC-8004 sits above the Gate, dashed, and touches it with nothing. It
         names who; it is joined to the decision by no line at all. -->
    <g>
      <rect
        x="470"
        y="2"
        width="210"
        height="30"
        rx="9"
        stroke="var(--p-line)"
        stroke-dasharray="4 4"
      />
      <text x="575" y="21" class="cap">ERC-8004 · NAMES THE ISSUER</text>
    </g>
  </svg>

  <!-- The same four stages as text: the diagram is decoration to a screen
       reader, and below 720px it is replaced by this outright. -->
  <ol class="stages">
    {#each stages as stage, index (stage.id)}
      <li>
        <span>{index + 1}</span>
        <div>
          <strong>{stage.title}</strong>
          <small>{stage.line}</small>
        </div>
      </li>
    {/each}
  </ol>

  <figcaption>
    <a href="/demo/">Walk the four stages one at a time &rarr;</a>
  </figcaption>
</figure>

<style>
  .overview {
    margin: 0;
  }
  .diagram {
    display: block;
    width: 100%;
    height: auto;
  }
  .cap {
    font-size: 10px;
    letter-spacing: 0.11em;
    text-anchor: middle;
    fill: var(--p-ink);
    font-weight: 600;
  }
  .sub {
    font-size: 10px;
    letter-spacing: 0.04em;
    text-anchor: middle;
    fill: var(--p-muted);
  }
  .mid {
    font-size: 13px;
    letter-spacing: 0.06em;
    text-anchor: middle;
    fill: var(--p-ink);
    font-weight: 600;
  }
  .midsub {
    font-size: 11px;
    text-anchor: middle;
    fill: var(--p-muted);
  }
  .chip {
    font-size: 12px;
    letter-spacing: 0.04em;
    text-anchor: middle;
    fill: var(--p-accent);
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  /* The diagram settles as one piece, so its resting state is the first frame
     anyone sees. */
  .diagram {
    animation: rise 460ms ease-out;
  }
  .rung {
    animation: rung 240ms ease-out backwards;
    animation-delay: calc(300ms + var(--r) * 58ms);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(7px);
    }
  }
  @keyframes rung {
    from {
      opacity: 0;
      transform: translateX(-9px);
    }
  }

  .stages {
    display: none;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .stages li {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 12px;
    padding: 13px 0;
    border-top: 1px solid var(--p-line);
  }
  .stages li > span {
    color: var(--p-accent);
    font-size: 0.7rem;
    font-weight: 700;
    padding-top: 2px;
  }
  .stages strong {
    display: block;
    font-size: 0.88rem;
  }
  .stages small {
    display: block;
    margin-top: 3px;
    color: var(--p-muted);
    font-size: 0.78rem;
    line-height: 1.45;
  }

  figcaption {
    margin-top: 14px;
  }
  figcaption a {
    color: var(--p-accent);
    font-size: 0.78rem;
    font-weight: 600;
    text-decoration: none;
  }
  figcaption a:hover {
    text-decoration: underline;
  }

  /* A four-across diagram stops being readable long before a phone. Below this
     the list carries the same four stages, in the same order. */
  @media (max-width: 720px) {
    .diagram {
      display: none;
    }
    .stages {
      display: block;
    }
  }

  .overview.still .diagram,
  .overview.still :global(.rung) {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .diagram,
    .rung {
      animation: none;
    }
  }
</style>
