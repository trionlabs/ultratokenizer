<script lang="ts">
  import Artifact from './Artifact.svelte';
  import StageControls from './StageControls.svelte';
  import { sequence, stageCopy, type FlowProps } from './visual-model';
  import Glyph from './Glyph.svelte';
  let props: FlowProps = $props();
  let current = $derived(sequence.indexOf(props.journey.stage));
</script>

<div class="passport-layout">
  <div class="passport-intro">
    <span class="p-overline">Your asset passport</span>
    <h1>A little less paper.<br /><em>A little more possibility.</em></h1>
    <p>One private document. One inspectable claim.</p>
  </div>
  <section class="passport-ticket">
    <span class="ticket-behind" aria-hidden="true"></span>
    <div class="ticket-top">
      <span>ULTRATOKENIZER</span><span>№ 0001 / SAMPLE</span>
    </div>
    <div class="ticket-main">
      <div class="ticket-visual">
        <Artifact
          journey={props.journey}
          interactive={props.journey.stage === 'document' &&
            props.role === 'holder'}
          onselect={() =>
            props.onaction({ type: 'load_sample', scenario: 'supported' })}
        />
        <div class="ticket-stamp">
          {props.journey.stage === 'receipt'
            ? 'SAMPLE COMPLETE'
            : 'PRIVATE ORIGINAL'}<Glyph name="lock" size={12} />
        </div>
      </div>
      <div class="ticket-controls">
        <span class="p-overline"
          >0{current + 1} / {props.role === 'issuer'
            ? 'Test issuer'
            : stageCopy[props.journey.stage].label}</span
        >
        <h2>{stageCopy[props.journey.stage].title}</h2>
        <StageControls {...props} />
      </div>
    </div>
    <div class="ticket-perforation" aria-hidden="true"></div>
    <ol class="passport-stamps" aria-label="Journey progress">
      {#each sequence as step, index}<li
          class:current={index === current}
          class:done={index < current}
          aria-current={index === current ? 'step' : undefined}
        >
          <span
            >{#if index < current}<Glyph
                name="check"
                size={17}
              />{:else}0{index + 1}{/if}</span
          ><small>{stageCopy[step].label}</small>
        </li>{/each}
    </ol>
  </section>
</div>
