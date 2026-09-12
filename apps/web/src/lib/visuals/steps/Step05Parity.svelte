<script lang="ts">
  // Parity: one canonical request, three independently written implementations,
  // one identical digest. The three lanes share a single animation name,
  // duration and zero delay, so the sweep is genuinely in lockstep. Staggering
  // them would say the opposite of what the step claims.
  const mono = 'ui-monospace, SFMono-Regular, Consolas, monospace';
  const digest = '0xc591af7e';
  const railStart = 84;
  const railEnd = 200;
  const pillX = 202;
  const pillWidth = 68;

  let lanes = $state([
    { name: 'TYPESCRIPT', where: 'in the browser', y: 70 },
    { name: 'RUST', where: 'in the proof', y: 140 },
    { name: 'SOLIDITY', where: 'in the contract', y: 210 },
  ]);

  let bracketTop = $derived(Math.min(...lanes.map((lane) => lane.y)) - 11);
  let bracketFoot = $derived(Math.max(...lanes.map((lane) => lane.y)) + 11);
  let bracketMid = $derived((bracketTop + bracketFoot) / 2);
</script>

<svg
  viewBox="0 0 320 280"
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <text
    x="10"
    y="26"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">ONE CANONICAL REQUEST</text
  >

  {#each lanes as lane (lane.name)}
    <text
      x="10"
      y={lane.y - 2}
      font-size="9"
      fill="var(--p-muted)"
      letter-spacing="0.08em">{lane.name}</text
    >
    <text
      x="10"
      y={lane.y + 10}
      font-size="9"
      fill="var(--p-muted)"
      opacity="0.7">{lane.where}</text
    >

    <line
      x1={railStart}
      y1={lane.y - 4}
      x2={railStart}
      y2={lane.y + 4}
      stroke="var(--p-line)"
    />
    <line
      x1={railStart}
      y1={lane.y}
      x2={railEnd}
      y2={lane.y}
      stroke="var(--p-line)"
    />
    <line
      class="lane-sweep"
      x1={railStart}
      y1={lane.y}
      x2={railEnd}
      y2={lane.y}
    />

    <rect
      x={pillX}
      y={lane.y - 11}
      width={pillWidth}
      height="22"
      rx="10"
      stroke="var(--p-line)"
    />
    <text
      x={pillX + pillWidth / 2}
      y={lane.y + 3}
      text-anchor="middle"
      font-size="9"
      fill="var(--p-muted)"
      font-family={mono}>{digest}</text
    >
  {/each}

  <path
    d={`M270 ${bracketTop}H278V${bracketFoot}H270`}
    stroke="var(--p-accent)"
  />
  <line
    x1="278"
    y1={bracketMid}
    x2="284"
    y2={bracketMid}
    stroke="var(--p-accent)"
  />
  <text
    x="293"
    y={bracketMid}
    transform={`rotate(-90 293 ${bracketMid})`}
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">64 CASES IN CI</text
  >

  <text
    x="10"
    y="262"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">NO SINGLE IMPLEMENTATION IS TRUSTED</text
  >
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  /* Pattern 2: one short lit segment travels each rail. Same name, same
     duration, no delay on any lane, so all three move as one. Rail length is
     116 user units (84 to 200); the gap exceeds it so only one dash is ever
     on the rail. */
  .lane-sweep {
    stroke: var(--p-accent);
    stroke-dasharray: 22 150;
    animation: parity-sweep 3500ms linear infinite;
  }
  @keyframes parity-sweep {
    from {
      stroke-dashoffset: 22;
    }
    to {
      stroke-dashoffset: -116;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* The rails and pills are already complete without the sweep, and hiding
       it keeps the bracket the only accent element at rest. */
    .lane-sweep {
      animation: none;
      opacity: 0;
    }
  }
</style>
