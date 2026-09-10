<script lang="ts">
  let {
    stage,
  }: {
    stage:
      'document' | 'review' | 'authorization' | 'proof' | 'mint' | 'receipt';
  } = $props();
</script>

<!-- Decorative optics follow the visible stage, never proof validity. -->
<div class="orbit-field" data-phase={stage} aria-hidden="true">
  <div class="field-wash"></div>
  <div class="field-aperture">
    {#each Array.from({ length: 6 }) as _, index}
      <span style={`--petal: ${index}`}></span>
    {/each}
  </div>
  <span class="field-point a"></span>
  <span class="field-point b"></span>
  <span class="field-point c"></span>
</div>

<style>
  .orbit-field {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    --field-size: 300px;
  }
  .field-wash {
    position: absolute;
    width: 460px;
    height: 380px;
    border-radius: 50%;
    background:
      radial-gradient(ellipse at 35% 35%, #e8e5c975, transparent 60%),
      radial-gradient(ellipse at 65% 60%, #d3dfd063, transparent 64%);
    filter: blur(20px);
    transition:
      transform 1s,
      opacity 1s;
  }
  .field-aperture {
    position: relative;
    width: var(--field-size);
    height: var(--field-size);
    opacity: 0.5;
    transform: rotate(-12deg);
    transition:
      transform 1.1s cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 0.7s;
  }
  .field-aperture span {
    position: absolute;
    inset: 8%;
    border-radius: 42% 58% 48% 52%;
    border: 1px solid #869b6b20;
    border-top-color: #b5a57342;
    transform: rotate(calc(var(--petal) * 60deg)) translateY(-20px);
  }
  [data-phase='review'] .field-aperture {
    transform: scale(0.67) rotate(25deg);
    opacity: 0.28;
  }
  [data-phase='authorization'] .field-aperture {
    transform: rotate(45deg);
  }
  [data-phase='proof'] .field-aperture {
    transform: scale(0.92) rotate(90deg);
  }
  [data-phase='mint'] .field-aperture {
    transform: scale(1.05) rotate(135deg);
    opacity: 0.8;
  }
  [data-phase='receipt'] .field-aperture {
    transform: scale(1.15) rotate(180deg);
    opacity: 0.7;
  }
  [data-phase='receipt'] .field-wash {
    transform: scale(1.16);
  }
  .field-point {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: #ad986359;
    box-shadow: 0 0 0 4px #b5a46d08;
  }
  .a {
    left: 20%;
    top: 18%;
  }
  .b {
    right: 17%;
    bottom: 28%;
  }
  .c {
    right: 31%;
    top: 4%;
    width: 2px;
    height: 2px;
  }
  @media (max-width: 640px) {
    .orbit-field {
      --field-size: 215px;
      bottom: 35px;
    }
    .field-wash {
      width: 290px;
      height: 270px;
    }
    .field-point {
      display: none;
    }
    [data-phase='review'] {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .field-aperture,
    .field-wash {
      transition: none;
    }
  }
</style>
