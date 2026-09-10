<script lang="ts">
  let {
    name,
    size = 20,
  }: {
    name:
      | 'arrow'
      | 'back'
      | 'lock'
      | 'check'
      | 'close'
      | 'eye'
      | 'reset'
      | 'wallet'
      | 'plus'
      | 'shield';
    size?: number;
  } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'arrow'}<path d="M5 12h14m-5-5 5 5-5 5" />
  {:else if name === 'back'}<path d="M19 12H5m5-5-5 5 5 5" />
  {:else if name === 'lock'}<rect
      x="5"
      y="10"
      width="14"
      height="11"
      rx="3"
    /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
  {:else if name === 'check'}<path d="m5 12 4 4L19 6" />
  {:else if name === 'close'}<path d="m6 6 12 12M6 18 18 6" />
  {:else if name === 'eye'}<path
      d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"
    /><circle cx="12" cy="12" r="3" />
  {:else if name === 'reset'}<path d="M3 11a9 9 0 1 1 3 8M3 4v7h7" />
  {:else if name === 'wallet'}<path
      d="M4 6h15v4M4 6V4h13M4 6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h15V10H4"
    /><path d="M19 13h-5v5h5m-2-3h.01" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else}<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path
      d="m8 12 3 3 5-6"
    />{/if}
</svg>
