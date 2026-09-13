import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './helpers.mjs';
const { watchWallets } = await loadModule(
  '../src/lib/application/wallet-discovery.ts',
);
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
function detail(provider, id = ids[0], name = 'Example') {
  return {
    info: {
      uuid: id,
      name,
      rdns: 'test.example',
      icon: 'data:image/svg+xml,<svg/>',
    },
    provider,
  };
}
function announce(target, value) {
  target.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail: value }),
  );
}

test('two announced wallets bypass a competing immutable ethereum getter without any wallet requests', () => {
  const target = new EventTarget();
  let calls = 0;
  const alpha = {
    request() {
      calls++;
    },
  };
  const beta = {
    request() {
      calls++;
    },
  };
  let getterReads = 0;
  Object.defineProperty(target, 'ethereum', {
    get() {
      getterReads++;
      return alpha;
    },
  });
  target.addEventListener('eip6963:requestProvider', () => {
    announce(target, detail(alpha));
    announce(target, detail(beta, ids[1]));
  });
  let choices;
  const stop = watchWallets(target, (value) => {
    choices = value;
  });
  assert.deepEqual(
    choices.map((choice) => choice.provider),
    [alpha, beta],
  );
  assert.equal(getterReads, 0);
  assert.equal(calls, 0);
  assert(Object.isFrozen(choices));
  stop();
});

test('legacy-only providers remain available and a throwing ethereum getter cannot break discovery', () => {
  const provider = { request() {} };
  const target = Object.assign(new EventTarget(), { ethereum: provider });
  let choices;
  watchWallets(target, (value) => {
    choices = value;
  });
  assert.equal(choices[0].id, 'legacy');
  assert.equal(choices[0].provider, provider);
  const broken = new EventTarget();
  Object.defineProperty(broken, 'ethereum', {
    get() {
      throw new Error('Synthetic extension collision');
    },
  });
  watchWallets(broken, (value) => {
    choices = value;
  });
  assert.deepEqual(choices, []);
  announce(broken, detail(provider));
  assert.equal(choices[0].provider, provider);
});

test('duplicate UUIDs and provider references cannot replace discovery entries; late announcements survive resubscription', () => {
  const target = new EventTarget();
  const alpha = { request() {} };
  const beta = { request() {} };
  let choices;
  const stop = watchWallets(target, (value) => {
    choices = value;
  });
  announce(target, detail(alpha));
  announce(target, detail(beta));
  announce(target, detail(alpha, ids[1]));
  assert.equal(choices.length, 1);
  assert.equal(choices[0].provider, alpha);
  stop();
  const previous = choices;
  announce(target, detail(beta, ids[1]));
  assert.equal(choices, previous);
  watchWallets(target, (value) => {
    choices = value;
  });
  assert.deepEqual(
    choices.map((choice) => choice.provider),
    [alpha, beta],
  );
});

test('untrusted metadata accessors and malformed announcements are ignored; icon data is not retained', () => {
  const target = new EventTarget();
  let choices;
  let getters = 0;
  watchWallets(target, (value) => {
    choices = value;
  });
  const candidate = detail({ request() {} });
  Object.defineProperty(candidate.info, 'name', {
    get() {
      getters++;
      return 'Spoof';
    },
  });
  announce(target, candidate);
  for (const value of [
    null,
    {},
    detail({}, ids[0]),
    detail({ request() {} }, 'not-a-uuid'),
  ])
    announce(target, value);
  assert.deepEqual(choices, []);
  assert.equal(getters, 0);
  announce(target, detail({ request() {} }));
  assert.equal(choices[0].icon, undefined);
});
