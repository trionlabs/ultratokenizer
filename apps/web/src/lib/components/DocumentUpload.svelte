<script lang="ts">
  import Glyph from '../visuals/Glyph.svelte';
  let {
    disabled = false,
    label = 'Upload signed PDF',
    onfile,
    onerror,
  }: {
    disabled?: boolean;
    label?: string;
    onfile: (file: File) => void;
    onerror: (message: string) => void;
  } = $props();
  let input: HTMLInputElement;
  let dragging = $state(false);
  function select(files: FileList | null) {
    if (disabled || !files?.length) return;
    if (files.length !== 1) {
      onerror('Choose one signed document at a time.');
      return;
    }
    onfile(files[0]!);
  }
</script>

<div
  class="document-drop"
  class:dragging
  role="group"
  aria-label="Signed document upload"
  ondragover={(event) => {
    event.preventDefault();
    if (!disabled) dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(event) => {
    event.preventDefault();
    dragging = false;
    select(event.dataTransfer?.files ?? null);
  }}
>
  <button class="primary-button" {disabled} onclick={() => input?.click()}
    ><Glyph name="plus" size={16} />{label}</button
  >
  <input
    bind:this={input}
    hidden
    type="file"
    accept=".pdf,application/pdf"
    aria-label="Signed document"
    onchange={(event) => {
      select(event.currentTarget.files);
      event.currentTarget.value = '';
    }}
  />
  <p>Choose or drop a document from this demo issuer.</p>
</div>

<style>
  .document-drop {
    display: grid;
    justify-items: center;
    gap: 9px;
    padding: 15px 22px;
    border: 1px dashed transparent;
    border-radius: 18px;
  }
  .document-drop.dragging {
    border-color: var(--p-accent);
    background: var(--p-accent-soft);
  }
  p {
    margin: 0;
    color: var(--p-muted);
    font-size: 11px;
  }
</style>
