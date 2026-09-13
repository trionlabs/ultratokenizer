<script lang="ts">
  import { onMount } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';

  // One stage for the whole engine. Nothing is ever removed: each step lights
  // the next part and everything already lit stays lit, so the picture the
  // reader ends with is the picture they have been building all along.
  let { step = 0 }: { step?: number } = $props();

  const on = (from: number) => (step >= from ? 'on' : 'off');

  // The Gate ladder only runs while the Gate itself is the subject.
  let rung = $state(10);
  let timer: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    clearInterval(timer);
    if (step !== 2 || prefersReducedMotion.current) {
      rung = step < 2 ? 0 : 10;
      return;
    }
    rung = 0;
    timer = setInterval(() => {
      rung = rung >= 10 ? 10 : rung + 1;
      if (rung >= 10) clearInterval(timer);
    }, 130);
  });

  onMount(() => () => clearInterval(timer));

  const rungs = Array.from({ length: 10 }, (_, index) => 72 + index * 17);
</script>

<svg
  class="stage"
  viewBox="0 0 960 290"
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <!-- lane 1: the holder -->
  <g class="part" data-state={on(0)}>
    <path
      class="ink"
      d="M44 168h58l18 18v62a5 5 0 0 1-5 5H44a5 5 0 0 1-5-5v-75a5 5 0 0 1 5-5Z"
      transform="rotate(-6 84 218)"
    />
    <path class="ink" d="M102 168v18h18" transform="rotate(-6 84 218)" />
    <g transform="rotate(-6 84 218)">
      {#each Array.from({ length: 14 }, (_, i) => i) as cell}
        <rect
          class="byte"
          data-hot={cell >= 7 && cell < 9}
          x={50 + cell * 5.6}
          y={232}
          width="4.2"
          height="9"
          rx="1"
        />
      {/each}
    </g>
    <text class="micro" x="39" y="278">SIGNED DOCUMENT</text>
  </g>

  <path class="link" pathLength="1" data-state={on(0)} d="M152 214h30" />

  <g class="part" data-state={on(0)}>
    <path class="accent hollow" d="M238 168l40 23v46l-40 23-40-23v-46Z" />
    <rect class="accent" x="210" y="203" width="56" height="22" rx="6" />
    <text class="mono mid light" x="238" y="218">zkPDF</text>
    <text class="micro mid" x="238" y="192">SP1 GUEST</text>
    <text class="micro mid" x="238" y="278">RUNS INSIDE A zkVM</text>
  </g>

  <path class="link" pathLength="1" data-state={on(0)} d="M294 214h28" />

  <g class="part" data-state={on(0)}>
    <rect class="accent soft" x="326" y="198" width="86" height="32" rx="16" />
    <text class="mono mid" x="369" y="218">224 B</text>
    <text class="micro mid" x="369" y="278">PROOF</text>
  </g>

  <!-- lane 2: the institution -->
  <g class="part" data-state={on(1)}>
    <rect class="ink" x="132" y="46" width="196" height="30" rx="6" />
    <rect class="fill" x="132" y="46" width="196" height="30" rx="6" />
    <text class="mono mid light" x="230" y="66">RESERVED 1000 mg</text>
    <text class="micro" x="132" y="34">BACKING POOL · ISSUED 0</text>
  </g>

  <path class="link" pathLength="1" data-state={on(1)} d="M336 61h24" />

  <g class="part" data-state={on(1)}>
    <rect class="accent" x="366" y="42" width="40" height="38" rx="12" />
    <circle class="light-fill" cx="386" cy="56" r="4" />
    <path class="light-fill" d="M386 61l-3.4 10h6.8Z" />
    <text class="micro mid" x="386" y="98">PERMIT</text>
  </g>

  <!-- both lanes converge on the Gate -->
  <path
    class="link"
    pathLength="1"
    data-state={on(2)}
    d="M414 61c58 0 44 62 96 76"
  />
  <path
    class="link"
    pathLength="1"
    data-state={on(2)}
    d="M418 214c56 0 40-62 92-76"
  />

  <g class="part" data-state={on(2)}>
    <rect class="ink" x="524" y="40" width="196" height="210" rx="14" />
    <path class="rail" pathLength="1" d="M548 72v153" style="--p:{rung / 10}" />
    {#each rungs as y, index}
      <g class="rung" data-lit={index < rung}>
        <path class="hair" d={`M548 ${y}h18`} />
        <circle class="dot" cx="548" cy={y} r="4" />
      </g>
    {/each}
    <text class="micro" x="576" y="76">ISSUANCE IS OPEN</text>
    <text class="micro" x="576" y="127">NOT USED BEFORE · YOU SIGNED</text>
    <text class="micro" x="576" y="178">BANK ALLOWED IT · PROOF HOLDS</text>
    <text class="micro" x="576" y="229">AMOUNT MATCHES · THEN MINT</text>
    <text class="micro" x="524" y="28">TEN CHECKS, ONE TRANSACTION</text>
  </g>

  <path class="link" pathLength="1" data-state={on(2)} d="M726 145h30" />

  <g class="part" data-state={on(2)}>
    <circle class="iris unminted" cx="806" cy="145" r="34" />
    <circle class="iris thin" cx="806" cy="145" r="25" />
    <text class="mono mid" x="806" y="150">1.000 g</text>
    <text class="micro mid" x="806" y="204">NOT MINTED YET</text>
  </g>

  <!-- step four: the evidence around the finished picture -->
  <g class="part evidence" data-state={on(3)}>
    <rect class="soft-box" x="744" y="20" width="196" height="26" rx="8" />
    <text class="micro" x="756" y="37">20/20 RUNTIME · 17/20 CREATION</text>
    <rect class="soft-box" x="744" y="52" width="196" height="26" rx="8" />
    <text class="micro" x="756" y="69">ERC-8004 · 3 RECORDS</text>
    <rect class="soft-box" x="744" y="84" width="196" height="26" rx="8" />
    <text class="micro" x="756" y="101">20 CONTRACTS DEPLOYED</text>
  </g>
</svg>

<style>
  .stage {
    display: block;
    width: 100%;
    max-width: min(960px, 96vh);
    height: auto;
    margin-inline: auto;
  }

  /* A part is either the subject already reached, or waiting its turn. */
  .part {
    transition:
      opacity 420ms ease,
      transform 420ms ease;
  }
  .part[data-state='off'] {
    opacity: 0.4;
  }
  .part[data-state='on'] {
    opacity: 1;
  }

  .ink {
    stroke: var(--p-ink);
    fill: var(--p-paper);
  }
  .accent {
    stroke: var(--p-accent);
    fill: var(--p-accent);
  }
  .accent.soft {
    fill: var(--p-accent-soft);
  }
  .accent.hollow {
    fill: var(--p-accent-soft);
  }
  .iris {
    stroke: var(--p-iris);
  }
  .iris.unminted {
    stroke-dasharray: 5 4;
  }
  .iris.thin {
    stroke: var(--p-line);
    stroke-dasharray: 2 3;
  }
  .hair {
    stroke: var(--p-line);
  }
  .light-fill {
    fill: var(--p-paper);
    stroke: none;
  }
  .soft-box {
    fill: var(--p-accent-soft);
    stroke: none;
  }

  .byte {
    fill: var(--p-line);
    stroke: none;
    transition: fill 420ms ease;
  }
  .byte[data-hot='true'] {
    fill: var(--p-accent);
  }

  .link {
    stroke: var(--p-line);
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
    transition:
      stroke 420ms ease,
      stroke-dashoffset 520ms ease;
  }
  .link[data-state='on'] {
    stroke: var(--p-accent);
  }
  .link[data-state='off'] {
    stroke-dashoffset: 1;
  }

  /* the Gate progress rail grows with the cursor */
  .rail {
    stroke: var(--p-accent);
    stroke-width: 2;
    stroke-dasharray: 1;
    stroke-dashoffset: calc(1 - var(--p));
    transition: stroke-dashoffset 160ms linear;
  }
  .rung .dot {
    fill: var(--p-line);
    stroke: none;
    transition: fill 220ms ease;
  }
  .rung[data-lit='true'] .dot {
    fill: var(--p-accent);
  }

  .fill {
    fill: var(--p-accent);
    stroke: none;
  }

  text {
    stroke: none;
  }
  .micro {
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.09em;
    fill: var(--p-muted);
  }
  .mono {
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    fill: var(--p-ink);
  }
  .mono.light {
    fill: var(--p-paper);
  }
  .mid {
    text-anchor: middle;
  }

  @media (prefers-reduced-motion: reduce) {
    .part,
    .byte,
    .link,
    .rail,
    .rung .dot {
      transition: none;
    }
  }
</style>
