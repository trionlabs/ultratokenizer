<script lang="ts">
  // One address may mint. Ten other role slots hold nobody and have no path
  // to the token at all, so only one line in this picture can carry anything.
  const roles = [
    'AGENT',
    'CAP',
    'CONTROL LIST',
    'TREX OWNER',
    'PAUSER',
    'ADJUSTMENT',
    'CONTROLLER',
    'PROTECTED',
    'SNAPSHOT',
    'CORPORATE',
  ];
  const socketX = (index: number) => (index < 5 ? 22 : 168);
  const socketY = (index: number) => 122 + (index % 5) * 24;
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
  <!-- The adapter, its path and the dot on it are the single accent. -->
  <path class="live" d="M44,33.5 A15,15 0 1 0 52,33.5 L48,40.5 Z" />
  <line class="live" x1="68" y1="48" x2="238" y2="48" />
  <circle class="flow-dot" cx="68" cy="48" r="3" />

  <circle cx="254" cy="48" r="14" />
  <circle cx="254" cy="48" r="6" />

  <text
    x="12"
    y="80"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">MINT ADAPTER · ISSUER</text
  >
  <text
    x="254"
    y="80"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">TOKEN</text
  >
  <text
    x="22"
    y="104"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none">TEN ROLE SLOTS</text
  >

  <!-- Empty sockets: dashed, unconnected, and never animated. -->
  {#each roles as role, index (role)}
    <g>
      <circle
        cx={socketX(index)}
        cy={socketY(index)}
        r="6"
        stroke-dasharray="4 3"
      />
      <text
        x={socketX(index) + 12}
        y={socketY(index) + 3}
        font-size="9"
        letter-spacing="0.08em"
        fill="var(--p-muted)"
        stroke="none">{role}</text
      >
    </g>
  {/each}

  <text
    x="160"
    y="252"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)"
    stroke="none"
    ><tspan font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
      >0</tspan
    > MEMBERS EACH</text
  >
</svg>

<style>
  svg {
    width: 100%;
    max-width: 340px;
    height: auto;
    display: block;
  }
  .live {
    stroke: var(--p-accent);
  }
  .flow-dot {
    fill: var(--p-accent);
    stroke: none;
    transform: translateX(166px);
    animation: flow 2.4s linear infinite;
  }
  @keyframes flow {
    0% {
      transform: translateX(0);
      opacity: 0;
    }
    12% {
      opacity: 1;
    }
    88% {
      opacity: 1;
    }
    100% {
      transform: translateX(166px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flow-dot {
      animation: none;
    }
  }
</style>
