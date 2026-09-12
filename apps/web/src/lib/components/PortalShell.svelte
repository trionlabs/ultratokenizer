<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    current,
    children,
  }: { current: 'institution' | 'trust' | 'demo'; children: Snippet } =
    $props();
</script>

<a class="skip-link" href="#portal">Skip to {current}</a>
<div class="live-shell portal-shell">
  <header class="portal-header">
    <a class="live-brand" href="/"><span>u</span>ultratokenizer<i>.</i></a>
    <nav aria-label="Workspace">
      <a href="/">Tokenize</a>
      <a
        href="/institution/"
        aria-current={current === 'institution' ? 'page' : undefined}
        >Institution</a
      >
      <a href="/trust/" aria-current={current === 'trust' ? 'page' : undefined}
        >Trust</a
      >
      <a href="/verify/">Verify</a>
      <a href="/demo/" aria-current={current === 'demo' ? 'page' : undefined}
        >How it works</a
      >
    </nav>
  </header>
  <main id="portal" tabindex="-1">{@render children()}</main>
  <footer>
    Hedera testnet · Synthetic source. No bank or regulatory endorsement.
  </footer>
</div>

<style>
  .portal-header {
    width: min(100% - 40px, 1180px);
    margin: auto;
    min-height: 80px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    border-bottom: 1px solid var(--p-line);
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  nav a {
    padding: 9px 12px;
    border-radius: 24px;
    text-decoration: none;
    color: var(--p-muted);
    font-size: 0.82rem;
  }
  nav a[aria-current] {
    background: var(--p-accent-soft);
    color: var(--p-ink);
  }
  main {
    width: min(100% - 40px, 1120px);
    margin: auto;
    padding: 48px 0;
  }
  footer {
    width: min(100% - 40px, 1120px);
    margin: auto;
    padding: 24px 0;
    color: var(--p-muted);
    font-size: 0.75rem;
    border-top: 1px solid var(--p-line);
  }
  :global(.portal-shell h1) {
    max-width: none;
    font-size: clamp(2rem, 4vw, 3.2rem);
    letter-spacing: -0.05em;
    margin: 9px 0 14px;
  }
  :global(.portal-shell h2) {
    font-size: 1.14rem;
    letter-spacing: -0.025em;
    margin-bottom: 14px;
  }
  :global(.portal-shell h3) {
    font-size: 0.91rem;
    margin-bottom: 12px;
  }
  :global(.portal-shell .intro) {
    max-width: 680px;
    color: var(--p-muted);
    margin-bottom: 28px;
  }
  :global(.portal-grid) {
    display: grid;
    grid-template-columns: 1.1fr 1fr;
    gap: 22px;
    margin-top: 24px;
    align-items: start;
  }
  :global(.portal-card) {
    padding: 26px;
    border: 1px solid var(--p-line);
    border-radius: 20px;
    background: var(--p-paper);
    min-width: 0;
  }
  :global(.portal-card + .portal-card) {
    margin-top: 20px;
  }
  :global(.portal-shell .muted) {
    color: var(--p-muted);
    font-size: 0.84rem;
  }
  :global(.portal-shell .eyebrow) {
    color: var(--p-accent);
  }
  :global(.portal-shell dl) {
    margin: 0;
  }
  :global(.portal-shell dl > div) {
    padding: 12px 0;
    border-bottom: 1px solid var(--p-line);
  }
  :global(.portal-shell dl > div:last-child) {
    border-bottom: 0;
  }
  :global(.portal-shell dt) {
    font-size: 0.75rem;
    color: var(--p-muted);
    margin-bottom: 5px;
  }
  :global(.portal-shell dd) {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 0.86rem;
  }
  :global(.portal-shell .mono) {
    font-size: 0.75rem;
  }
  :global(.portal-shell button),
  :global(.portal-shell .portal-button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 43px;
    padding: 10px 18px;
    border-radius: 24px;
    color: white;
    background: var(--p-accent);
    font-size: 0.83rem;
    text-decoration: none;
  }
  :global(.portal-shell button.secondary),
  :global(.portal-shell .portal-button.secondary) {
    background: var(--p-accent-soft);
    color: var(--p-ink);
  }
  :global(.portal-shell .actions) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 18px;
  }
  :global(.portal-shell label) {
    display: block;
    font-size: 0.82rem;
    margin: 18px 0 7px;
  }
  :global(.portal-shell input:not([type='checkbox'])) {
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    background: white;
    border: 1px solid var(--p-line);
    border-radius: 9px;
    color: var(--p-ink);
  }
  :global(.portal-shell input[type='file']) {
    font-size: 0.8rem;
  }
  :global(.portal-shell input::file-selector-button) {
    background: var(--p-accent-soft);
    color: var(--p-ink);
    padding: 8px 12px;
    border: 0;
    border-radius: 6px;
    margin-right: 12px;
  }
  :global(.portal-shell .check-label) {
    display: flex;
    align-items: start;
    gap: 10px;
    line-height: 1.5;
  }
  :global(.portal-shell .check-label input) {
    margin-top: 4px;
  }
  :global(.portal-shell .notice) {
    padding: 16px 18px;
    border-radius: 12px;
    background: var(--p-accent-soft);
    color: var(--p-ink);
    font-size: 0.84rem;
    margin: 18px 0;
    overflow-wrap: anywhere;
  }
  :global(.portal-shell details) {
    margin-top: 20px;
  }
  :global(.portal-shell summary) {
    cursor: pointer;
    font-size: 0.83rem;
    color: var(--p-accent);
  }
  :global(.portal-shell .status-line) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }
  @media (max-width: 700px) {
    .portal-header {
      align-items: start;
      flex-direction: column;
      padding: 18px 0;
      gap: 14px;
    }
    nav a {
      padding: 7px 10px;
    }
    main {
      padding-top: 32px;
    }
    :global(.portal-grid) {
      grid-template-columns: 1fr;
    }
    :global(.portal-card) {
      padding: 20px;
    }
  }
</style>
