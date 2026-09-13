import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSubmittedRequest } from '../src/proof-observation.mjs';
import { ServiceError } from '../src/io.mjs';

const requestId = `0x${'11'.repeat(32)}`;
const transactionHash = `0x${'22'.repeat(32)}`;
function reply(extra = {}) {
  return {
    status: 'exact_signed_request_observed',
    deadlineUnix: 200,
    requestId,
    transactionHash,
    proofAvailable: false,
    deadlinePassed: false,
    executionStatus: 2,
    fulfillmentStatus: extra.proofAvailable ? 3 : 2,
    proofVerified: false,
    automaticRetryAllowed: false,
    ...extra,
  };
}
function options(observe, extra = {}) {
  return {
    observe,
    deadline: 200,
    requestId,
    transactionHash,
    now: () => 100,
    sleep: async () => {},
    update: async () => {},
    ...extra,
  };
}
await test('only unsigned observation is repeated after one recognized transport failure', async () => {
  let reads = 0;
  const updates = [];
  const result = await observeSubmittedRequest(
    options(
      async () => {
        if (++reads === 1)
          throw new ServiceError('proof_observation_unavailable');
        return reply({ proofAvailable: reads === 3 });
      },
      { update: async (...args) => updates.push(args) },
    ),
  );
  assert.equal(reads, 3);
  assert.equal(result.proofAvailable, true);
  assert.deepEqual(updates, [
    ['queued', 'proof_observation_unavailable'],
    ['proving'],
  ]);
});
await test('three consecutive transport failures stop with an observation-specific error', async () => {
  let reads = 0;
  await assert.rejects(
    observeSubmittedRequest(
      options(async () => {
        reads++;
        throw new ServiceError('proof_observation_unavailable');
      }),
    ),
    { code: 'proof_observation_unavailable' },
  );
  assert.equal(reads, 3);
});
await test('invalid journals and contradictory observations are never retried', async () => {
  for (const observe of [
    async () => {
      throw new ServiceError('preparation_failed');
    },
    async () => reply({ requestId: `0x${'ff'.repeat(32)}` }),
    async () => reply({ deadlineUnix: 201 }),
    async () => reply({ fulfillmentStatus: 0 }),
    async () => reply({ fulfillmentStatus: 7 }),
    async () => reply({ fulfillmentStatus: '4' }),
    async () => reply({ fulfillmentStatus: 4, proofAvailable: true }),
  ]) {
    let reads = 0;
    await assert.rejects(
      observeSubmittedRequest(
        options(async () => {
          reads++;
          return observe();
        }),
      ),
      { code: 'proof_request_uncertain' },
    );
    assert.equal(reads, 1);
  }
});
await test('terminal network outcomes stop immediately even after successful execution', async () => {
  for (const fulfillmentStatus of [4, 5, 6]) {
    let reads = 0,
      sleeps = 0;
    const updates = [];
    await assert.rejects(
      observeSubmittedRequest(
        options(
          async () => {
            reads++;
            return reply({ fulfillmentStatus });
          },
          {
            sleep: async () => sleeps++,
            update: async (...args) => updates.push(args),
          },
        ),
      ),
      {
        code:
          fulfillmentStatus === 6
            ? 'proof_deadline_elapsed'
            : 'proof_request_rejected',
      },
    );
    assert.equal(reads, 1);
    assert.equal(sleeps, 0);
    assert.deepEqual(updates, []);
  }
});
await test('the exact request deadline ends observation without any replacement request', async () => {
  let reads = 0,
    now = 199;
  await assert.rejects(
    observeSubmittedRequest(
      options(
        async () => {
          reads++;
          return reply();
        },
        {
          now: () => now,
          sleep: async () => {
            now = 200;
          },
        },
      ),
    ),
    { code: 'proof_deadline_elapsed' },
  );
  assert.equal(reads, 1);
});
