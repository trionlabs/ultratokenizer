<script lang="ts">
  import { onMount } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';

  // Ten checks in a fixed order. The mint on rung ten is only ever reached
  // by passing every rung above it, so the order is the security property.
  const checks = [
    'NOT PAUSED',
    'REQUEST FORM',
    'DIGEST',
    'REPLAY x4',
    'HOLDER SIG',
    'ISSUER PERMIT',
    'RIGHTS',
    'SP1 PROOF',
    'RESERVATION',
    'MINT',
  ];
  const firstRung = 24;
  const rungGap = 24;
  const rungY = (index: number) => firstRung + index * rungGap;
  // Pause for three beats on the completed ladder before restarting.
  const cycleEnd = checks.length + 3;

  // At rest the ladder is complete: every rung has been passed.
  let cursor = $state(checks.length);
  let markerShift = $derived(
    (Math.min(Math.max(cursor, 1), checks.length) - 1) * rungGap,
  );

  onMount(() => {
    if (prefersReducedMotion.current) {
      return () => {};
    }
    cursor = 0;
    const timer = setInterval(() => {
      cursor = cursor >= cycleEnd ? 0 : cursor + 1;
    }, 300);
    return () => clearInterval(timer);
  });
</script>

<svg
  viewBox="0 0 320 280"
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke="var(--p-line)"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <!-- The spine is the single accent: one ordered traversal, top to bottom. -->
  <line class="spine" x1="30" y1={rungY(0)} x2="30" y2={rungY(9)} />

  {#each checks as check, index (check)}
    <g class="rung" data-passed={cursor > index}>
      <text
        x="21"
        y={rungY(index) + 3}
        text-anchor="end"
        font-size="9"
        font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
        fill="var(--p-muted)"
        stroke="none">{index + 1}</text
      >
      <line x1="30" y1={rungY(index)} x2="46" y2={rungY(index)} />
      <text
        x="52"
        y={rungY(index) + 3}
        font-size="9"
        letter-spacing="0.08em"
        fill="var(--p-muted)"
        stroke="none">{check}</text
      >
    </g>
  {/each}

  <!-- Rung ten terminates in the token. Nothing else reaches it. -->
  <g class="arrival" data-passed={cursor >= checks.length}>
    <line x1="90" y1={rungY(9)} x2="236" y2={rungY(9)} />
    <circle cx="254" cy={rungY(9)} r="14" />
    <circle cx="254" cy={rungY(9)} r="6" />
    <text
      x="254"
      y="264"
      text-anchor="middle"
      font-size="9"
      letter-spacing="0.08em"
      fill="var(--p-muted)"
      stroke="none">TOKEN</text
    >
  </g>

  <circle
    class="marker"
    cx="30"
    cy={rungY(0)}
    r="3.5"
    data-live={cursor > 0}
    style={`--shift: ${markerShift}px`}
  />
</svg>

<style>
  svg {
    width: 100%;
    max-width: 340px;
    height: auto;
    display: block;
  }
  .spine {
    stroke: var(--p-accent);
  }
  .rung,
  .arrival {
    opacity: 0.35;
    transition: opacity 260ms ease;
  }
  .rung[data-passed='true'],
  .arrival[data-passed='true'] {
    opacity: 1;
  }
  .marker {
    fill: var(--p-accent);
    stroke: none;
    opacity: 0;
    transform: translateY(var(--shift));
    transition:
      transform 260ms ease,
      opacity 260ms ease;
  }
  .marker[data-live='true'] {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .rung,
    .arrival,
    .marker {
      transition: none;
    }
  }
</style>
