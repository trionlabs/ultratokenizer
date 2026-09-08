import type { Event, Journey } from './journey.ts';

export type Discovery = 'orbit' | 'integrity' | 'recovery';
export type Discoveries = Readonly<Record<Discovery, boolean>>;

/** Session learning markers. These never affect issuance authority. */
export function createDiscoveries(): Discoveries {
  return Object.freeze({ orbit: false, integrity: false, recovery: false });
}

export function recordDiscovery(
  discoveries: Discoveries,
  before: Journey,
  after: Journey,
  event: Event,
): Discoveries {
  return Object.freeze({
    ...discoveries,
    integrity:
      discoveries.integrity ||
      (event.type === 'load_sample' && after.failure === 'tampered'),
    recovery:
      discoveries.recovery ||
      (event.type === 'prove' &&
        before.failure === 'proof_rejected' &&
        after.proof === 'simulated' &&
        after.stage === 'mint'),
  });
}

export function recordReceiptCheck(
  discoveries: Discoveries,
  journey: Journey,
): Discoveries {
  if (journey.receipt !== 'simulated') return discoveries;
  return Object.freeze({ ...discoveries, orbit: true });
}

export function discoveryCount(discoveries: Discoveries): number {
  return Object.values(discoveries).filter(Boolean).length;
}
