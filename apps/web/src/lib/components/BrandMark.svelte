<script lang="ts">
  // The UT monogram: a T interlocked with a U on one square field. The same
  // geometry is published as static/favicon.svg and rendered into the Open
  // Graph card and the touch icon by scripts/render-brand-assets.mjs.
  //
  // Drawn as rectangles rather than a letterform, so it is identical wherever
  // it appears and does not depend on a font being available. The size is
  // fixed in pixels: the mark is artwork, not text, and must not outgrow the
  // header line when the reader scales text to 200%.
  //
  // The palette tokens live on `.live-shell`. The literal fallbacks keep the
  // mark visible rather than black-on-black if it is ever rendered outside it.
  let { size = 30 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 720 720"
  role="img"
  aria-label="Ultratokenizer"
>
  <rect width="720" height="720" fill="var(--p-ink, #302b38)" />
  <g fill="var(--p-accent-soft, #eeebf2)">
    <rect x="72" y="96" width="576" height="120" />
    <rect x="300" y="216" width="120" height="227" />
    <rect x="72" y="276" width="120" height="347" />
    <rect x="528" y="276" width="120" height="347" />
    <rect x="72" y="503" width="576" height="120" />
  </g>
</svg>
