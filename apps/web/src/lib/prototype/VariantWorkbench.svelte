<script lang="ts">
  import Artifact from './Artifact.svelte';
  import StageControls from './StageControls.svelte';
  import { sequence, stageCopy, type FlowProps } from './visual-model';
  import Glyph from './Glyph.svelte';
  let props: FlowProps = $props();
  let current = $derived(sequence.indexOf(props.journey.stage));
</script>

<div class="bench-layout">
  <section class="bench-chamber" aria-label="Document transformation">
    <div class="bench-readout">
      <span>CHAMBER 01</span><span
        ><i></i>
        {props.journey.stage === 'receipt'
          ? 'SAMPLE COMPLETE'
          : 'AWAITING INPUT'}</span
      >
    </div>
    <div class="bench-scene">
      <div class="bench-bracket a"></div>
      <div class="bench-bracket b"></div>
      <div class="bench-bracket c"></div>
      <div class="bench-bracket d"></div>
      <span class="bench-cross" aria-hidden="true">+</span><Artifact
        journey={props.journey}
        interactive={props.journey.stage === 'document' &&
          props.role === 'holder'}
        onselect={() =>
          props.onaction({ type: 'load_sample', scenario: 'supported' })}
      />
      <div class="bench-floor"></div>
    </div>
    <div class="bench-source">
      <span>XAU</span><span
        >PRIVATE INPUT <Glyph name="arrow" size={13} /> PUBLIC CLAIM</span
      ><span>01—06</span>
    </div>
  </section>
  <section class="bench-console">
    <div class="console-top">
      <span class="p-overline"
        >{props.role === 'issuer'
          ? 'Issuer controls'
          : 'Transformation controls'}</span
      ><span class="console-count">0{current + 1}<small>/06</small></span>
    </div>
    <h1>{stageCopy[props.journey.stage].title}</h1>
    <p class="console-hint">{stageCopy[props.journey.stage].hint}</p>
    <StageControls {...props} />
    <ol class="bench-progress" aria-label="Journey progress">
      {#each sequence as step, index}<li
          class:current={index === current}
          class:done={index < current}
          aria-current={index === current ? 'step' : undefined}
        >
          <span></span><small>{stageCopy[step].label}</small>
        </li>{/each}
    </ol>
  </section>
</div>
