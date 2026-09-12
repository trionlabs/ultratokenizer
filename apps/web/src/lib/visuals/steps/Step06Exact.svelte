<script lang="ts">
  // Exactness: the request amount must equal the full authenticated capacity.
  // Three of the four candidates are rejected, which is the shape of the
  // argument. The thin scale at the bottom carries the nuance: the restriction
  // is on issuance, not on the asset once it exists.
  const mono = 'ui-monospace, SFMono-Regular, Consolas, monospace';
  const trackX = 58;
  const trackWidth = 112;

  let capacity = $state(1000);
  let requests = $state([250, 500, 1000, 1500]);

  let rows = $derived(
    requests.map((amount, index) => ({
      amount,
      y: 42 + index * 26,
      width: (amount / capacity) * trackWidth,
      accepted: amount === capacity,
    })),
  );

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((at) => trackX + at * trackWidth);
  const divisions = Array.from({ length: 15 }, (_, i) => trackX + i * 8);
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
    x="30"
    y="22"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">REQUEST AMOUNT</text
  >

  <!-- The exactness axis: the only width a request is allowed to reach. -->
  <line x1="170" y1="28" x2="170" y2="130" stroke="var(--p-line)" />
  <line x1="170" y1="148" x2="170" y2="176" stroke="var(--p-line)" />

  {#each rows as row (row.amount)}
    <text
      x="52"
      y={row.y + 3}
      text-anchor="end"
      font-size="9"
      fill="var(--p-muted)"
      font-family={mono}>{row.amount}</text
    >

    {#if row.accepted}
      <clipPath id="step06-exact-wipe">
        <rect
          class="exact-wipe"
          x={trackX - 2}
          y={row.y - 10}
          width={trackWidth + 4}
          height="20"
        />
      </clipPath>
      <rect
        x={trackX}
        y={row.y - 6}
        width={row.width}
        height="12"
        rx="3"
        fill="var(--p-accent-soft)"
        clip-path="url(#step06-exact-wipe)"
      />
      <rect
        x={trackX}
        y={row.y - 6}
        width={row.width}
        height="12"
        rx="3"
        stroke="var(--p-accent)"
      />
      <text
        x={trackX + row.width + 8}
        y={row.y + 3}
        font-size="9"
        fill="var(--p-muted)"
        letter-spacing="0.08em">= CAPACITY</text
      >
    {:else}
      <rect
        x={trackX}
        y={row.y - 6}
        width={row.width}
        height="12"
        rx="3"
        stroke="#8b3f3f"
        stroke-dasharray="4 3"
      />
      <path
        d={`M${trackX + row.width + 4} ${row.y + 8}L${trackX + row.width + 12} ${row.y - 8}`}
        stroke="#8b3f3f"
      />
      <text
        x={trackX + row.width + 18}
        y={row.y + 3}
        font-size="9"
        fill="#8b3f3f"
        letter-spacing="0.08em">REJECTED</text
      >
    {/if}
  {/each}

  <text
    x="30"
    y="142"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em">AUTHENTICATED CAPACITY</text
  >
  <rect
    x={trackX}
    y="150"
    width={trackWidth}
    height="16"
    rx="3"
    stroke="var(--p-line)"
  />
  {#each ticks as tick (tick)}
    <line x1={tick} y1="170" x2={tick} y2="176" stroke="var(--p-line)" />
  {/each}
  <text
    x={trackX}
    y="188"
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    font-family={mono}>0</text
  >
  <text
    x={trackX + trackWidth}
    y="188"
    text-anchor="middle"
    font-size="9"
    fill="var(--p-muted)"
    font-family={mono}>1000 mg</text
  >

  <line x1="30" y1="206" x2="290" y2="206" stroke="var(--p-line)" />

  <rect
    x={trackX}
    y="222"
    width={trackWidth}
    height="7"
    stroke="var(--p-line)"
  />
  {#each divisions as division (division)}
    <line
      x1={division}
      y1="222"
      x2={division}
      y2="229"
      stroke="var(--p-line)"
    />
  {/each}
  <text
    x="30"
    y="248"
    font-size="9"
    fill="var(--p-muted)"
    letter-spacing="0.08em"
    >AFTER ISSUANCE: DIVIDES TO <tspan font-family={mono}>0.001 g</tspan></text
  >
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  /* Pattern 1, once on mount: the clip slides in from the left so the accepted
     fill grows left to right. The base state carries no transform, which is the
     completed state, so nothing is ever left blank. Travel is the clip width
     (trackWidth + 4 = 116). */
  .exact-wipe {
    animation: exact-wipe 700ms cubic-bezier(0.22, 0.8, 0.22, 1) 1;
  }
  @keyframes exact-wipe {
    from {
      transform: translateX(-116px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .exact-wipe {
      animation: none;
    }
  }
</style>
