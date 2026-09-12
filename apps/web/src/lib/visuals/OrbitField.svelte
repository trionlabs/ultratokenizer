<script lang="ts">
  let {
    stage,
  }: {
    stage:
      'document' | 'review' | 'authorization' | 'proof' | 'mint' | 'receipt';
  } = $props();
</script>

<div class="orbit-field" data-phase={stage} aria-hidden="true">
  <span class="orbit-path outer"></span>
  <span class="orbit-path inner"></span>
  <span class="orbit-path crossing"></span>
</div>

<style>
  .orbit-field {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    z-index: -1;
  }
  .orbit-path {
    position: absolute;
    width: 390px;
    height: 220px;
    border: 1px solid #b6a7cb35;
    border-radius: 50%;
    transform: rotate(-27deg);
    transition:
      transform 1.2s cubic-bezier(0.2, 0.8, 0.2, 1),
      width 1.2s,
      height 1.2s;
  }
  .inner {
    width: 285px;
    height: 310px;
    transform: rotate(34deg);
    border-color: #b6a7cb27;
  }
  .crossing {
    width: 335px;
    height: 245px;
    transform: rotate(57deg);
    border-color: #b6a7cb20;
  }
  .outer::after {
    content: '';
    position: absolute;
    width: 4px;
    height: 4px;
    top: 42px;
    left: 34px;
    border-radius: 50%;
    background: #a695bb;
  }
  [data-phase='review'] .outer {
    transform: rotate(-15deg);
  }
  [data-phase='proof'] .outer,
  [data-phase='mint'] .outer {
    transform: rotate(10deg);
  }
  [data-phase='proof'] .inner,
  [data-phase='mint'] .inner {
    transform: rotate(85deg);
  }
  [data-phase='receipt'] .orbit-path {
    width: 290px;
    height: 290px;
    transform: rotate(180deg);
  }
  [data-phase='receipt'] .inner {
    width: 318px;
    height: 318px;
    transform: rotate(240deg);
  }
  [data-phase='receipt'] .crossing {
    width: 350px;
    height: 350px;
  }
  @media (max-width: 640px) {
    .orbit-field {
      scale: 0.6;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .orbit-path {
      transition: none;
    }
  }
</style>
