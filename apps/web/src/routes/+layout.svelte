<script lang="ts">
  import { onMount } from 'svelte';
  import '../styles.css';
  import '../issuance.css';
  let { children } = $props();
  let frameState = $state<'checking' | 'direct' | 'embedded'>('checking');
  let directPath = $state('?reload=1');
  onMount(() => {
    directPath = window.location.origin + window.location.pathname;
    frameState = window.self === window.top ? 'direct' : 'embedded';
  });
</script>

{#if frameState === 'direct'}
  {@render children()}
{:else}
  <main class="direct-tab">
    <p>
      {frameState === 'checking'
        ? 'Loading Ultratokenizer. If this screen stays, the app did not start. Open it in a new tab.'
        : 'Use a direct browser tab to import files or connect a wallet.'}
    </p>
    <a href={directPath} target="_blank" rel="noopener noreferrer"
      >Open Ultratokenizer directly</a
    >
  </main>
{/if}

<style>
  .direct-tab {
    max-width: 32rem;
    margin: 3rem auto;
    padding: 1.5rem;
  }
  .direct-tab a {
    display: inline-block;
    margin-top: 1rem;
  }
</style>
