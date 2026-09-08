<script lang="ts">
  import Artifact from './Artifact.svelte';
  import OrbitField from './OrbitField.svelte';
  import StageControls from './StageControls.svelte';
  import { sequence, stageCopy, type FlowProps } from './visual-model';
  import Glyph from './Glyph.svelte';
  import { discoveryCount, type Discoveries } from '../domain/discoveries';
  import ReceiptBloom from './ReceiptBloom.svelte';
  let props: FlowProps & { discoveries: Discoveries } = $props();
  let current = $derived(sequence.indexOf(props.journey.stage));
  let found = $derived(discoveryCount(props.discoveries));
</script>

<div class="orbit-layout">
  <div class="orbit-title">
    <div class="orbit-eyebrow">
      <span class="p-overline"
        >{props.role === 'issuer' ? 'Test issuer' : 'Document → token'}</span
      >
      <span class="orbit-count" aria-hidden="true"
        >0{current + 1}<span>/ 06</span></span
      >
    </div>
    {#key props.journey.stage}
      <div class="orbit-copy">
        <h1>
          {#if props.journey.stage === 'document'}Your gold. <em>A new form.</em
            >{:else}{stageCopy[props.journey.stage].title}{/if}
        </h1>
        <p>{stageCopy[props.journey.stage].hint}</p>
      </div>
    {/key}
  </div>
  <div class="orbit-arena">
    {#if props.journey.receipt === 'simulated'}<ReceiptBloom />{/if}
    <OrbitField stage={props.journey.stage} />
    <div class="orbit-path" aria-hidden="true"></div>
    <div class="orbit-path inner" aria-hidden="true"></div>
    <ol class="orbital-steps" aria-label="Journey progress">
      {#each sequence as step, index}<li
          class:current={index === current}
          class:done={index < current || props.journey.receipt === 'simulated'}
          style={`--node: ${index};`}
          aria-current={index === current ? 'step' : undefined}
        >
          <span class="orbit-node"
            >{#if index < current || props.journey.receipt === 'simulated'}<Glyph
                name="check"
                size={15}
              />{:else}<span>{index + 1}</span>{/if}</span
          ><span class="orbit-label">{stageCopy[step].label}</span>
        </li>{/each}
    </ol>
    <div class="orbit-artifact">
      <Artifact
        refined
        journey={props.journey}
        interactive={props.journey.stage === 'document' &&
          props.role === 'holder'}
        onselect={() =>
          props.onaction({ type: 'load_sample', scenario: 'supported' })}
      />
    </div>
    <div class="orbit-metadata">
      <span><i></i> GOLD / XAU</span><span
        ><Glyph name="lock" size={12} />Private source</span
      >
    </div>
  </div>
  {#key `${props.journey.stage}:${props.journey.stage === 'authorization' ? props.role : ''}`}
    <StageControls {...props} refined />
  {/key}
  <button
    class="discovery-dock"
    onclick={() => props.oninspect('discoveries')}
    aria-label={`Explore discoveries, ${found} of 3 stamps collected`}
  >
    <span class="discovery-minis" aria-hidden="true">
      {#each Object.values(props.discoveries) as collected}<i class:collected
          >{#if collected}<Glyph name="check" size={10} />{:else}<span
            ></span>{/if}</i
        >{/each}
    </span>
    {#key found}<span class="discovery-dock-label">{found} / 3 discoveries</span
      >{/key}
    <Glyph name="plus" size={13} />
  </button>
</div>
