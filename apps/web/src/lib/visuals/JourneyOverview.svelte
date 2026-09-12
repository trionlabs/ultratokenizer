<script lang="ts">
  import { onMount } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';

  // The whole journey in one strip. Laid out in HTML rather than one wide SVG
  // so the labels stay real text at every width and the row can wrap on a
  // phone instead of shrinking to an unreadable smear.
  const stations = [
    { key: 'document', name: 'Signed document', note: 'from your institution' },
    { key: 'proof', name: 'Proof', note: 'made on your machine' },
    { key: 'permit', name: 'Permission', note: 'the institution authorises' },
    { key: 'gate', name: 'Ten checks', note: 'on Hedera' },
    { key: 'token', name: 'Your token', note: 'send it, split it' },
  ];

  // At rest the journey is complete, so the strip still reads when the
  // animation is blocked, skipped or already finished.
  let reached = $state(stations.length);
  let timer: ReturnType<typeof setInterval> | undefined;

  function play() {
    clearInterval(timer);
    if (prefersReducedMotion.current) {
      reached = stations.length;
      return;
    }
    reached = 0;
    timer = setInterval(() => {
      reached += 1;
      if (reached >= stations.length) clearInterval(timer);
    }, 900);
  }

  onMount(() => {
    play();
    return () => clearInterval(timer);
  });
</script>

<div class="journey">
  <ol aria-label="What happens, end to end">
    {#each stations as station, index}
      <li data-on={index < reached}>
        <span class="glyph" aria-hidden="true">
          {#if station.key === 'document'}
            <svg viewBox="0 0 40 40" focusable="false">
              <path
                d="M11 7h13l6 6v20a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 10 33V8.5A1.5 1.5 0 0 1 11.5 7Z"
                transform="rotate(-6 20 20)"
              />
              <path d="M24 7v6h6" transform="rotate(-6 20 20)" />
              <path
                d="M15 21h10M15 26h7"
                transform="rotate(-6 20 20)"
                class="rule"
              />
            </svg>
          {:else if station.key === 'proof'}
            <svg viewBox="0 0 40 40" focusable="false">
              <path d="M20 6 32 13v14l-12 7-12-7V13Z" />
              <path d="m15 20 4 4 7-8" class="tick" />
            </svg>
          {:else if station.key === 'permit'}
            <svg viewBox="0 0 40 40" focusable="false">
              <rect x="9" y="9" width="22" height="22" rx="7" />
              <circle cx="20" cy="18" r="2.6" class="tick" />
              <path d="M20 21.5 17.8 28h4.4Z" class="tick" />
            </svg>
          {:else if station.key === 'gate'}
            <svg viewBox="0 0 40 40" focusable="false">
              <rect x="8" y="7" width="24" height="26" rx="5" />
              <path d="M13 14h14M13 20h14M13 26h14" class="rule" />
            </svg>
          {:else}
            <svg viewBox="0 0 40 40" focusable="false">
              <circle cx="20" cy="20" r="13" />
              <circle cx="20" cy="20" r="8" class="rule" />
            </svg>
          {/if}
        </span>
        <span class="label">
          <strong>{station.name}</strong>
          <small>{station.note}</small>
        </span>
      </li>
    {/each}
  </ol>
  <button class="replay" type="button" onclick={play}>Play again</button>
</div>

<style>
  .journey {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  ol {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 6px 0;
    list-style: none;
    margin: 0;
    padding: 0;
    width: 100%;
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 11px;
    flex: 1 1 190px;
    min-width: 0;
    padding: 7px 14px 7px 0;
  }
  /* The connector belongs to the gap after each station, so the row can wrap
     without leaving a line pointing at nothing. */
  li:not(:last-child)::after {
    content: '';
    position: absolute;
    right: 2px;
    top: 50%;
    width: 10px;
    height: 1px;
    background: var(--p-line);
  }
  .glyph {
    flex: none;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--p-canvas);
    border: 1px solid var(--p-line);
    transition:
      background 320ms ease,
      border-color 320ms ease,
      transform 320ms ease;
  }
  .glyph svg {
    width: 23px;
    height: 23px;
    fill: none;
    stroke: var(--p-muted);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: stroke 320ms ease;
  }
  .glyph svg .rule,
  .glyph svg .tick {
    stroke: var(--p-line);
  }
  .label {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .label strong {
    font-size: 0.8rem;
    font-weight: 650;
    color: var(--p-muted);
    transition: color 320ms ease;
  }
  .label small {
    font-size: 0.68rem;
    color: var(--p-muted);
    opacity: 0.8;
  }

  li[data-on='true'] .glyph {
    background: var(--p-accent-soft);
    border-color: var(--p-accent);
    transform: translateY(-2px);
  }
  li[data-on='true'] .glyph svg {
    stroke: var(--p-accent);
  }
  li[data-on='true'] .glyph svg .rule,
  li[data-on='true'] .glyph svg .tick {
    stroke: var(--p-accent);
  }
  li[data-on='true'] .label strong {
    color: var(--p-ink);
  }
  li[data-on='true']:not(:last-child)::after {
    background: var(--p-accent);
  }

  button.replay {
    min-height: 30px;
    padding: 3px 2px;
    border: 0;
    background: transparent;
    color: var(--p-accent);
    font-size: 0.72rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .glyph,
    .glyph svg,
    .label strong {
      transition: none;
    }
  }
</style>
