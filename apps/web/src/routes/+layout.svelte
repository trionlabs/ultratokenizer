<script lang="ts">
  import { onMount } from 'svelte';
  import '../styles.css';
  import '../issuance.css';
  let { children } = $props();
  let frameState = $state<'checking' | 'direct' | 'embedded'>('checking');
  let directPath = $state('/');
  onMount(() => {
    directPath = window.location.origin + window.location.pathname;
    frameState = window.self === window.top ? 'direct' : 'embedded';
  });
</script>

{#if frameState === 'direct'}
  {@render children()}
{:else}
  <main class="direct-tab" aria-busy={frameState === 'checking'}>
    <p>
      {frameState === 'checking'
        ? 'Opening Ultratokenizer…'
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
