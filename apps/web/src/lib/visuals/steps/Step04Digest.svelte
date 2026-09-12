<script lang="ts">
  // One hash pins down thirteen separate fields at once. The fields fan into a
  // single point, and nothing about the fan implies an order between them.
  type Side = 'left' | 'right';

  const leftEdge = 132;
  const rightEdge = 188;
  const chipHeight = 16;
  const pill = { x: 116, y: 228, width: 88, height: 26 };

  const leftLabels = [
    'RESERVATION',
    'CLAIM COMMIT',
    'CLAIM USAGE',
    'POLICY VER',
    'RIGHTS VER',
    'RECIPIENT',
    'CHAIN ID',
  ];
  const rightLabels = [
    'VALID UNTIL',
    'ISSUER ID',
    'AMOUNT',
    'TOKEN',
    'NONCE',
    'GATE',
  ];

  function buildChip(label: string, side: Side, cy: number) {
    const width = label.length * 6.6 + 16;
    return {
      label,
      cy,
      width,
      x: side === 'left' ? leftEdge - width : rightEdge,
      anchorX: side === 'left' ? leftEdge : rightEdge,
    };
  }

  const chips = $derived([
    ...leftLabels.map((label, index) =>
      buildChip(label, 'left', 26 + index * 25),
    ),
    ...rightLabels.map((label, index) =>
      buildChip(label, 'right', 38 + index * 25),
    ),
  ]);

  const connectors = $derived(
    chips
      .map(
        (chip) =>
          `M ${chip.anchorX} ${chip.cy} L ${pill.x + pill.width / 2} ${pill.y}`,
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
  <!-- Pattern 1: all thirteen connectors start together, never staggered. -->
  <path class="connectors" d={connectors} stroke="var(--p-line)" />

  {#each chips as chip (chip.label)}
    <rect
      x={chip.x}
      y={chip.cy - chipHeight / 2}
      width={chip.width}
      height={chipHeight}
      rx="6"
      stroke="var(--p-line)"
    />
    <text
      x={chip.x + chip.width / 2}
      y={chip.cy + 3}
      text-anchor="middle"
      font-size="9"
      letter-spacing="0.08em"
      fill="var(--p-muted)">{chip.label}</text
    >
  {/each}

  <!-- Everything above lands here. -->
  <rect
    x={pill.x}
    y={pill.y}
    width={pill.width}
    height={pill.height}
    rx="10"
    fill="var(--p-accent-soft)"
    stroke="var(--p-accent)"
  />
  <text
    x={pill.x + pill.width / 2}
    y={pill.y + 17}
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.04em"
    font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
    fill="var(--p-accent)">0xc591af7e</text
  >
  <text
    x={pill.x + pill.width / 2}
    y="272"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">ISSUANCE REQUEST DIGEST</text
  >
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  .connectors {
    stroke-dasharray: 210;
    stroke-dashoffset: 0;
    animation: connector-draw 700ms ease-out 1;
  }
  @keyframes connector-draw {
    from {
      stroke-dashoffset: 210;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .connectors {
      animation: none;
    }
  }
</style>
