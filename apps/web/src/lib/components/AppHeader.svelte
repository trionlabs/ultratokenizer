<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    current,
    actions,
  }: {
    current:
      | 'issue'
      | 'transfer'
      | 'institution'
      | 'trust'
      | 'verify'
      | 'demo'
      | 'judge';
    actions?: Snippet;
  } = $props();
  const inEngine = $derived(current === 'issue' || current === 'transfer');
  const links = $derived([
    { id: 'issue', label: 'Tokenize', href: inEngine ? '#engine' : '/#engine' },
    {
      id: 'transfer',
      label: 'Transfer',
      href: inEngine ? '#transfer' : '/#transfer',
    },
    { id: 'institution', label: 'Institution', href: '/institution/' },
    { id: 'trust', label: 'Trust', href: '/trust/' },
    { id: 'verify', label: 'Verify', href: '/verify/' },
    { id: 'demo', label: 'How it works', href: '/demo/' },
    { id: 'judge', label: 'Review demo', href: '/judge/' },
  ]);
</script>

<header class="app-header">
  <div class="brand-block">
    <a class="live-brand" href="/" aria-label="Ultratokenizer home"
      ><span>u</span>ultratokenizer<i>.</i></a
    >
    <span class="engine-label">zkPDF-backed token issuance</span>
  </div>
  <nav aria-label="Workspace">
    {#each links as link}
      <a
        href={link.href}
        aria-current={current === link.id ? 'page' : undefined}>{link.label}</a
      >
    {/each}
  </nav>
  <div class="header-actions">
    {#if actions}{@render actions()}
    {:else}<span class="read-mode"
        >{current === 'demo' || current === 'judge'
          ? 'Guide'
          : 'Read-only'}</span
      >{/if}
  </div>
</header>

<style>
  .app-header {
    width: min(100% - 40px, 1400px);
    /* The brand lockup is one 34px line; this leaves it room and nothing
       spare. The header test pins the box to be identical across routes, not
       to a number, so the bar's height is a design choice made in one place. */
    min-height: 54px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 20px;
    padding-block: 10px;
    border-bottom: 1px solid var(--p-line);
  }
  /* The descriptor reads beside the wordmark, not under it: stacked, it cost
     the bar a second line on every route for six words. */
  .brand-block {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-right: auto;
    min-width: 0;
    max-width: 100%;
  }
  .live-brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--p-ink);
    font-size: 1.08rem;
    font-weight: 700;
    letter-spacing: -0.04em;
    text-decoration: none;
  }
  .live-brand > span {
    width: 30px;
    height: 34px;
    display: grid;
    place-items: center;
    padding-bottom: 3px;
    color: var(--p-paper);
    background: var(--p-accent);
    border-radius: 8px 8px 13px 13px;
    /* The tile is a fixed-size brand mark, so its letterform is fixed with it.
       A rem here let the glyph grow past the tile at 200% text while the tile
       stayed put. The wordmark beside it is real text and still scales. */
    font-size: 23px;
    font-weight: 650;
    flex-shrink: 0;
  }
  .live-brand i {
    margin-left: -8px;
    color: var(--p-iris);
    font-style: normal;
  }
  .engine-label {
    padding-left: 10px;
    border-left: 1px solid var(--p-line);
    color: var(--p-muted);
    font-size: 0.68rem;
    white-space: nowrap;
  }
  nav {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2px;
    min-width: 0;
  }
  nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Matches the brand line, so the bar is one row tall and neither child
       props it open. Still well past the 24px minimum target size, and the
       horizontal padding keeps the hit area generous. */
    min-height: 36px;
    padding: 8px 11px;
    border-radius: 24px;
    color: var(--p-muted);
    text-decoration: none;
    font-size: 0.79rem;
    font-weight: 550;
  }
  nav a:hover,
  nav a[aria-current] {
    background: var(--p-accent-soft);
    color: var(--p-ink);
  }
  /* Reserves the wallet button's height so the bar does not jump between a
     read-only route and a connected one. Both are 36px, matching the brand
     line and the nav, so the header is one row on every route and state. */
  .header-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 160px;
    min-height: 36px;
  }
  .read-mode {
    color: var(--p-muted);
    font-size: 0.75rem;
    padding: 8px 12px;
  }
  .header-actions :global(.header-wallet) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 36px;
    padding: 7px 15px;
    border-radius: 24px;
    border: 1px solid var(--p-accent);
    background: var(--p-accent);
    color: white;
    font-size: 0.79rem;
    font-weight: 650;
  }
  .header-actions :global(.header-wallet:disabled) {
    color: var(--p-muted);
    background: var(--p-accent-soft);
    border-color: var(--p-line);
    opacity: 1;
  }
  @media (max-width: 1040px) {
    nav {
      order: 3;
      width: 100%;
    }
  }
  @media (max-width: 640px) {
    .app-header {
      width: calc(100% - 28px);
      gap: 8px;
      padding-block: 12px;
    }
    .live-brand {
      font-size: 0.94rem;
    }
    .engine-label {
      display: none;
    }
    .header-actions {
      flex: 0 1 auto;
      min-width: 0;
    }
    .header-actions :global(.header-wallet) {
      padding: 8px 10px;
      font-size: 0.72rem;
    }
    nav a {
      padding: 6px 9px;
    }
  }
</style>
