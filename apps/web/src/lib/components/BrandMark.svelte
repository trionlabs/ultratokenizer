<script lang="ts">
  // The UT monogram, traced pixel-exactly from the source artwork: a T
  // interlocked with a U on one square field. Stroke 60, mark 288 wide on a
  // 512 field, sitting 8 units above centre — that offset is in the original,
  // so it is kept rather than corrected.
  //
  // Drawn as rectangles rather than a letterform, so it is identical wherever
  // it appears and never depends on a font. The size is fixed in pixels: the
  // mark is artwork, not text, and must not outgrow the header line when the
  // reader scales text to 200%.
  //
  // The source colours are exactly the palette tokens, so the mark tracks the
  // theme. The literal fallbacks keep it visible rather than black-on-black if
  // it is ever rendered outside `.live-shell`, where the tokens are defined.
  let { size = 34 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 512 512"
  role="img"
  aria-label="Ultratokenizer"
>
  <rect width="512" height="512" fill="var(--p-ink, #302b38)" />
  <g fill="var(--p-accent-soft, #eeebf2)">
    <rect x="112" y="120" width="288" height="60" />
    <rect x="226" y="180" width="60" height="116" />
    <rect x="112" y="210" width="60" height="174" />
    <rect x="340" y="210" width="60" height="174" />
    <rect x="112" y="324" width="288" height="60" />
  </g>
</svg>
