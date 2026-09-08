import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJourney, transition } from '../src/lib/domain/journey.ts';
import {
  createDiscoveries,
  recordDiscovery,
  recordReceiptCheck,
  discoveryCount,
} from '../src/lib/domain/discoveries.ts';

test('receipt exploration does not collect a completion stamp before the journey finishes', () => {
  const stamps = createDiscoveries();
  assert.equal(recordReceiptCheck(stamps, createJourney()), stamps);
  assert.equal(discoveryCount(stamps), 0);
});

test('an edited sample earns one discovery without granting any issuance progress', () => {
  const before = createJourney();
  const event = { type: 'load_sample', scenario: 'tampered' };
  const after = transition(before, event);
  const stamps = recordDiscovery(createDiscoveries(), before, after, event);
  assert.equal(discoveryCount(stamps), 1);
  assert.equal(stamps.integrity, true);
  assert.equal(after.stage, 'document');
  assert.equal(after.authorization, 'missing');
  assert.deepEqual(recordDiscovery(stamps, before, after, event), stamps);
  assert.throws(() => {
    stamps.orbit = true;
  });
});

test('proof recovery and receipt stamps require distinct completed actions and survive a journey reset', () => {
  let journey = transition(createJourney(), {
    type: 'load_sample',
    scenario: 'supported',
  });
  journey = transition(journey, {
    type: 'review',
    grams: '1.250',
    consent: true,
  });
  for (const check of ['subject', 'reservation', 'rights'])
    journey = transition(journey, {
      type: 'issuer_check',
      check,
      checked: true,
    });
  journey = transition(journey, { type: 'authorize' });
  let stamps = createDiscoveries();
  const success = { type: 'prove', succeeds: true };
  assert.equal(
    recordDiscovery(stamps, journey, transition(journey, success), success)
      .recovery,
    false,
  );
  journey = transition(journey, { type: 'prove', succeeds: false });
  const retried = transition(journey, success);
  stamps = recordDiscovery(stamps, journey, retried, success);
  assert.equal(discoveryCount(stamps), 1);
  assert.equal(recordReceiptCheck(stamps, retried).orbit, false);
  journey = transition(retried, { type: 'mint', succeeds: true });
  stamps = recordReceiptCheck(stamps, journey);
  assert.equal(discoveryCount(stamps), 2);
  assert.equal(stamps.orbit, true);
  const reset = { type: 'reset' };
  assert.deepEqual(
    recordDiscovery(stamps, journey, transition(journey, reset), reset),
    stamps,
  );
  assert.equal(discoveryCount(createDiscoveries()), 0);
});
