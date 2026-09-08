<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { createPreviewSession } from '../application/preview-session';
  import { failures, type Event, type Role } from '../domain/journey';
  import { sampleDigest } from '../adapters/sample-request';
  import VariantOrbit from '../prototype/VariantOrbit.svelte';
  import VariantWorkbench from '../prototype/VariantWorkbench.svelte';
  import VariantPassport from '../prototype/VariantPassport.svelte';
  import PrototypeSwitcher from '../prototype/PrototypeSwitcher.svelte';
  import Glyph from '../prototype/Glyph.svelte';
  import {
    readVariant,
    stageCopy,
    type Variant,
    type InspectorTab,
  } from '../prototype/visual-model';
  import PreviewInspector from './PreviewInspector.svelte';
  const session = createPreviewSession();
  let snapshot = $state(session.read());
  let journey = $derived(snapshot.journey);
  let discoveries = $derived(snapshot.discoveries);
  let discoveryNotice = $derived(snapshot.discoveryNotice);
  let role = $derived(snapshot.role);
  let error = $derived(snapshot.error);
  let digest = $derived(sampleDigest(journey.amountMg));
  let variant = $state<Variant>('A');
  let panel: HTMLElement;
  let inspector: { open(tab: InspectorTab): void; close(): void };
  onMount(() => {
    const unsubscribe = session.subscribe((next) => {
      snapshot = next;
    });
    const sync = () => {
      variant = readVariant(
        new URL(window.location.href).searchParams.get('variant'),
      );
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', sync);
    };
  });
  function changeVariant(next: Variant) {
    variant = next;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    replaceState(url, page.state);
  }
  async function focusPanel() {
    await tick();
    panel?.focus({ preventScroll: true });
  }
  function changeRole(next: Role) {
    session.setRole(next);
    void focusPanel();
  }
  function inspect(tab: InspectorTab) {
    inspector.open(tab);
  }
  function act(event: Event) {
    const previous = session.read().journey.stage;
    session.dispatch(event);
    if (previous !== session.read().journey.stage) void focusPanel();
  }
  function scenario(events: Event[]) {
    for (const event of events) {
      if (!session.dispatch(event)) break;
    }
    inspector.close();
    void focusPanel();
  }
</script>

<a class="skip-link" href="#journey">Skip to journey</a>
<div class="play-shell" data-variant={variant} data-stage={journey.stage}>
  <span class="sr-only" aria-live="polite" aria-atomic="true"
    >{discoveryNotice}</span
  >
  <header class="play-header">
    <a class="play-brand" href="/" aria-label="Ultratokenizer home"
      ><span>u</span>ultratokenizer<i>.</i></a
    ><span class="play-demo"><i></i>Demo · no real proof or mint</span>
    <div class="play-tools">
      <nav class="play-roles" aria-label="Preview role">
        <button
          class:active={role === 'holder'}
          aria-pressed={role === 'holder'}
          onclick={() => changeRole('holder')}>Holder</button
        ><button
          class:active={role === 'issuer'}
          aria-pressed={role === 'issuer'}
          onclick={() => changeRole('issuer')}>Test issuer</button
        >
      </nav>
      <button
        class="p-icon"
        aria-label="Inspect details"
        onclick={() => inspect('request')}><Glyph name="eye" /></button
      >
    </div>
  </header>
  <main id="journey" tabindex="-1" bind:this={panel} class="play-main">
    <span class="sr-only" aria-live="polite"
      >{stageCopy[journey.stage].label} step. Simulation only.</span
    >
    {#if error || journey.failure}<div class="play-error" role="alert">
        <span
          ><strong
            >{error ||
              (journey.failure && failures[journey.failure].title)}</strong
          >{#if journey.failure}<small
              >{failures[journey.failure].recovery}</small
            >{/if}</span
        ><span class="failure-label">Sample</span>
      </div>{/if}
    {#if variant === 'A'}<VariantOrbit
        {journey}
        {discoveries}
        {role}
        onaction={act}
        onrole={changeRole}
        oninspect={inspect}
      />
    {:else if variant === 'B'}<VariantWorkbench
        {journey}
        {role}
        onaction={act}
        onrole={changeRole}
        oninspect={inspect}
      />
    {:else}<VariantPassport
        {journey}
        {role}
        onaction={act}
        onrole={changeRole}
        oninspect={inspect}
      />{/if}
  </main>
  <footer class="play-footer">
    <button class="p-text" onclick={() => inspect('privacy')}
      ><Glyph name="lock" size={13} />Private by design</button
    ><span>Synthetic gold · No asset backing</span><button
      class="p-text"
      onclick={() => act({ type: 'reset' })}
      ><Glyph name="reset" size={13} />Reset</button
    >
  </footer>
  <a class="verifier-link" href="/verify/"
    >Independent receipt verifier <Glyph name="arrow" size={13} /></a
  >
  <PrototypeSwitcher current={variant} onchange={changeVariant} />
</div>

<PreviewInspector
  bind:this={inspector}
  {journey}
  {discoveries}
  {discoveryNotice}
  {digest}
  onscenario={scenario}
  onreceiptchecked={session.receiptChecked}
/>
