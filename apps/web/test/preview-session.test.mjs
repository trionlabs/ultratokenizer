import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewSession } from '../src/lib/application/preview-session.ts';

function complete(session) {
  session.dispatch({ type: 'load_sample', scenario: 'supported' });
  session.dispatch({ type: 'review', grams: '5.000', consent: true });
  session.setRole('issuer');
  for (const check of ['subject', 'reservation', 'rights'])
    session.dispatch({ type: 'issuer_check', check, checked: true });
  session.dispatch({ type: 'authorize' });
  session.dispatch({ type: 'prove', succeeds: true });
  session.dispatch({ type: 'mint', succeeds: true });
}

test('session isolates simulation transitions, guards and role updates behind one interface', () => {
  const session = createPreviewSession();
  let calls = 0;
  const unsubscribe = session.subscribe(() => calls++);
  assert.equal(session.dispatch({ type: 'mint', succeeds: true }), false);
  assert.equal(session.read().journey.stage, 'document');
  assert.match(session.read().error, /current step/);
  complete(session);
  assert.equal(session.read().journey.receipt, 'simulated');
  assert.equal(session.read().role, 'holder');
  assert.equal(session.read().error, '');
  const before = calls;
  unsubscribe();
  session.setRole('issuer');
  assert.equal(calls, before);
});

test('a stale verification cannot award a stamp to a reset or replaced journey', () => {
  const session = createPreviewSession();
  complete(session);
  const old = session.read().journey;
  session.dispatch({ type: 'reset' });
  session.receiptChecked(old);
  assert.equal(session.read().discoveries.orbit, false);
  complete(session);
  session.receiptChecked(session.read().journey);
  assert.equal(session.read().discoveries.orbit, true);
  assert.match(session.read().discoveryNotice, /First orbit stamp collected/);
  session.dispatch({ type: 'reset' });
  assert.equal(session.read().discoveries.orbit, true);
  assert.equal(session.read().journey.authorization, 'missing');
});
