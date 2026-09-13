<script module lang="ts">
  /**
   * The artifact's own vocabulary for a verification run. Callers map their
   * backend statuses onto it, so the visual never has to know them.
   */
  export type ProofStage =
    | 'waiting'
    | 'preparing'
    | 'queued'
    | 'proving'
    | 'checking'
    | 'authorizing'
    | 'ready'
    | 'attention';

  const stageCaption: Record<ProofStage, string> = {
    waiting: 'Awaiting your approval',
    preparing: 'Preparing the request',
    queued: 'Waiting for SP1',
    proving: 'SP1 proof in progress',
    checking: 'Checking the returned proof',
    authorizing: 'Requesting issuer approval',
    ready: 'Ready to mint',
    attention: 'Needs attention',
  };

  // Which stages are the service working, rather than waiting on a person.
  const stageWorking: Record<ProofStage, boolean> = {
    waiting: false,
    preparing: true,
    queued: true,
    proving: true,
    checking: true,
    authorizing: true,
    ready: false,
    attention: false,
  };

  // The orbit advances with the run instead of sitting still for all of it.
  const stageOrbit: Record<ProofStage, 'review' | 'proof' | 'authorization'> = {
    waiting: 'review',
    preparing: 'review',
    queued: 'proof',
    proving: 'proof',
    checking: 'proof',
    authorizing: 'authorization',
    ready: 'authorization',
    attention: 'review',
  };
</script>

<script lang="ts">
  import { Spring, prefersReducedMotion } from 'svelte/motion';
  import Glyph from './Glyph.svelte';
  import OrbitField from './OrbitField.svelte';
  let {
    configured,
    amount,
    verified,
    minted,
    outcome,
    emptyCaption,
    proofStage,
    compact = false,
  }: {
    configured: boolean;
    amount?: string;
    verified: boolean;
    minted: boolean;
    outcome?: string;
    emptyCaption?: string;
    proofStage?: ProofStage;
    compact?: boolean;
  } = $props();
  const tilt = new Spring({ x: 0, y: 0 }, { stiffness: 0.1, damping: 0.75 });
  // A run the service is working shows as `working`, so the artifact keeps
  // moving through the long middle of the flow instead of resting on `loaded`.
  let working = $derived(
    !minted &&
      !outcome &&
      !verified &&
      !!proofStage &&
      stageWorking[proofStage],
  );
  let state = $derived(
    minted
      ? 'minted'
      : outcome
        ? outcome
        : verified
          ? 'verified'
          : working
            ? 'working'
            : amount
              ? 'loaded'
              : 'empty',
  );
  let caption = $derived(
    minted
      ? 'Mint confirmed'
      : outcome === 'reverted'
        ? 'Mint reverted'
        : outcome === 'unresolved'
          ? 'Outcome unresolved'
          : outcome
            ? 'Awaiting confirmation'
            : verified
              ? 'Proof verified'
              : proofStage
                ? stageCaption[proofStage]
                : amount
                  ? 'Ready to verify'
                  : configured
                    ? (emptyCaption ?? 'Waiting for proof package')
                    : 'Proof becomes token',
  );
  function move(event: PointerEvent) {
    if (prefersReducedMotion.current || event.pointerType !== 'mouse') return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    tilt.target = {
      x: (0.5 - (event.clientY - rect.top) / rect.height) * 9,
      y: ((event.clientX - rect.left) / rect.width - 0.5) * 12,
    };
  }
</script>

<!-- The paper represents a public proof package. Only a reconciled receipt produces a coin. -->
<div
  class="proof-object"
  class:compact
  data-state={state}
  aria-hidden="true"
  role="presentation"
  onpointermove={move}
  onpointerleave={() => (tilt.target = { x: 0, y: 0 })}
  style={`--tilt-x: ${prefersReducedMotion.current ? 0 : tilt.current.x}deg; --tilt-y: ${prefersReducedMotion.current ? 0 : tilt.current.y}deg;`}
>
  <OrbitField
    stage={minted
      ? 'receipt'
      : outcome
        ? 'mint'
        : verified
          ? 'proof'
          : proofStage
            ? stageOrbit[proofStage]
            : amount
              ? 'review'
              : 'document'}
  />
  <div class="artifact-lift">
    <div class="artifact-body" class:is-coin={minted}>
      <div class="proof-sheet">
        <div class="sheet-top"><b>u.</b><span>PROOF / XAU</span></div>
        <strong>Gold<br />right</strong>
        <div class="sheet-lines"><span></span><span></span><span></span></div>
        <div class="sheet-bottom">
          <span>{amount ? `${amount} g` : ''}</span><small
            >{amount ? 'EXACT AMOUNT' : ''}</small
          >
        </div>
      </div>
      <div class="coin-face">
        <span class="coin-ring"></span>
        {#if minted}
          <span class="coin-top">ULTRATOKENIZER</span>
          <strong>Au</strong><span class="coin-amount">{amount} g</span><small
            >MINT CONFIRMED</small
          >
        {/if}
      </div>
      <div class="artifact-edge"></div>
    </div>
    <span class="artifact-seal" class:visible={verified || minted}
      ><Glyph name="check" size={21} /></span
    >
  </div>
  <span class="artifact-caption"><i></i>{caption}</span>
</div>

<style>
  .proof-object {
    position: relative;
    height: 336px;
    width: 100%;
    display: grid;
    place-items: center;
    isolation: isolate;
    overflow: clip;
    perspective: 1000px;
  }
  .artifact-lift {
    position: absolute;
    top: calc(50% - 140px);
    left: calc(50% - 110px);
    width: 220px;
    height: 276px;
    animation: breathe 7s ease-in-out infinite;
  }
  .artifact-body {
    position: absolute;
    width: 210px;
    height: 256px;
    top: 4px;
    left: 5px;
    border-radius: 13px;
    background: #fdfcfe;
    box-shadow:
      0 0 0 1px #d9d6e2,
      0 5px 0 -1px #eeecf3,
      0 6px 0 -1px #d9d6e2,
      0 22px 32px -20px #51476555;
    transform: rotateX(var(--tilt-x)) rotateY(var(--tilt-y)) rotate(-7deg);
    transition:
      height 900ms cubic-bezier(0.22, 0.8, 0.22, 1),
      top 900ms,
      border-radius 900ms,
      background 900ms,
      box-shadow 900ms;
    overflow: hidden;
  }
  .proof-sheet {
    position: absolute;
    inset: 0;
    padding: 23px;
    display: flex;
    flex-direction: column;
    text-align: left;
    transition:
      opacity 300ms,
      transform 750ms;
  }
  .sheet-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--p-muted);
  }
  .sheet-top b {
    font-size: 25px;
    letter-spacing: -2px;
    color: var(--p-accent);
  }
  .sheet-top > span {
    font-size: 8px;
    letter-spacing: 1px;
  }
  .proof-sheet > strong {
    margin: 26px 0 21px;
    font-size: 27px;
    line-height: 1.12;
    font-weight: 550;
    letter-spacing: -1.1px;
  }
  .sheet-lines {
    display: grid;
    gap: 6px;
  }
  .sheet-lines span {
    height: 1px;
    background: #dfdce7;
  }
  .sheet-lines span:last-child {
    width: 60%;
  }
  .sheet-bottom {
    margin-top: auto;
    padding-top: 14px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
    border-top: 1px solid var(--p-line);
  }
  .sheet-bottom > span {
    font-size: 18px;
    letter-spacing: -0.7px;
  }
  .sheet-bottom > small {
    color: var(--p-muted);
    font-size: 6px;
    letter-spacing: 0.6px;
  }
  .artifact-edge {
    position: absolute;
    inset: 6px;
    border: 1px solid #84769c12;
    border-radius: inherit;
    pointer-events: none;
  }
  .artifact-seal {
    position: absolute;
    right: -9px;
    bottom: 20px;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 5px solid var(--p-canvas);
    border-radius: 50%;
    background: var(--p-accent);
    color: white;
    opacity: 0;
    transform: scale(0.3) rotate(-35deg);
    transition:
      opacity 400ms,
      transform 650ms cubic-bezier(0.2, 1.4, 0.3, 1);
  }
  .artifact-seal.visible {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
  .artifact-body.is-coin {
    top: 27px;
    height: 210px;
    border-radius: 50%;
    background: linear-gradient(
      135deg,
      #ede8f5,
      #b8aaca 28%,
      #e6deef 48%,
      #c2b5d2 72%,
      #aa99be
    );
    box-shadow:
      inset 0 0 0 2px #f3eff8,
      0 2px 0 #a294b2,
      0 4px 0 #c6b9d5,
      0 6px 0 #9b8bac,
      0 9px 0 #ab9bbb,
      0 24px 30px -18px #51476555;
  }
  .is-coin .proof-sheet {
    opacity: 0;
    transform: scale(0.65) rotate(25deg);
  }
  .coin-face {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    color: #635271;
    opacity: 0;
    transform: scale(0.6) rotate(-25deg);
    transition:
      opacity 450ms 150ms,
      transform 900ms cubic-bezier(0.22, 0.8, 0.22, 1);
  }
  .is-coin .coin-face {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
  .coin-ring {
    position: absolute;
    inset: 13px;
    border: 1px dashed #8a789c;
    border-radius: 50%;
    box-shadow:
      0 0 0 5px #e4dcee55,
      inset 0 0 0 5px #d2c5de44;
  }
  .coin-top {
    position: absolute;
    top: 35px;
    font-size: 7px;
    letter-spacing: 2px;
  }
  .coin-face > strong {
    font:
      74px/1 Georgia,
      serif;
    letter-spacing: -5px;
    margin-left: -4px;
    text-shadow: 0 1px #f3eff8;
  }
  .coin-amount {
    font-size: 13px;
    margin-top: 4px;
  }
  .coin-face > small {
    position: absolute;
    bottom: 33px;
    font-size: 6px;
    letter-spacing: 1.5px;
  }
  .artifact-caption {
    position: absolute;
    bottom: 3px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--p-muted);
    font-size: 10px;
    letter-spacing: 0.025em;
  }
  .artifact-caption i {
    width: 4px;
    height: 4px;
    border: 1px solid currentColor;
    border-radius: 50%;
  }
  .proof-object.compact {
    height: clamp(180px, 24vh, 240px);
  }
  .compact .artifact-lift {
    scale: 0.64;
  }
  [data-state='verified'] .artifact-caption i,
  [data-state='minted'] .artifact-caption i {
    background: var(--p-accent);
    border-color: var(--p-accent);
  }
  [data-state='pending'] .artifact-caption i,
  [data-state='working'] .artifact-caption i {
    animation: pulse 1.5s ease-in-out infinite;
  }
  /* While the service is working, one hairline sweeps the sheet. It is the
     only motion that says "still running" without inventing progress. */
  .proof-sheet::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent,
      var(--p-accent),
      transparent
    );
    opacity: 0;
  }
  [data-state='working'] .proof-sheet::after {
    animation: sweep 2.4s ease-in-out infinite;
  }
  @keyframes sweep {
    0%,
    100% {
      opacity: 0;
      transform: translateY(28px);
    }
    18%,
    82% {
      opacity: 0.55;
    }
    50% {
      transform: translateY(228px);
    }
  }
  [data-state='reverted'] .artifact-lift,
  [data-state='unresolved'] .artifact-lift {
    animation: none;
  }
  @keyframes breathe {
    50% {
      transform: translateY(-5px);
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }
  @media (max-width: 640px) {
    .proof-object {
      height: 208px;
    }
    .artifact-lift {
      scale: 0.64;
    }
    .artifact-caption {
      bottom: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .artifact-lift,
    .artifact-caption i,
    .proof-sheet::after {
      animation: none;
    }
    .artifact-body,
    .proof-sheet,
    .coin-face,
    .artifact-seal {
      transition: none;
    }
  }
</style>
