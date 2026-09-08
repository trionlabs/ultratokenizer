<script lang="ts">
  import { Spring, prefersReducedMotion } from 'svelte/motion';
  import { formatGrams, type Journey } from '../domain/journey';
  import Glyph from './Glyph.svelte';
  let {
    journey,
    onselect,
    interactive = false,
    refined = false,
  }: {
    journey: Journey;
    onselect?: () => void;
    interactive?: boolean;
    refined?: boolean;
  } = $props();
  const tilt = new Spring({ x: 0, y: 0 }, { stiffness: 0.12, damping: 0.7 });
  let coin = $derived(journey.stage === 'mint' || journey.stage === 'receipt');
  let sealed = $derived(['proof', 'mint', 'receipt'].includes(journey.stage));
  function move(event: PointerEvent) {
    if (prefersReducedMotion.current || event.pointerType !== 'mouse') return;
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : null;
    if (!rect) return;
    tilt.target = {
      x: (0.5 - (event.clientY - rect.top) / rect.height) * 11,
      y: ((event.clientX - rect.left) / rect.width - 0.5) * 14,
    };
  }
</script>

<button
  class="artifact-scene"
  class:is-coin={coin}
  class:is-sealed={sealed}
  class:selectable={interactive}
  class:refined
  disabled={!interactive}
  onclick={onselect}
  onpointermove={move}
  onpointerleave={() => {
    tilt.target = { x: 0, y: 0 };
  }}
  aria-label={interactive
    ? 'Select sample gold document'
    : `Synthetic ${coin ? 'token' : journey.reviewed ? 'gold request' : 'gold document'}`}
  style={`--tilt-x: ${prefersReducedMotion.current ? 0 : tilt.current.x}deg; --tilt-y: ${prefersReducedMotion.current ? 0 : tilt.current.y}deg; --light-x: ${prefersReducedMotion.current ? 50 : 50 + tilt.current.y * 4}%; --light-y: ${prefersReducedMotion.current ? 35 : 35 - tilt.current.x * 4}%;`}
>
  <span class="artifact-shadow"></span>
  <span class="artifact-body">
    <span class="document-face">
      <span class="document-top"
        ><span class="document-brand">u.</span><span class="document-code"
          >XAU / 001</span
        ></span
      >
      <span class="document-title"
        >Gold<br />{journey.reviewed ? 'request' : 'statement'}</span
      >
      {#if refined}<span class="document-watermark" aria-hidden="true">Au</span
        >{/if}
      <span class="document-rule"></span><span class="document-rule short"
      ></span>
      <span class="document-bottom"
        ><strong
          >{journey.reviewed ? formatGrams(journey.amountMg) : '10.000'}
          <small>g</small></strong
        ><span>SAMPLE</span></span
      >
    </span>
    <span class="coin-face"
      ><span class="coin-ring"></span><span class="coin-top"
        >ULTRATOKENIZER</span
      ><strong>Au</strong><span class="coin-amount"
        >{formatGrams(journey.amountMg)} g</span
      ><span class="coin-bottom">SAMPLE · NO ASSETS</span></span
    >
    <span class="artifact-shine"></span>
    {#if refined}<span class="artifact-edge" aria-hidden="true"></span>{/if}
  </span>
  <span class="artifact-seal"><Glyph name="shield" size={23} /></span>
  {#if interactive}<span class="artifact-add"
      ><Glyph name="plus" size={18} /></span
    >{/if}
</button>

<style>
  .artifact-scene {
    transform: scale(var(--artifact-scale, 1));
    transform-origin: center;
    position: relative;
    display: block;
    width: 270px;
    height: 318px;
    padding: 0;
    border: 0;
    background: transparent;
    perspective: 1000px;
    cursor: default;
    color: #314b39;
    opacity: 1 !important;
    -webkit-tap-highlight-color: transparent;
  }
  .artifact-scene.selectable {
    cursor: pointer;
  }
  .refined .artifact-body {
    background:
      radial-gradient(ellipse at 12% 3%, #fffefa, transparent 70%),
      linear-gradient(155deg, #fdfcf4, #ede9d9);
  }
  .refined .document-face {
    background-image: repeating-linear-gradient(
      0deg,
      #74644304 0 1px,
      transparent 1px 3px
    );
  }
  .document-watermark {
    position: absolute;
    top: 69px;
    right: 14px;
    font:
      italic 106px/1 Georgia,
      serif;
    color: #9685530c;
    transform: rotate(7deg);
    pointer-events: none;
  }
  .refined .artifact-shine {
    background: radial-gradient(
      ellipse at var(--light-x) var(--light-y),
      #fffef78c 0%,
      #dcdce719 35%,
      transparent 70%
    );
    mix-blend-mode: soft-light;
  }
  .artifact-edge {
    position: absolute;
    inset: 7px;
    border: 1px solid #9b8b5520;
    border-radius: inherit;
    pointer-events: none;
  }
  .refined .artifact-add {
    background: linear-gradient(145deg, #456f53, #254e36);
    box-shadow:
      0 3px 12px #253b2b24,
      inset 0 1px 1px #ffffff40;
    transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .refined.selectable:hover .artifact-add {
    transform: rotate(90deg);
  }
  .refined.selectable:active .artifact-add {
    transform: rotate(90deg) scale(0.93);
  }
  .artifact-scene:focus-visible {
    outline: 2px solid var(--p-accent, #24633e);
    outline-offset: 15px;
    border-radius: 18px;
  }
  .artifact-body {
    position: absolute;
    left: 25px;
    top: 13px;
    width: 220px;
    height: 282px;
    border-radius: 12px;
    background: linear-gradient(140deg, #fffefa, #f1efe3);
    box-shadow:
      0 0 0 1px #e0dfd4,
      0 8px 1px -3px #e7e4d7,
      0 9px 0 -2px #d9d7c7,
      0 30px 48px -23px #35422345;
    transform: rotateX(var(--tilt-x)) rotateY(var(--tilt-y)) rotate(-7deg);
    transition:
      width 0.7s cubic-bezier(0.2, 0.8, 0.2, 1),
      height 0.7s cubic-bezier(0.2, 0.8, 0.2, 1),
      top 0.7s cubic-bezier(0.2, 0.8, 0.2, 1),
      border-radius 0.7s cubic-bezier(0.2, 0.8, 0.2, 1),
      background 0.4s,
      box-shadow 0.7s;
    overflow: hidden;
  }
  .selectable:hover .artifact-body {
    box-shadow:
      0 0 0 1px #bacaae,
      0 8px 1px -3px #e7e4d7,
      0 9px 0 -2px #d9d7c7,
      0 36px 56px -23px #35422360;
  }
  .document-face {
    position: absolute;
    inset: 0;
    padding: 22px;
    display: flex;
    flex-direction: column;
    text-align: left;
    transition:
      opacity 0.25s,
      transform 0.5s;
  }
  .document-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .document-brand {
    font-family: 'Manrope', sans-serif;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -2px;
  }
  .document-code {
    font-size: 8px;
    letter-spacing: 1px;
    color: #909483;
  }
  .document-title {
    font-family: 'Manrope', sans-serif;
    font-size: 27px;
    letter-spacing: -1.1px;
    line-height: 1.18;
    font-weight: 650;
    margin: 24px 0 21px;
  }
  .document-rule {
    width: 100%;
    height: 3px;
    background: #e4e6da;
    margin-bottom: 6px;
  }
  .document-rule.short {
    width: 64%;
  }
  .document-bottom {
    margin-top: auto;
    border-top: 1px solid #e1e1d4;
    padding-top: 16px;
    display: flex;
    align-items: end;
    justify-content: space-between;
  }
  .document-bottom strong {
    font-size: 21px;
    font-weight: 500;
    letter-spacing: -0.8px;
  }
  .document-bottom small {
    font-size: 13px;
    font-weight: 400;
  }
  .document-bottom > span {
    font-size: 7px;
    letter-spacing: 1px;
    line-height: 2;
    color: #8b927c;
  }
  .artifact-shine {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      130deg,
      #ffffff00 25%,
      #ffffff40 47%,
      #ffffff00 66%
    );
    pointer-events: none;
  }
  .artifact-shadow {
    position: absolute;
    left: 30px;
    right: 30px;
    bottom: 5px;
    height: 20px;
    border-radius: 50%;
    background: #4957441e;
    filter: blur(13px);
    transition: all 0.7s;
  }
  .artifact-add {
    position: absolute;
    right: 8px;
    bottom: 27px;
    display: grid;
    place-items: center;
    width: 43px;
    height: 43px;
    background: var(--p-accent, #24633e);
    color: #fff;
    border: 5px solid var(--p-bg, #f5f7ef);
    border-radius: 50%;
    box-shadow: 0 6px 12px #1b332214;
  }
  .artifact-seal {
    position: absolute;
    right: 10px;
    bottom: 20px;
    width: 58px;
    height: 58px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #546830;
    background: #dfe7bb;
    border: 5px solid var(--p-bg, #f5f7ef);
    box-shadow: 0 5px 15px #293d2520;
    opacity: 0;
    transform: scale(0.4) rotate(-35deg);
    transition: all 0.5s cubic-bezier(0.2, 1.4, 0.3, 1);
  }
  .is-sealed .artifact-seal {
    opacity: 1;
    transform: scale(1) rotate(9deg);
  }
  .is-coin .artifact-body {
    top: 41px;
    height: 220px;
    border-radius: 50%;
    background: linear-gradient(
      135deg,
      #f0e6bc 0%,
      #c9ab62 22%,
      #f6e9b5 44%,
      #d6ba73 64%,
      #b39554 100%
    );
    box-shadow:
      inset 0 0 0 2px #fff9ce,
      0 1px 0 #b89b50,
      0 3px 0 #c5a961,
      0 5px 0 #a3894b,
      0 8px 0 #ae9453,
      0 22px 33px -13px #8a6e4155;
  }
  .is-coin .document-face {
    opacity: 0;
    transform: scale(0.7) rotate(30deg);
  }
  .coin-face {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    color: #836422;
    text-shadow: 0 1px 0 #fff8cd;
    opacity: 0;
    transform: scale(0.6) rotate(-30deg);
    transition:
      opacity 0.4s 0.1s,
      transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .is-coin .coin-face {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
  .coin-ring {
    position: absolute;
    inset: 12px;
    border: 1px dashed #aa883c;
    border-radius: 50%;
    box-shadow:
      0 0 0 5px #edd79650,
      inset 0 0 0 6px #e0c78040;
  }
  .coin-face > strong {
    font-family: Georgia, serif;
    font-weight: 400;
    font-size: 81px;
    letter-spacing: -6px;
    line-height: 1;
    position: relative;
    margin-left: -4px;
  }
  .coin-top {
    font-size: 8px;
    letter-spacing: 2px;
    position: absolute;
    top: 35px;
  }
  .coin-bottom {
    position: absolute;
    bottom: 34px;
    font-size: 7px;
    letter-spacing: 1.1px;
  }
  .coin-amount {
    font-size: 13px;
    margin-top: 3px;
    font-weight: 500;
  }
  .is-coin .artifact-seal {
    right: 5px;
    bottom: 39px;
  }
  .is-coin .artifact-shadow {
    bottom: 26px;
    left: 46px;
    right: 35px;
    opacity: 0.7;
  }
  @media (max-width: 640px) {
    .artifact-scene {
      transform: scale(var(--artifact-scale, 0.78));
      transform-origin: center;
      width: 270px;
      height: 285px;
      margin: -20px auto -15px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .artifact-body,
    .artifact-seal,
    .document-face,
    .coin-face,
    .artifact-shadow {
      transition: none !important;
    }
    .artifact-body {
      transform: rotate(-7deg);
    }
  }
</style>
