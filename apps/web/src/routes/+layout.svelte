<script lang="ts">
  import { onMount } from 'svelte';
  import '../styles.css';
  import '../issuance.css';
  let { children } = $props();
  let directTab = $state(false);
  let directPath = $state('/');
  onMount(() => {
    directPath = window.location.origin + window.location.pathname;
    directTab = window.self === window.top;
  });
</script>

{#if directTab}
  {@render children()}
{:else}
  <main class="direct-tab">
    <p>Use a direct browser tab to import files or connect a wallet.</p>
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
