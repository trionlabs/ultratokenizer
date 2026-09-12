<script lang="ts">
  // Reservation: the institution sets the exact amount aside on chain before
  // anything is minted. Reserved fills the cap entirely, issued is still zero,
  // and the permit that would authorize a mint is signed later, so it is drawn
  // with the "not reached" treatment. Setting aside is not issuing.
  const mono = 'ui-monospace, SFMono-Regular, Consolas, monospace';
  const pool = { x: 20, y: 74, width: 170, height: 64 };
  const inset = 3;

  let cap = $state(1000);
  let reserved = $state(1000);
  let issued = $state(0);

  let poolRight = $derived(pool.x + pool.width);
  let poolMid = $derived(pool.x + pool.width / 2);
  let innerWidth = $derived(pool.width - inset * 2);
  let reservedWidth = $derived((reserved / cap) * innerWidth);
  let reservedRight = $derived(pool.x + inset + reservedWidth);
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
    x="20"
    y="28"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">BACKING POOL</text
  >

  <!-- The cap is the whole pool: a dimension over the full outline. -->
  <text
    x={poolMid}
    y="50"
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">CAP <tspan font-family={mono}>{cap}</tspan></text
  >
  <line x1={pool.x} y1="60" x2={poolRight} y2="60" stroke="var(--p-line)" />
  <line x1={pool.x} y1="55" x2={pool.x} y2="65" stroke="var(--p-line)" />
  <line x1={poolRight} y1="55" x2={poolRight} y2="65" stroke="var(--p-line)" />

  <rect
    x={pool.x}
    y={pool.y}
    width={pool.width}
    height={pool.height}
    rx="4"
    stroke="var(--p-line)"
  />

  <clipPath id="step07-reserve-wipe">
    <rect
      class="reserve-wipe"
      x={pool.x - 2}
      y={pool.y - 2}
      width={pool.width + 4}
      height={pool.height + 4}
    />
  </clipPath>
  <rect
    x={pool.x + inset}
    y={pool.y + inset}
    width={reservedWidth}
    height={pool.height - inset * 2}
    rx="2"
    fill="var(--p-accent-soft)"
    stroke="var(--p-accent)"
    clip-path="url(#step07-reserve-wipe)"
  />

  <text
    x={poolMid}
    y={pool.y + 30}
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">RESERVED</text
  >
  <text
    x={poolMid}
    y={pool.y + 48}
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    font-family={mono}>{reserved} mg</text
  >

  <!-- Issued is a region of zero width, held open at the far edge. -->
  <line
    x1={reservedRight}
    y1={pool.y + pool.height}
    x2={reservedRight}
    y2={pool.y + pool.height + 18}
    stroke="var(--p-line)"
  />
  <text
    x={reservedRight - 5}
    y="152"
    text-anchor="end"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">ISSUED</text
  >
  <text
    x={reservedRight + 5}
    y="152"
    font-size="9"
    fill="var(--p-muted)"
    font-family={mono}>{issued}</text
  >

  <!-- Authority: a circle with a keyhole notch. -->
  <circle cx="250" cy="100" r="22" stroke="var(--p-line)" />
  <circle cx="250" cy="95" r="4.5" stroke="var(--p-line)" />
  <path d="M246.9 98.9 245.6 110h8.8l-1.3-11.1" stroke="var(--p-line)" />
  <line x1="224" y1="100" x2="196" y2="100" stroke="var(--p-line)" />
  <path d="M202 96 196 100l6 4" stroke="var(--p-line)" />
  <text
    x="250"
    y="138"
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">ISSUER</text
  >

  <!-- Not reached: the permit is signed later, so it is drawn faint and empty. -->
  <g opacity="0.35">
    <rect
      x="106"
      y="180"
      width="198"
      height="20"
      rx="10"
      stroke="var(--p-line)"
    />
    <text
      x="205"
      y="194"
      text-anchor="middle"
      font-size="9"
      fill="var(--p-muted)"
      letter-spacing="0.08em">PERMIT · EXPIRES IN MINUTES</text
    >
  </g>

  <line x1="20" y1="216" x2="300" y2="216" stroke="var(--p-line)" />

  <!-- Not reached: the token shape, drawn faint and unfilled. -->
  <g opacity="0.35">
    <circle cx="44" cy="246" r="16" stroke="var(--p-line)" />
    <circle cx="44" cy="246" r="8" stroke="var(--p-line)" />
  </g>
  <text
    x="72"
    y="250"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">NO TOKEN EXISTS YET</text
  >
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  /* Pattern 1, once on mount and never looping: reserving happens once. The
     clip slides in from the left so the reserved region sweeps across the pool.
     The base state carries no transform, which is the completed state. Travel
     is the clip width (pool.width + 4 = 174). */
  .reserve-wipe {
    animation: reserve-wipe 700ms cubic-bezier(0.22, 0.8, 0.22, 1) 1;
  }
  @keyframes reserve-wipe {
    from {
      transform: translateX(-174px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reserve-wipe {
      animation: none;
    }
  }
</style>
