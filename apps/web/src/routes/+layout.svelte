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

{#if frameState !== 'embedded'}
  <!-- SSR shows the actual page. File and wallet controls stay inert until the
       direct-tab check completes; mounting children only performs read-only setup. -->
  <div class="app-surface" inert={frameState !== 'direct'}>
    {@render children()}
  </div>
  {#if frameState === 'checking'}
    <aside class="direct-tab start-help">
      <p>If this screen stays, the app did not start. Open it in a new tab.</p>
      <a href={directPath} target="_blank" rel="noopener noreferrer"
        >Open Ultratokenizer directly</a
      >
    </aside>
  {/if}
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
  .start-help {
    position: fixed;
    z-index: 20;
    right: 16px;
    bottom: 16px;
    width: min(100% - 32px, 360px);
    margin: 0;
    padding: 14px 18px;
    border: 1px solid #e4e0e9;
    border-radius: 14px;
    background: #fdfcfe;
    color: #736c7e;
    font-size: 12px;
    box-shadow: 0 10px 30px #302b3814;
    visibility: hidden;
    animation: show-start-help 0s 3s forwards;
  }
  @keyframes show-start-help {
    to {
      visibility: visible;
    }
  }
</style>
