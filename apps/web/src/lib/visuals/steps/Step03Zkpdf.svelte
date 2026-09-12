<script lang="ts">
  // The document goes into the proof and does not come out. What leaves the
  // hexagon is 224 bytes of public values, and nothing else.
  const hexCentre = { x: 160, y: 140 };
  const hexRadius = 44;

  const hexPoints = $derived(
    Array.from({ length: 6 }, (_, index) => {
      const angle = (Math.PI / 3) * index;
      const x = hexCentre.x + hexRadius * Math.cos(angle);
      const y = hexCentre.y + hexRadius * Math.sin(angle);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' '),
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
  <!-- What goes in. -->
  <g transform="rotate(-6 47 143)" stroke="var(--p-line)">
    <rect x="16" y="104" width="62" height="78" rx="8" />
    <line x1="26" y1="124" x2="68" y2="124" />
    <line x1="26" y1="136" x2="68" y2="136" />
    <line x1="26" y1="148" x2="54" y2="148" />
  </g>
  <text
    x="47"
    y="200"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">DOCUMENT</text
  >
  <text
    x="47"
    y="212"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">PRIVATE</text
  >

  <line x1="84" y1="140" x2="114" y2="140" stroke="var(--p-line)" />

  <!-- The proof. The only polygon in the set. -->
  <polygon
    points={hexPoints}
    fill="var(--p-accent-soft)"
    stroke="var(--p-accent)"
  />
  <text
    x={hexCentre.x}
    y="144"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">SP1 zkVM</text
  >
  <text
    x={hexCentre.x}
    y="202"
    text-anchor="middle"
    font-size="9"
    font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
    fill="var(--p-muted)">zkPDF · RSA-2048 · SHA-256</text
  >

  <!-- All that comes back out. -->
  <line x1="208" y1="140" x2="228" y2="140" stroke="var(--p-line)" />
  <rect x="232" y="128" width="72" height="24" rx="10" stroke="var(--p-line)" />
  <text
    x="268"
    y="144"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.04em"
    font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
    fill="var(--p-muted)">224 BYTES</text
  >
  <text
    x="268"
    y="170"
    text-anchor="middle"
    font-size="9"
    letter-spacing="0.08em"
    fill="var(--p-muted)">PUBLIC VALUES</text
  >

  <!-- Pattern 2: a large mark enters and is gone; a small one leaves. -->
  <circle class="dot-in" cx="84" cy="140" r="3" fill="var(--p-muted)" />
  <circle class="dot-out" cx="208" cy="140" r="2" fill="var(--p-muted)" />
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-width: 340px;
    height: auto;
  }
  .dot-in {
    animation: flow-in 2.4s linear infinite;
  }
  .dot-out {
    animation: flow-out 2.4s linear infinite;
  }
  @keyframes flow-in {
    0% {
      transform: translateX(0);
      opacity: 1;
    }
    40% {
      transform: translateX(26px);
      opacity: 1;
    }
    50% {
      transform: translateX(32px);
      opacity: 0;
    }
    100% {
      transform: translateX(32px);
      opacity: 0;
    }
  }
  @keyframes flow-out {
    0% {
      transform: translateX(0);
      opacity: 0;
    }
    45% {
      transform: translateX(0);
      opacity: 0;
    }
    50% {
      transform: translateX(0);
      opacity: 1;
    }
    92% {
      transform: translateX(20px);
      opacity: 1;
    }
    100% {
      transform: translateX(20px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot-in,
    .dot-out {
      animation: none;
    }
  }
</style>
