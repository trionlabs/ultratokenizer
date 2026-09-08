import {
  createJourney,
  transition,
  type Journey,
  type Event,
  type Role,
} from '../domain/journey.ts';
import {
  createDiscoveries,
  recordDiscovery,
  recordReceiptCheck,
  discoveryCount,
  type Discoveries,
  type Discovery,
} from '../domain/discoveries.ts';

export type PreviewState = Readonly<{
  journey: Journey;
  discoveries: Discoveries;
  role: Role;
  error: string;
  discoveryNotice: string;
}>;

/** Owns one in-memory simulation session. No network, signing or issuance authority. */
export function createPreviewSession() {
  let state: PreviewState = Object.freeze({
    journey: createJourney(),
    discoveries: createDiscoveries(),
    role: 'holder',
    error: '',
    discoveryNotice: '',
  });
  const listeners = new Set<(state: PreviewState) => void>();
  function update(next: PreviewState) {
    state = Object.freeze(next);
    for (const listener of listeners) listener(state);
  }
  function notice(discoveries: Discoveries) {
    const names = {
      orbit: 'First orbit',
      integrity: 'Catch the edit',
      recovery: 'Find your way back',
    };
    const earned = (Object.keys(names) as Discovery[]).find(
      (key) => discoveries[key] && !state.discoveries[key],
    );
    return earned
      ? `${names[earned]} stamp collected. ${discoveryCount(discoveries)} of 3 discoveries.`
      : state.discoveryNotice;
  }
  return {
    read: () => state,
    subscribe(listener: (state: PreviewState) => void) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(event: Event): boolean {
      try {
        const journey = transition(state.journey, event);
        const discoveries = recordDiscovery(
          state.discoveries,
          state.journey,
          journey,
          event,
        );
        update({
          ...state,
          journey,
          discoveries,
          discoveryNotice: notice(discoveries),
          error: '',
          role:
            event.type === 'reset' || event.type === 'authorize'
              ? 'holder'
              : state.role,
        });
        return true;
      } catch (cause) {
        update({
          ...state,
          error:
            cause instanceof Error
              ? cause.message
              : 'This step could not be completed.',
        });
        return false;
      }
    },
    setRole(role: Role) {
      update({ ...state, role, error: '' });
    },
    receiptChecked(expectedJourney: Journey) {
      // Asynchronous verification belongs to the exact journey that initiated it.
      if (expectedJourney !== state.journey) return;
      const discoveries = recordReceiptCheck(state.discoveries, state.journey);
      update({ ...state, discoveries, discoveryNotice: notice(discoveries) });
    },
  };
}
