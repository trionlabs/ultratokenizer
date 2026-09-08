<script lang="ts">
  import { dev } from '$app/environment';
  import { variants, type Variant } from './visual-model';
  import Glyph from './Glyph.svelte';
  let {
    current,
    onchange,
  }: { current: Variant; onchange: (variant: Variant) => void } = $props();
  let index = $derived(variants.findIndex((item) => item.id === current));
  function cycle(direction: number) {
    onchange(
      variants[(index + direction + variants.length) % variants.length].id,
    );
  }
  function keydown(event: KeyboardEvent) {
    const target = event.target;
    if (
      !dev ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      document.querySelector('dialog[open]') ||
      !(target instanceof HTMLElement) ||
      target.closest(
        'input,textarea,select,[contenteditable],button,[role="slider"]',
      )
    )
      return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      cycle(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }
</script>

<svelte:window onkeydown={keydown} />
{#if dev}<nav class="prototype-switcher" aria-label="Design variations">
    <span class="prototype-tag">DESIGN LAB</span><button
      aria-label="Previous design"
      onclick={() => cycle(-1)}><Glyph name="back" size={17} /></button
    ><span class="variant-name" aria-live="polite"
      >{current} <span>/</span> {variants[index].name}</span
    ><button aria-label="Next design" onclick={() => cycle(1)}
      ><Glyph name="arrow" size={17} /></button
    ><span class="prototype-count">{index + 1} / 3</span>
  </nav>{/if}
