<div class="receipt-bloom" aria-hidden="true">
  <span class="bloom-ring"></span>
  {#each Array.from({ length: 8 }) as _, index}<i style={`--spark: ${index}`}
      ><span></span></i
    >{/each}
</div>

<style>
  .receipt-bloom {
    position: absolute;
    width: 300px;
    height: 300px;
    pointer-events: none;
  }
  .bloom-ring {
    position: absolute;
    inset: 18px;
    border: 1px solid #b4aa7480;
    border-radius: 50%;
    animation: bloom-ring 1.3s ease-out both;
  }
  i {
    position: absolute;
    inset: 0;
    transform: rotate(calc(var(--spark) * 45deg));
  }
  i > span {
    display: block;
    margin: 0 auto;
    width: 4px;
    height: 9px;
    border-radius: 3px;
    background: #b8a264;
    animation: bloom-spark 1.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes bloom-ring {
    from {
      transform: scale(0.65);
      opacity: 0;
    }
    25% {
      opacity: 0.7;
    }
    to {
      transform: scale(1.3);
      opacity: 0;
    }
  }
  @keyframes bloom-spark {
    from {
      transform: translateY(55px) scale(0.4);
      opacity: 0;
    }
    25% {
      opacity: 0.7;
    }
    to {
      transform: translateY(-24px) scale(0.2);
      opacity: 0;
    }
  }
  @media (max-width: 640px) {
    .receipt-bloom {
      width: 220px;
      height: 220px;
      top: 19px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .receipt-bloom {
      display: none;
    }
  }
</style>
