// The walkthrough states hard numbers. Each one is repeated from a file that
// actually defines it, and nothing recomputes them at runtime, so an edit to
// the contract, the domain types or the Rust would silently leave the page
// lying. These assertions read both sides and require them to agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

const demo = read('apps/web/src/routes/demo/+page.svelte');
const stage = read('apps/web/src/lib/visuals/EngineStage.svelte');

/** Ordered guards in `issue()` before the mint: inline reverts plus validators. */
function gateChecks() {
  const source = read('contracts/src/IssuanceGate.sol');
  const start = source.indexOf('    function issue(');
  assert.notEqual(start, -1, 'IssuanceGate.issue() not found');
  const open = source.indexOf(
    '{',
    source.indexOf(') external nonReentrant returns (bytes32 digest)', start),
  );
  const mint = source.indexOf('IMintAdapter(terms.adapter).mint(', start);
  assert.ok(mint > open, 'the adapter mint call moved out of issue()');
  const body = source.slice(open, mint);
  const reverts = body.match(/revert\s+\w+\(/g) ?? [];
  const validators = body.match(/\b_(?:request|permit|evidence)\(/g) ?? [];
  return reverts.length + validators.length;
}

test('the Gate ladder has one rung per ordered check', () => {
  const declared = stage.match(/const CHECKS = (\d+);/);
  assert.ok(declared, 'EngineStage no longer declares CHECKS');
  assert.equal(Number(declared[1]), gateChecks());
});

test('the Gate illustration names every ordered check, in order', () => {
  const source = read('apps/web/src/lib/visuals/steps/Step08Gate.svelte');
  const list = source.slice(
    source.indexOf('const checks = ['),
    source.indexOf('];', source.indexOf('const checks = [')),
  );
  const labels = list.match(/'[^']+'/g) ?? [];
  assert.equal(labels.length, gateChecks());
});

test('the Gate step spells out the same check count', () => {
  const words = [
    'Zero',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
  ];
  const word = words[gateChecks()];
  assert.ok(word, `no spelled form for ${gateChecks()} checks`);
  assert.match(demo, new RegExp(`${word} ordered checks in one transaction`));
});

test('the digest step states the real field count', () => {
  const source = read('packages/domain/src/request-digest.ts');
  const list = source.slice(
    source.indexOf('const requestFields = ['),
    source.indexOf('] as const;'),
  );
  const fields = list.match(/name: '/g) ?? [];
  assert.equal(fields.length, 15, 'the request shape changed');
  assert.match(demo, /Fifteen request fields hash into one digest/);
  assert.match(demo, /Fifteen fields, one hash/);
});

test('the stage states the real capsule and public-value sizes', () => {
  const capsule = read('proofs/claim-evidence/src/capsule.rs').match(
    /pub const CAPSULE_BYTES: usize = (\d+);/,
  );
  const values = read('proofs/claim-evidence/src/lib.rs').match(
    /pub const PUBLIC_VALUES_BYTES: usize = (\d+);/,
  );
  assert.ok(capsule && values, 'the Rust size constants were renamed');
  assert.match(stage, new RegExp(`${capsule[1]}-byte capsule`));
  assert.match(stage, new RegExp(`${values[1]} bytes of public values`));
});
