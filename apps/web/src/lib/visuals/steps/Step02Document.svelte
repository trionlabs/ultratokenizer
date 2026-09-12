<script lang="ts">
  // The recipient's wallet address sits inside the region the signature covers.
  // Segment widths are the real byte lengths: 196 bytes across 196 user units.
  const fields = [
    { name: 'MAGIC', bytes: 8 },
    { name: 'SOURCE', bytes: 32 },
    { name: 'CLAIM', bytes: 32 },
    { name: 'ISSUER', bytes: 32 },
    { name: 'HOLDER', bytes: 20 },
    { name: 'CAPACITY', bytes: 32 },
    { name: 'UNIT', bytes: 32 },
    { name: 'EXPIRY', bytes: 8 },
  ];
  const totalBytes = fields.reduce((sum, field) => sum + field.bytes, 0);
  const stripX = 62;
  const stripY = 158;
  const stripWidth = 196;
  const stripHeight = 26;

  const segments = $derived(
    fields.map((field, index) => {
      const before = fields
        .slice(0, index)
        .reduce((sum, item) => sum + item.bytes, 0);
      const width = (field.bytes / totalBytes) * stripWidth;
      const x = stripX + (before / totalBytes) * stripWidth;
      return {
        name: field.name,
        x,
        width,
        centre: x + width / 2,
        start: before,
        end: before + field.bytes,
        above: index % 2 === 0,
        // The accent segment draws its own edges, so skip those dividers.
        divider:
          index > 0 &&
          field.name !== 'HOLDER' &&
          fields[index - 1]?.name !== 'HOLDER',
      };
    }),
  );

  const holder = $derived(
    segments.find((segment) => segment.name === 'HOLDER'),
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
  <g transform="rotate(-6 160 140)">
    <rect
      x="30"
      y="44"
      width="260"
      height="192"
      rx="8"
      stroke="var(--p-line)"
    />
    <line x1="58" y1="78" x2="174" y2="78" stroke="var(--p-line)" />
    <line x1="58" y1="88" x2="150" y2="88" stroke="var(--p-line)" />
    <line x1="58" y1="98" x2="118" y2="98" stroke="var(--p-line)" />

    <text
      x="160"
      y="118"
      text-anchor="middle"
      font-size="9"
      letter-spacing="0.08em"
      fill="var(--p-muted)">SIGNED REGION</text
    >
    <path
      class="bracket"
      d="M 44 126 L 36 126 L 36 202 L 44 202 M 276 126 L 284 126 L 284 202 L 276 202"
      stroke="var(--p-line)"
    />

    <rect
      x={stripX}
      y={stripY}
      width={stripWidth}
      height={stripHeight}
      stroke="var(--p-line)"
    />
    {#each segments as segment (segment.name)}
      {#if segment.divider}
        <line
          x1={segment.x}
          y1={stripY}
          x2={segment.x}
          y2={stripY + stripHeight}
          stroke="var(--p-line)"
        />
      {/if}
    {/each}

    {#if holder}
      <rect
        class="holder"
        x={holder.x}
        y={stripY}
        width={holder.width}
        height={stripHeight}
        fill="var(--p-accent-soft)"
        stroke="var(--p-accent)"
      />
      <text
        x={holder.centre}
        y="136"
        text-anchor="middle"
        font-size="9"
        letter-spacing="0.04em"
        font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
        fill="var(--p-muted)">{holder.start}-{holder.end}</text
      >
    {/if}

    {#each segments as segment (segment.name)}
      <line
        x1={segment.centre}
        y1={segment.above ? stripY : stripY + stripHeight}
        x2={segment.centre}
        y2={segment.above ? stripY - 6 : stripY + stripHeight + 6}
        stroke="var(--p-line)"
      />
      <text
        x={segment.centre}
        y={segment.above ? 148 : 200}
        text-anchor="middle"
        font-size="9"
        letter-spacing="0.08em"
        fill="var(--p-muted)">{segment.name}</text
      >
    {/each}
  </g>

  <text
    x="160"
    y="268"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">HOLDER SITS INSIDE THE SIGNED REGION</text
  >
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  /* Pattern 1: the bracket draws on once; it rests fully drawn. */
  .bracket {
    stroke-dasharray: 100;
    stroke-dashoffset: 0;
    animation: bracket-draw 700ms ease-out 1;
  }
  @keyframes bracket-draw {
    from {
      stroke-dashoffset: 100;
    }
  }
  /* Pattern 3, as a keyframe: the covered field keeps breathing. */
  .holder {
    animation: holder-pulse 3s ease-in-out infinite;
  }
  @keyframes holder-pulse {
    50% {
      opacity: 0.5;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bracket,
    .holder {
      animation: none;
    }
  }
</style>
