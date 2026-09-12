<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    id,
    class: className = '',
    compact = false,
    disabled = false,
    onfile,
    onerror,
    children,
  }: {
    label: string;
    id?: string;
    class?: string;
    compact?: boolean;
    disabled?: boolean;
    onfile: (file: File) => void;
    onerror: (message: string) => void;
    children: Snippet;
  } = $props();
  let dragging = $state(false);

  function select(files: FileList | null) {
    if (disabled || !files?.length) return;
    const file = files[0];
    if (
      files.length !== 1 ||
      (!file.name.toLowerCase().endsWith('.json') &&
        file.type !== 'application/json')
    ) {
      onerror('Choose or drop one JSON file.');
      return;
    }
    onfile(file);
  }
</script>

<label
  class={className}
  class:dragging={dragging && !disabled}
  aria-disabled={disabled}
  ondragover={(event) => {
    event.preventDefault();
    dragging = !disabled;
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }}
  ondragleave={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      dragging = false;
  }}
  ondrop={(event) => {
    event.preventDefault();
    dragging = false;
    select(event.dataTransfer?.files ?? null);
  }}
>
  {@render children()}
  <input
    {id}
    class:sr-only={compact}
    type="file"
    accept=".json,application/json"
    aria-label={label}
    {disabled}
    onchange={(event) => {
      select(event.currentTarget.files);
      event.currentTarget.value = '';
    }}
  />
</label>

<style>
  label.dragging,
  label:has(input:focus-visible) {
    outline: 3px solid var(--p-accent);
    outline-offset: 4px;
  }
  label[aria-disabled='true'] {
    cursor: not-allowed;
  }
</style>
