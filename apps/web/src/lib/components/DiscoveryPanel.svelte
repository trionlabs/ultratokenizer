<script lang="ts">
  import type { Discoveries } from '../domain/discoveries';
  import { discoveryCount } from '../domain/discoveries';
  import type { Journey } from '../domain/journey';
  import Glyph from '../prototype/Glyph.svelte';
  let {
    discoveries,
    journey,
    onstart,
    onedited,
    onrejection,
    onreceipt,
  }: {
    discoveries: Discoveries;
    journey: Journey;
    onstart: () => void;
    onedited: () => void;
    onrejection: () => void;
    onreceipt: () => void;
  } = $props();
</script>

<div class="discovery-intro">
  <span class="discovery-total"
    >{discoveryCount(discoveries)}<small>/ 3</small></span
  >
  <div>
    <h3>Three small discoveries.</h3>
    <p>Explore the flow. Collect session stamps.</p>
  </div>
</div>
<div class="discovery-cards">
  <section class:collected={discoveries.orbit}>
    <span class="discovery-emblem"
      ><Glyph name={discoveries.orbit ? 'check' : 'eye'} size={25} /></span
    >
    <div>
      <h4>First orbit</h4>
      <p>Complete a sample, then recalculate its request digest.</p>
      <span class="discovery-state"
        >{discoveries.orbit ? 'Stamp collected' : 'Ready to explore'}</span
      >
    </div>
    {#if journey.receipt === 'simulated'}<button
        class="p-text"
        onclick={onreceipt}
        >Check receipt <Glyph name="arrow" size={15} /></button
      >{:else}<button class="p-text" onclick={onstart}
        >{journey.stage === 'document' ? 'Start sample' : 'Restart sample'}
        <Glyph name="arrow" size={15} /></button
      >{/if}
  </section>
  <section class:collected={discoveries.integrity}>
    <span class="discovery-emblem"
      ><Glyph
        name={discoveries.integrity ? 'check' : 'shield'}
        size={25}
      /></span
    >
    <div>
      <h4>Catch the edit</h4>
      <p>See an edited sample stop at the document gate.</p>
      <span class="discovery-state"
        >{discoveries.integrity
          ? 'Stamp collected'
          : 'Starts a fresh sample'}</span
      >
    </div>
    <button class="p-text" onclick={onedited}
      >Try edited sample <Glyph name="arrow" size={15} /></button
    >
  </section>
  <section class:collected={discoveries.recovery}>
    <span class="discovery-emblem"
      ><Glyph name={discoveries.recovery ? 'check' : 'reset'} size={25} /></span
    >
    <div>
      <h4>Find your way back</h4>
      <p>Reject a sample proof, then retry the unchanged request.</p>
      <span class="discovery-state"
        >{discoveries.recovery
          ? 'Stamp collected'
          : journey.stage === 'proof'
            ? 'Ready at this step'
            : 'Available at the proof step'}</span
      >
    </div>
    <button
      class="p-text"
      disabled={journey.stage !== 'proof'}
      onclick={onrejection}
      >Try rejection <Glyph name="arrow" size={15} /></button
    >
  </section>
</div>
<p class="discovery-note">
  Learning progress only. Stamps last for this tab session and reset on refresh.
  Starting a sample replaces the current journey.
</p>
