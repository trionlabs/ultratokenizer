import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createJourney,
  transition,
  parseSampleAmount,
  formatGrams,
  canAuthorize,
} from '../src/lib/domain/journey.ts';

function reviewed() {
  return transition(
    transition(createJourney(), { type: 'load_sample', scenario: 'supported' }),
    { type: 'review', grams: '1.250', consent: true },
  );
}

function authorized() {
  let state = reviewed();
  for (const check of ['subject', 'reservation', 'rights'])
    state = transition(state, { type: 'issuer_check', check, checked: true });
  return transition(state, { type: 'authorize' });
}

test('amounts preserve milligrams and reject ambiguity, excess precision and over-allocation', () => {
  assert.equal(parseSampleAmount('1.250'), '1250');
  assert.equal(parseSampleAmount('0.001'), '1');
  assert.equal(parseSampleAmount('10'), '10000');
  assert.equal(formatGrams('1250'), '1.250');
  for (const value of [
    '0',
    '-1',
    '1e1',
    '1,250',
    '01',
    ' 1',
    '1.',
    '.1',
    '1.0001',
    '10.001',
    '9'.repeat(500),
    'NaN',
  ]) {
    assert.throws(() => parseSampleAmount(value));
  }
});

test('proof and mint cannot be reached by skipping evidence, review or issuer approval', () => {
  for (const state of [createJourney(), reviewed()]) {
    assert.throws(() => transition(state, { type: 'prove', succeeds: true }));
    assert.throws(() => transition(state, { type: 'mint', succeeds: true }));
  }
});

test('document rejection has no claim, authority, proof or receipt', () => {
  for (const scenario of ['tampered', 'unsupported']) {
    const state = transition(createJourney(), {
      type: 'load_sample',
      scenario,
    });
    assert.equal(state.stage, 'document');
    assert.equal(state.failure, scenario);
    assert.equal(state.reviewed, false);
    assert.equal(state.authorization, 'missing');
    assert.equal(state.proof, 'missing');
    assert.equal(state.receipt, 'missing');
  }
});

test('disclosure consent is mandatory', () => {
  const state = transition(createJourney(), {
    type: 'load_sample',
    scenario: 'supported',
  });
  assert.throws(() =>
    transition(state, { type: 'review', grams: '1', consent: false }),
  );
});

test('all three issuer checks are required; evidence alone never authorizes', () => {
  let state = reviewed();
  for (const check of ['subject', 'reservation', 'rights']) {
    assert.equal(canAuthorize(state), false);
    assert.throws(() => transition(state, { type: 'authorize' }));
    state = transition(state, { type: 'issuer_check', check, checked: true });
  }
  assert.equal(canAuthorize(state), true);
});

test('a declined request must be revised before reapproval', () => {
  let state = transition(reviewed(), { type: 'reject_authorization' });
  for (const check of ['subject', 'reservation', 'rights'])
    state = transition(state, { type: 'issuer_check', check, checked: true });
  assert.throws(() => transition(state, { type: 'authorize' }));
  state = transition(state, { type: 'edit_request' });
  assert.equal(state.reviewed, false);
  assert.equal(state.failure, null);
});

test('editing after approval or proving invalidates all dependent decisions', () => {
  const approved = authorized();
  const proved = transition(approved, { type: 'prove', succeeds: true });
  for (const state of [approved, proved]) {
    const edited = transition(state, { type: 'edit_request' });
    assert.equal(edited.stage, 'review');
    assert.equal(edited.amountMg, '1250');
    assert.equal(edited.authorization, 'missing');
    assert.equal(edited.proof, 'missing');
    assert.equal(edited.reviewed, false);
    assert.equal(edited.issuerChecks.reservation, false);
  }
});

test('proof and wallet failures are retryable without manufacturing a receipt', () => {
  let state = transition(authorized(), { type: 'prove', succeeds: false });
  assert.equal(state.stage, 'proof');
  assert.equal(state.proof, 'missing');
  assert.throws(() => transition(state, { type: 'mint', succeeds: true }));
  state = transition(state, { type: 'prove', succeeds: true });
  state = transition(state, { type: 'mint', succeeds: false });
  assert.equal(state.stage, 'mint');
  assert.equal(state.receipt, 'missing');
  state = transition(state, { type: 'mint', succeeds: true });
  assert.equal(state.receipt, 'simulated');
  assert.equal(state.mode, 'simulation');
  assert.equal(state.stage, 'receipt');
  assert.throws(() => transition(state, { type: 'mint', succeeds: true }));
  assert.throws(() => transition(state, { type: 'edit_request' }));
});

test('reset clears every prior outcome without changing old immutable state', () => {
  const state = authorized();
  const reset = transition(state, { type: 'reset' });
  assert.deepEqual(reset, createJourney());
  assert.equal(state.authorization, 'simulated');
  assert.throws(() => {
    state.issuerChecks.subject = false;
  });
});
