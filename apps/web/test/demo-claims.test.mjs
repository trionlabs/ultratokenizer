// The walkthrough states hard numbers and names hard field lists. Each one is
// repeated from a file that actually defines it, and nothing recomputes them at
// runtime, so an edit to the contract, the domain types or the Rust would
// silently leave the page lying. These assertions read both sides and require
// them to agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

const demo = read('apps/web/src/routes/demo/+page.svelte');
const stage = read('apps/web/src/lib/visuals/EngineStage.svelte');

/** The single-quoted strings of a `const <name> = [...]` array literal. */
function arrayLiteral(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} not found`);
  const end = source.indexOf('];', start);
  assert.ok(end > start, `${declaration} is not a closed array`);
  return (source.slice(start, end).match(/'[^']*'/g) ?? []).map((value) =>
    value.slice(1, -1),
  );
}

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

/** The hashed members of IssuanceRequest, in the order they are hashed. */
function requestFields() {
  const source = read('packages/domain/src/request-digest.ts');
  const start = source.indexOf('const requestFields = [');
  assert.notEqual(start, -1, 'requestFields was renamed or moved');
  const list = source.slice(start, source.indexOf('] as const;', start));
  const names = [...list.matchAll(/name: '([^']+)'/g)].map((hit) => hit[1]);
  assert.ok(names.length > 0, 'requestFields no longer lists names');
  return names;
}

test('the Gate ladder has one rung per ordered check', () => {
  const declared = stage.match(/const CHECKS = (\d+);/);
  assert.ok(declared, 'EngineStage no longer declares CHECKS');
  assert.equal(Number(declared[1]), gateChecks());
});

test('the Gate illustration names every ordered check, in order', () => {
  const labels = arrayLiteral(
    read('apps/web/src/lib/visuals/steps/Step08Gate.svelte'),
    'const checks = [',
  );
  assert.equal(labels.length, gateChecks());
  // One label per guard of IssuanceGate.issue(), in source order:
  // paused, _request, replay registers, holder signature, _permit, rights
  // record, _evidence, reservation record, expiry, reservation already drawn,
  // then digest/usage/amount match.
  assert.deepEqual(labels, [
    'ISSUANCE OPEN',
    'REQUEST FORM',
    'NOT USED BEFORE',
    'HOLDER SIGNED',
    'ISSUER PERMIT',
    'RIGHTS RECORD',
    'SP1 PROOF',
    'RESERVATION',
    'NOT EXPIRED',
    'NOT DRAWN',
    'AMOUNT MATCHES',
  ]);
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
  assert.equal(requestFields().length, 15, 'the request shape changed');
  assert.match(demo, /Fifteen request fields hash into one digest/);
  assert.match(demo, /Fifteen fields, one hash/);
});

test('the digest illustration draws the real fields, in hash order', () => {
  const source = read('apps/web/src/lib/visuals/steps/Step04Digest.svelte');
  const labels = [
    ...arrayLiteral(source, 'const leftLabels = ['),
    ...arrayLiteral(source, 'const rightLabels = ['),
  ];
  const fields = requestFields();
  assert.equal(
    labels.length,
    fields.length,
    'the figure draws a different number of chips than the struct has fields',
  );
  // Chips are abbreviated ('CLAIM COMMIT' for claimCommitment), so each one
  // must be a prefix of the field it stands for, and stand in the same place.
  labels.forEach((label, index) => {
    const field = fields[index].toUpperCase();
    const chip = label.replaceAll(' ', '');
    assert.ok(
      field.startsWith(chip),
      `chip ${index + 1} is "${label}" where the struct has "${fields[index]}"`,
    );
  });
});

test('the digest illustration keeps domain members out of the fan', () => {
  const source = read('apps/web/src/lib/visuals/steps/Step04Digest.svelte');
  const chips = [
    ...arrayLiteral(source, 'const leftLabels = ['),
    ...arrayLiteral(source, 'const rightLabels = ['),
  ];
  // chainId and gate bind the digest through the EIP-712 domain; drawing them
  // as chips in the fan would claim they are hashed as struct members.
  for (const domainMember of ['CHAIN', 'CHAIN ID', 'GATE'])
    assert.ok(
      !chips.includes(domainMember),
      `"${domainMember}" is an EIP-712 domain member, not a request field`,
    );
  assert.match(source, /DOMAIN · CHAIN · GATE/);
});

test('the digest illustration shows the pinned regression digest', () => {
  const pinned = read('packages/domain/README.md').match(/0x[0-9a-f]{64}/)?.[0];
  assert.ok(pinned, 'the domain README no longer pins a regression digest');
  const source = read('apps/web/src/lib/visuals/steps/Step04Digest.svelte');
  const shown = source.match(/>(0x[0-9a-f]{8})</)?.[1];
  assert.ok(shown, 'the figure no longer shows a digest');
  assert.ok(
    pinned.startsWith(shown),
    `the figure shows ${shown}, the fixture digest is ${pinned}`,
  );
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
