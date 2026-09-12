<script lang="ts">
  // The registry answers "who". Only the Gate answers "whether", so the
  // connector from the records runs out at the divider and never arrives.
  const records = [
    { name: 'ISSUER', id: '116', y: 42 },
    { name: 'DEPLOYMENT', id: '117', y: 74 },
    { name: 'AUDITOR', id: '118', y: 106 },
  ];
  const checkTicks = Array.from({ length: 8 }, (_, index) => 16 + index * 14);
  // Separate four-unit dashes, so the draw-on reveals the break itself.
  const brokenLink = Array.from(
    { length: 17 },
    (_, index) => `M${30 + index * 7},212h4`,
  ).join(' ');
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
  <line x1="152" y1="22" x2="152" y2="248" />

  <text
    x="12"
    y="30"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">REGISTRY SAYS WHO</text
  >

  {#each records as record (record.id)}
    <g>
      <rect x="12" y={record.y} width="124" height="26" rx="6" />
      <text
        x="20"
        y={record.y + 16}
        font-size="9"
        letter-spacing="0.08em"
        fill="var(--p-muted)"
        stroke="none"
        >{record.name}
        <tspan font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
          >{record.id}</tspan
        ></text
      >
      <line x1="114" y1={record.y + 8} x2="112" y2={record.y + 18} />
      <line x1="119" y1={record.y + 8} x2="117" y2={record.y + 18} />
      <line x1="110" y1={record.y + 11} x2="122" y2={record.y + 11} />
      <line x1="109" y1={record.y + 15} x2="121" y2={record.y + 15} />
    </g>
  {/each}

  {#each checkTicks as tick (tick)}
    <line x1={tick} y1="148" x2={tick} y2="158" />
  {/each}
  <text
    x="12"
    y="176"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none"
    ><tspan font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
      >8</tspan
    > CHECKS AGAINST</text
  >
  <text
    x="12"
    y="188"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">CHAIN STATE</text
  >

  <!-- Draws on, then stops short of the divider. That stop is the point. -->
  <path class="broken-link" pathLength="100" d={brokenLink} />
  <line class="refusal" x1="145" y1="204" x2="155" y2="220" />
  <text
    x="30"
    y="234"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">NO AUTHORITY</text
  >

  <text
    x="162"
    y="30"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">GATE DECIDES WHETHER</text
  >

  <!-- The Gate is the single accent: it is the only thing that decides. -->
  <path class="authority" d="M195,112.7 A18,18 0 1 0 205,112.7 L200,121 Z" />
  <line x1="220" y1="130" x2="253" y2="130" />
  <circle cx="270" cy="130" r="14" />
  <circle cx="270" cy="130" r="6" />
  <text
    x="200"
    y="162"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">GATE</text
  >
  <text
    x="270"
    y="162"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">TOKEN</text
  >
</svg>

<style>
  svg {
    width: 100%;
    max-width: 340px;
    height: auto;
    display: block;
  }
  .authority {
    stroke: var(--p-accent);
  }
  .refusal {
    stroke: #8b3f3f;
  }
  .broken-link {
    stroke-dasharray: 100;
    stroke-dashoffset: 0;
    animation: draw-stop 700ms ease-out both;
  }
  @keyframes draw-stop {
    from {
      stroke-dashoffset: 100;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .broken-link {
      animation: none;
    }
  }
</style>
