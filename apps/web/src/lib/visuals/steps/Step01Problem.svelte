<script lang="ts">
  // A paper allocation is a promise held by one institution. Everyone else can
  // only reach toward it; the attempt is what fails, so the attempt is drawn.
  const partyX = 268;
  const partyRadius = 7;
  const partyRows = [86, 144, 202];
  const blockedX = 168;
  const allocation = { x: 70, y: 140 };

  const reaches = $derived(
    partyRows.map((y) => {
      const dx = allocation.x - partyX;
      const dy = allocation.y - y;
      const span = Math.hypot(dx, dy);
      const clear = (partyRadius + 3) / span;
      const stop = (blockedX - partyX) / dx;
      return {
        x1: partyX + dx * clear,
        y1: y + dy * clear,
        x2: blockedX,
        y2: y + dy * stop,
      };
    }),
  );

  const reachPath = $derived(
    reaches
      .map(
        (reach) =>
          `M ${reach.x1.toFixed(1)} ${reach.y1.toFixed(1)} L ${reach.x2.toFixed(1)} ${reach.y2.toFixed(1)}`,
      )
      .join(' '),
  );
</script>

<svg
  viewBox="0 0 320 280"
  fill="none"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <!-- The reveal runs on a mask channel so the reach lines keep their dashed
       stroke while they draw on. White and width 7 are mask values, not paint. -->
  <mask
    id="step01-reach-reveal"
    maskUnits="userSpaceOnUse"
    x="0"
    y="0"
    width="320"
    height="280"
  >
    <path
      class="reach-reveal"
      d={reachPath}
      fill="none"
      stroke="white"
      stroke-width="7"
    />
  </mask>

  <!-- The allocation: the one thing this step is about. -->
  <g transform="rotate(-6 70 140)">
    <rect
      x="28"
      y="88"
      width="84"
      height="104"
      rx="8"
      fill="var(--p-accent-soft)"
      stroke="var(--p-accent)"
    />
    <line x1="44" y1="116" x2="96" y2="116" stroke="var(--p-accent)" />
    <line x1="44" y1="134" x2="96" y2="134" stroke="var(--p-accent)" />
    <line x1="44" y1="152" x2="78" y2="152" stroke="var(--p-accent)" />
  </g>
  <text
    x="70"
    y="226"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">PAPER ALLOCATION</text
  >

  <!-- The boundary that holds it. -->
  <g stroke="var(--p-line)">
    <line x1="152" y1="44" x2="152" y2="238" />
    <line x1="160" y1="44" x2="160" y2="238" />
    <line x1="152" y1="72" x2="160" y2="72" />
    <line x1="152" y1="104" x2="160" y2="104" />
    <line x1="152" y1="136" x2="160" y2="136" />
    <line x1="152" y1="168" x2="160" y2="168" />
    <line x1="152" y1="200" x2="160" y2="200" />
  </g>
  <text
    x="156"
    y="256"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">ONE INSTITUTION</text
  >

  <!-- Everyone else. -->
  {#each partyRows as row (row)}
    <circle cx={partyX} cy={row} r={partyRadius} stroke="var(--p-line)" />
  {/each}
  <text
    x={partyX}
    y="226"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">OTHERS</text
  >

  <g mask="url(#step01-reach-reveal)">
    <path d={reachPath} stroke="var(--p-muted)" stroke-dasharray="4 3" />
  </g>
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  /* Pattern 1: draw-on, once, resting state is the completed state. */
  .reach-reveal {
    stroke-dasharray: 110;
    stroke-dashoffset: 0;
    animation: reach-draw 700ms ease-out 1;
  }
  @keyframes reach-draw {
    from {
      stroke-dashoffset: 110;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reach-reveal {
      animation: none;
    }
  }
</style>
