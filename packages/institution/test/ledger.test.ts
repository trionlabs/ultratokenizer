import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  mkdtempSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import {
  getClaimUsageId,
  getIssuanceRequestDigest,
  parseIssuanceRequest,
} from '../../domain/src/index.js';
import {
  openInstitutionLedger,
  InstitutionLedgerError,
  type InstitutionLedger,
  type InstitutionRight,
  type IssuedObservation,
  type UnusedObservation,
  type ExpiredUnopenedObservation,
} from '../src/index.js';

const word = (pair: string): Hex => `0x${pair.repeat(32)}`;
const sourceId = word('11');
const issuerId = word('22');
const holder = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const gate = '0x3333333333333333333333333333333333333333';
const hasCode = (code: InstitutionLedgerError['code']) => (error: unknown) =>
  error instanceof InstitutionLedgerError && error.code === code;

function storage(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ut-institution-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'ledger.sqlite') };
}
function open(t: TestContext, path: string): InstitutionLedger {
  const ledger = openInstitutionLedger({ path });
  t.after(() => ledger.close());
  return ledger;
}
function register(
  ledger: InstitutionLedger,
  recordReference = 'private-record-reference-marker',
  milligrams = '1000',
) {
  return ledger.registerRight({
    sourceId,
    recordReference,
    holder,
    milligrams,
  });
}
function request(right: InstitutionRight, patch: Record<string, unknown> = {}) {
  return parseIssuanceRequest({
    schemaVersion: '1',
    action: 'ISSUE',
    requestId: word('31'),
    chainId: '296',
    gate,
    token,
    recipient: right.holder,
    amount: right.milligrams,
    unit: 'XAU_MILLIGRAM',
    issuerId,
    reservationId: word('32'),
    claimCommitment: word('33'),
    claimUsageId: right.claimUsageId,
    policyVersion: '1',
    rightsVersion: '1',
    nonce: '0',
    validUntil: '2000000000',
    ...patch,
  });
}
function issued(r: ReturnType<typeof request>): IssuedObservation {
  return {
    kind: 'issued',
    requestDigest: getIssuanceRequestDigest(r),
    chainId: r.chainId,
    gate: r.gate,
    reservationId: r.reservationId,
    claimUsageId: r.claimUsageId,
    blockHash: word('41'),
    blockNumber: '123',
    transactionHash: word('42'),
  };
}
function unused(r: ReturnType<typeof request>): UnusedObservation {
  const { transactionHash: _, ...common } = issued(r);
  return {
    ...common,
    kind: 'unused',
    reason: 'revoked-unused',
    reservationReleased: true,
    reservationUsed: '0',
    requestUsed: false,
    claimUsed: false,
  };
}
function expiredUnopened(
  r: ReturnType<typeof request>,
): ExpiredUnopenedObservation {
  const { transactionHash: _, ...common } = issued(r);
  return {
    ...common,
    kind: 'expired-unopened',
    blockTimestamp: r.validUntil,
    reservationAbsent: true,
    requestUsed: false,
    claimUsed: false,
  };
}

await test('expired-unopened release persists once, retains replay identities and permits a fresh allocation', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  const r = request(right);
  ledger.reserve({ rightId: right.rightId, request: r });
  const terminal = ledger.releaseExpiredUnopened(expiredUnopened(r));
  assert.equal(terminal.state, 'released');
  assert.equal(ledger.getPool({ issuerId, token }).pending, '0');
  ledger.close();
  const reopened = open(t, path);
  assert.deepEqual(
    reopened.releaseExpiredUnopened(expiredUnopened(r)),
    terminal,
  );
  assert.deepEqual(
    reopened.reserve({ rightId: right.rightId, request: r }),
    terminal,
  );
  assert.throws(
    () => reopened.markIssued(issued(r)),
    hasCode('terminal_conflict'),
  );
  assert.throws(
    () => reopened.releaseUnused(unused(r)),
    hasCode('terminal_conflict'),
  );
  assert.throws(
    () =>
      reopened.releaseExpiredUnopened({
        ...expiredUnopened(r),
        blockNumber: '124',
      }),
    hasCode('terminal_conflict'),
  );
  assert.throws(
    () =>
      reopened.reserve({
        rightId: right.rightId,
        request: request(right, { nonce: '1' }),
      }),
    hasCode('request_conflict'),
  );
  const fresh = request(right, {
    reservationId: word('88'),
    validUntil: '2000000100',
  });
  assert.equal(
    reopened.reserve({ rightId: right.rightId, request: fresh }).state,
    'pending',
  );
  assert.equal(reopened.getPool({ issuerId, token }).pending, '1000');
});

await test('expired-unopened evidence rejects early, wrong-phase, malformed and unbound outcomes', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  const r = request(right);
  const pending = ledger.reserve({ rightId: right.rightId, request: r });
  for (const patch of [
    { kind: 'unused' },
    { blockTimestamp: '1999999999' },
    { blockTimestamp: 2000000000 },
    { blockTimestamp: '02000000000' },
    { blockTimestamp: '-1' },
    { reservationAbsent: false },
    { requestUsed: true },
    { claimUsed: true },
    { gate: token },
    { chainId: '31337' },
    { reservationId: word('88') },
    { claimUsageId: word('88') },
    { unexpected: true },
    { reservationReleased: true },
  ]) {
    assert.throws(
      () =>
        ledger.releaseExpiredUnopened({
          ...expiredUnopened(r),
          ...patch,
        } as ExpiredUnopenedObservation),
      hasCode('invalid_outcome'),
    );
    assert.deepEqual(ledger.getAllocation(pending.requestDigest), pending);
  }
  ledger.markIssued(issued(r));
  assert.throws(
    () => ledger.releaseExpiredUnopened(expiredUnopened(r)),
    hasCode('terminal_conflict'),
  );
  assert.equal(ledger.getPool({ issuerId, token }).outstanding, '1000');
});

await test('version-2 upgrade is explicit, transactional and preserves all data and schema', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const identity = ledger.privateClaimIdentity(right.rightId);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  const r = request(right);
  const pending = ledger.reserve({ rightId: right.rightId, request: r });
  ledger.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA user_version = 2');
  const snapshot = () =>
    ['asset_rights', 'backing_pools', 'allocations', 'sqlite_schema'].map(
      (table) => legacy.prepare(`SELECT * FROM ${table}`).all(),
    );
  const before = snapshot();
  assert.throws(
    () => openInstitutionLedger({ path }),
    hasCode('unsupported_database'),
  );
  assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 2);
  const upgraded = openInstitutionLedger({ path, upgradeFromVersion: 2 });
  t.after(() => upgraded.close());
  assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(upgraded.getAllocation(pending.requestDigest), pending);
  assert.equal(
    upgraded.privateClaimIdentity(right.rightId).claimId,
    identity.claimId,
  );
  legacy.close();
});

await test('explicit upgrade never repairs drifted or older schemas', (t) => {
  const { path } = storage(t);
  open(t, path).close();
  const database = new DatabaseSync(path);
  database.exec(
    'PRAGMA user_version = 2; DROP INDEX one_live_allocation_per_right',
  );
  assert.throws(
    () => openInstitutionLedger({ path, upgradeFromVersion: 2 }),
    hasCode('unsupported_database'),
  );
  assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 2);
  database.exec('PRAGMA user_version = 1');
  assert.throws(
    () => openInstitutionLedger({ path, upgradeFromVersion: 2 }),
    hasCode('unsupported_database'),
  );
  assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 1);
  database.close();
});

await test('a stable source/record pair retains its opaque identity and immutable terms after restart', (t) => {
  const { path } = storage(t);
  const first = open(t, path);
  const right = register(first);
  const identity = first.privateClaimIdentity(right.rightId);
  assert.equal(
    getClaimUsageId({ sourceId: identity.sourceId, claimId: identity.claimId }),
    right.claimUsageId,
  );
  assert.notEqual(identity.claimId, right.rightId);
  first.close();
  const reopened = open(t, path);
  assert.deepEqual(register(reopened), right);
  assert.deepEqual(
    reopened.findRight({
      sourceId,
      recordReference: 'private-record-reference-marker',
    }),
    right,
  );
  assert.equal(
    reopened.privateClaimIdentity(right.rightId).claimId,
    identity.claimId,
  );
  assert.throws(
    () => register(reopened, 'private-record-reference-marker', '999'),
    hasCode('right_conflict'),
  );
  assert.throws(
    () =>
      reopened.registerRight({
        sourceId,
        recordReference: 'private-record-reference-marker',
        holder: token,
        milligrams: '1000',
      }),
    hasCode('right_conflict'),
  );
  assert.equal(
    reopened.findRight({ sourceId, recordReference: 'unregistered-record' }),
    null,
  );
});

await test('public snapshots, private identity defaults and errors never serialize private record/claim identifiers', (t) => {
  const { directory, path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const identity = ledger.privateClaimIdentity(right.rightId);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  const allocation = ledger.reserve({
    rightId: right.rightId,
    request: request(right),
  });
  for (const output of [
    JSON.stringify(right),
    JSON.stringify(allocation),
    inspect(identity),
    inspect({ identity }),
    inspect(ledger),
  ]) {
    assert.ok(!output.includes('private-record-reference-marker'));
    assert.ok(!output.includes(identity.claimId));
  }
  assert.deepEqual(Object.keys(identity), []);
  assert.deepEqual({ ...identity }, {});
  assert.throws(() => JSON.stringify(identity), hasCode('private_identity'));
  assert.throws(
    () => JSON.stringify({ identity }),
    hasCode('private_identity'),
  );
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of [path, `${path}-wal`, `${path}-shm`])
    if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600);
  try {
    register(ledger, 'private-record-reference-marker', '2');
  } catch (error) {
    assert.ok(!inspect(error).includes('private-record-reference-marker'));
    assert.ok(!inspect(error).includes(identity.claimId));
  }
});

await test('full exact reservation retries are durable and never double-count cap', (t) => {
  const { path } = storage(t);
  const first = open(t, path);
  const right = register(first);
  const r = request(right);
  assert.throws(
    () => first.reserve({ rightId: right.rightId, request: r }),
    hasCode('cap_exceeded'),
  );
  assert.equal(first.getAllocation(getIssuanceRequestDigest(r)), null);
  first.setBackingCap({ issuerId, token, milligrams: '1000' });
  for (const amount of ['999', '1001'])
    assert.throws(
      () =>
        first.reserve({
          rightId: right.rightId,
          request: request(right, { amount }),
        }),
      hasCode('right_conflict'),
    );
  assert.throws(
    () =>
      first.reserve({
        rightId: right.rightId,
        request: request(right, { recipient: token }),
      }),
    hasCode('right_conflict'),
  );
  assert.throws(
    () =>
      first.reserve({
        rightId: right.rightId,
        request: request(right, { claimUsageId: word('99') }),
      }),
    hasCode('right_conflict'),
  );
  const allocation = first.reserve({ rightId: right.rightId, request: r });
  assert.deepEqual(
    first.reserve({ rightId: right.rightId, request: r }),
    allocation,
  );
  assert.equal(first.getPool({ issuerId, token }).pending, '1000');
  first.close();
  const restarted = open(t, path);
  assert.deepEqual(
    restarted.reserve({ rightId: right.rightId, request: r }),
    allocation,
  );
  assert.equal(restarted.getPool({ issuerId, token }).pending, '1000');
});

await test('rights accept only complete positive integer milligrams within the HTS amount range', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  for (const milligrams of [
    '0',
    '-1',
    '1.5',
    '01',
    '1e3',
    ' 1000',
    '9223372036854775808',
    '9'.repeat(79),
  ]) {
    assert.throws(
      () => register(ledger, 'invalid-right', milligrams),
      hasCode('invalid_input'),
    );
  }
  assert.equal(
    ledger.findRight({ sourceId, recordReference: 'invalid-right' }),
    null,
  );
  for (const recordReference of [
    '',
    ' padded ',
    'embedded\nnewline',
    'x'.repeat(513),
  ]) {
    assert.throws(
      () => register(ledger, recordReference),
      hasCode('invalid_input'),
    );
  }
});

await test('a reservation-opened observation cannot be mistaken for an issued obligation', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const r = request(right);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  ledger.reserve({ rightId: right.rightId, request: r });
  const opened = { ...issued(r), kind: 'reservation-opened' } as const;
  assert.throws(() => {
    // @ts-expect-error Opening a reservation does not authenticate an Issued event.
    ledger.markIssued(opened);
  }, hasCode('invalid_outcome'));
  assert.throws(() => {
    // @ts-expect-error A definitive unused observation is not an issuance observation.
    ledger.markIssued(unused(r));
  }, hasCode('invalid_outcome'));
  assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
  assert.equal(ledger.getPool({ issuerId, token }).outstanding, '0');
});

await test('pending and issued rights reject redelivery across issuer, policy, source re-signing, token, Gate and chain changes', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const r = request(right);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  ledger.reserve({ rightId: right.rightId, request: r });
  const changes = [
    { issuerId: word('23') },
    { policyVersion: '2' },
    { rightsVersion: '2' },
    { claimCommitment: word('34') },
    { token: gate },
    { gate: token },
    { chainId: '297' },
    { requestId: word('35'), reservationId: word('36'), nonce: '1' },
  ];
  for (const state of ['pending', 'issued']) {
    if (state === 'issued') ledger.markIssued(issued(r));
    for (const patch of changes)
      assert.throws(
        () =>
          ledger.reserve({
            rightId: right.rightId,
            request: request(right, patch),
          }),
        hasCode('right_unavailable'),
      );
    assert.equal(register(ledger).claimUsageId, right.claimUsageId);
    assert.equal(ledger.getRight(right.rightId).state, state);
  }
});

await test('caps cover aggregate exposure exactly above Number and SQLite integer precision', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const max = '9223372036854775807';
  const right = register(ledger, 'right-1', max);
  const other = register(ledger, 'right-2', max);
  const total = (2n * BigInt(max)).toString();
  ledger.setBackingCap({ issuerId, token, milligrams: total });
  const first = request(right);
  ledger.reserve({ rightId: right.rightId, request: first });
  ledger.reserve({
    rightId: other.rightId,
    request: request(other, {
      requestId: word('37'),
      reservationId: word('38'),
      nonce: '1',
    }),
  });
  ledger.markIssued(issued(first));
  assert.deepEqual(ledger.getPool({ issuerId, token }), {
    issuerId,
    token,
    cap: total,
    pending: max,
    outstanding: max,
  });
  assert.throws(
    () =>
      ledger.setBackingCap({
        issuerId,
        token,
        milligrams: (BigInt(total) - 1n).toString(),
      }),
    hasCode('cap_exceeded'),
  );
  const third = register(ledger, 'right-3', '1');
  assert.throws(
    () =>
      ledger.reserve({
        rightId: third.rightId,
        request: request(third, {
          requestId: word('39'),
          reservationId: word('3a'),
          nonce: '2',
        }),
      }),
    hasCode('cap_exceeded'),
  );
  assert.equal(ledger.getRight(third.rightId).state, 'available');
  const otherPool = { issuerId: word('24'), token } as const;
  assert.deepEqual(ledger.getPool(otherPool), {
    ...otherPool,
    cap: '0',
    pending: '0',
    outstanding: '0',
  });
});

await test('distinct pending and issued rights cannot share a request ID or holder nonce in the same Gate', (t) => {
  const { path } = storage(t);
  let ledger = open(t, path);
  const first = register(ledger, 'first-right');
  const second = register(ledger, 'second-right');
  const r = request(first);
  ledger.setBackingCap({ issuerId, token, milligrams: '2000' });
  const allocated = ledger.reserve({ rightId: first.rightId, request: r });
  for (const state of ['pending', 'issued']) {
    if (state === 'issued') ledger.markIssued(issued(r));
    ledger.close();
    ledger = open(t, path);
    for (const patch of [
      { requestId: r.requestId, nonce: '1', issuerId: word('23'), token: gate },
      {
        requestId: word('71'),
        nonce: r.nonce,
        issuerId: word('23'),
        token: gate,
      },
    ]) {
      const competing = request(second, {
        reservationId: word('72'),
        ...patch,
      });
      assert.throws(
        () => ledger.reserve({ rightId: second.rightId, request: competing }),
        hasCode('request_conflict'),
      );
      assert.equal(
        ledger.getAllocation(getIssuanceRequestDigest(competing)),
        null,
      );
    }
    assert.equal(ledger.getRight(second.rightId).state, 'available');
    assert.equal(
      ledger.reserve({ rightId: first.rightId, request: r }).state,
      state,
    );
  }
  assert.equal(
    allocated.state,
    'pending',
    'public snapshots do not mutate in place',
  );
  assert.deepEqual(ledger.getPool({ issuerId, token }), {
    issuerId,
    token,
    cap: '2000',
    pending: '0',
    outstanding: '1000',
  });
});

await test('request and holder-nonce locks follow the Gate and chain while nonce scope also includes the holder', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  ledger.setBackingCap({ issuerId, token, milligrams: '4000' });
  const first = register(ledger, 'scope-first');
  ledger.reserve({ rightId: first.rightId, request: request(first) });
  for (const [recordReference, patch] of [
    ['other-gate', { gate: token }],
    ['other-chain', { chainId: '297' }],
  ] as const) {
    const right = register(ledger, recordReference);
    assert.equal(
      ledger.reserve({ rightId: right.rightId, request: request(right, patch) })
        .state,
      'pending',
    );
  }
  const otherHolder = ledger.registerRight({
    sourceId,
    recordReference: 'other-holder',
    holder: token,
    milligrams: '1000',
  });
  assert.equal(
    ledger.reserve({
      rightId: otherHolder.rightId,
      request: request(otherHolder, {
        requestId: word('73'),
        reservationId: word('74'),
      }),
    }).state,
    'pending',
  );
  assert.equal(ledger.getPool({ issuerId, token }).pending, '4000');
});

await test('definitive unused release frees request ID and holder nonce but never a reservation ID', (t) => {
  const { path } = storage(t);
  let ledger = open(t, path);
  const first = register(ledger, 'release-first');
  const second = register(ledger, 'release-second');
  const third = register(ledger, 'release-third');
  const r = request(first);
  ledger.setBackingCap({ issuerId, token, milligrams: '3000' });
  ledger.reserve({ rightId: first.rightId, request: r });
  const released = ledger.releaseUnused(unused(r));
  ledger.close();
  ledger = open(t, path);
  assert.deepEqual(
    ledger.reserve({ rightId: first.rightId, request: r }),
    released,
  );
  const reused = request(second, { reservationId: word('75') });
  assert.equal(
    ledger.reserve({ rightId: second.rightId, request: reused }).state,
    'pending',
  );
  const reservationCollision = request(third, {
    requestId: word('76'),
    nonce: '1',
  });
  assert.throws(
    () =>
      ledger.reserve({ rightId: third.rightId, request: reservationCollision }),
    hasCode('request_conflict'),
  );
  assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
});

await test('release reasons must be literal enum strings without coercion or state changes', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const r = request(right);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  const pending = ledger.reserve({ rightId: right.rightId, request: r });
  const pool = ledger.getPool({ issuerId, token });
  let callbacks = 0;
  const reasons: unknown[] = [
    ['revoked-unused'],
    Object('expired-unused'),
    {
      toString() {
        callbacks++;
        return 'revoked-unused';
      },
    },
    {
      [Symbol.toPrimitive]() {
        callbacks++;
        return 'expired-unused';
      },
    },
  ];
  for (const reason of reasons) {
    assert.throws(
      () => ledger.releaseUnused({ ...unused(r), reason } as UnusedObservation),
      hasCode('invalid_outcome'),
    );
    assert.equal(callbacks, 0);
    assert.deepEqual(ledger.getPool({ issuerId, token }), pool);
    assert.deepEqual(ledger.getAllocation(pending.requestDigest), pending);
  }
  assert.equal(ledger.releaseUnused(unused(r)).state, 'released');
});

await test('timeout, absence and unbound observations cannot release pending; definitive unused release is idempotent', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const r = request(right, { validUntil: '1' }); // Wall-clock expiry is deliberately not a release mechanism.
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  ledger.reserve({ rightId: right.rightId, request: r });
  for (const patch of [
    { reason: 'timeout' },
    { reason: 'not-found' },
    { reservationReleased: false },
    { reservationUsed: '1' },
    { requestUsed: true },
    { claimUsed: true },
    { gate: token },
    { chainId: '297' },
    { reservationId: word('55') },
    { claimUsageId: word('56') },
  ]) {
    assert.throws(
      () =>
        ledger.releaseUnused({ ...unused(r), ...patch } as UnusedObservation),
      hasCode('invalid_outcome'),
    );
  }
  assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
  const released = ledger.releaseUnused(unused(r));
  assert.equal(released.state, 'released');
  assert.deepEqual(ledger.releaseUnused(unused(r)), released);
  assert.equal(ledger.getPool({ issuerId, token }).pending, '0');
  assert.equal(ledger.getRight(right.rightId).state, 'available');
  assert.deepEqual(
    ledger.reserve({ rightId: right.rightId, request: r }),
    released,
    'an exact retry cannot reopen a released request',
  );
  const replacement = request(right, {
    requestId: word('57'),
    reservationId: word('58'),
    gate: token,
  });
  assert.equal(
    ledger.reserve({ rightId: right.rightId, request: replacement }).state,
    'pending',
  );
  assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
});

await test('issued obligations survive restart and cannot expire, release or change terminal evidence', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  const r = request(right);
  ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
  ledger.reserve({ rightId: right.rightId, request: r });
  const settled = ledger.markIssued(issued(r));
  assert.deepEqual(ledger.markIssued(issued(r)), settled);
  ledger.close();
  const restarted = open(t, path);
  assert.deepEqual(
    restarted.getAllocation(getIssuanceRequestDigest(r)),
    settled,
  );
  assert.equal(restarted.getPool({ issuerId, token }).outstanding, '1000');
  assert.throws(
    () => restarted.releaseUnused({ ...unused(r), reason: 'expired-unused' }),
    hasCode('terminal_conflict'),
  );
  assert.throws(
    () => restarted.markIssued({ ...issued(r), transactionHash: word('59') }),
    hasCode('terminal_conflict'),
  );
  assert.throws(
    () => restarted.setBackingCap({ issuerId, token, milligrams: '0' }),
    hasCode('cap_exceeded'),
  );
  assert.equal(restarted.getRight(right.rightId).state, 'issued');
});

await test('private storage rejects memory, loose permissions, symlinks and foreign databases', (t) => {
  const { directory, path } = storage(t);
  assert.throws(
    () => openInstitutionLedger({ path: ':memory:' }),
    hasCode('unsafe_storage'),
  );
  assert.throws(
    () => openInstitutionLedger({ path: 'relative.sqlite' }),
    hasCode('unsafe_storage'),
  );
  chmodSync(directory, 0o755);
  assert.throws(
    () => openInstitutionLedger({ path }),
    hasCode('unsafe_storage'),
  );
  chmodSync(directory, 0o700);
  const ledger = open(t, path);
  ledger.close();
  chmodSync(path, 0o644);
  assert.throws(
    () => openInstitutionLedger({ path }),
    hasCode('unsafe_storage'),
  );
  chmodSync(path, 0o600);
  const link = join(directory, 'link.sqlite');
  symlinkSync(path, link);
  assert.throws(
    () => openInstitutionLedger({ path: link }),
    hasCode('unsafe_storage'),
  );
  const foreignPath = join(directory, 'foreign.sqlite');
  const foreign = new DatabaseSync(foreignPath);
  foreign.exec(
    "CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('preserve')",
  );
  foreign.close();
  chmodSync(foreignPath, 0o600);
  assert.throws(
    () => openInstitutionLedger({ path: foreignPath }),
    hasCode('unsupported_database'),
  );
  const inspectForeign = new DatabaseSync(foreignPath);
  assert.equal(
    inspectForeign.prepare('SELECT value FROM foreign_data').get()?.value,
    'preserve',
  );
  inspectForeign.close();
});

await test('older schema files missing replay indexes are rejected without migration or data mutation', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  ledger.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'DROP INDEX one_live_allocation_per_request_id; DROP INDEX one_live_allocation_per_holder_nonce; DROP INDEX one_allocation_per_reservation_id; PRAGMA user_version = 1;',
  );
  legacy.close();
  assert.throws(
    () => openInstitutionLedger({ path }),
    hasCode('unsupported_database'),
  );
  const preserved = new DatabaseSync(path);
  assert.equal(preserved.prepare('PRAGMA user_version').get()?.user_version, 1);
  assert.equal(
    preserved.prepare('SELECT right_id FROM asset_rights').get()?.right_id,
    right.rightId,
  );
  preserved.close();
});

await test('current version markers cannot admit missing or altered schema guarantees', async (t) => {
  function rewriteAllocations(
    database: DatabaseSync,
    change: (sql: string) => string,
  ) {
    const definition = database
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'allocations'")
      .get()?.sql;
    assert.equal(typeof definition, 'string');
    const indexes = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'allocations' AND sql IS NOT NULL",
      )
      .all();
    database.exec('DROP TABLE allocations');
    const changed = change(String(definition));
    assert.notEqual(changed, definition);
    database.exec(changed);
    for (const index of indexes) database.exec(String(index.sql));
  }
  const changes: Record<string, (database: DatabaseSync) => void> = {
    'missing replay index': (database) =>
      database.exec('DROP INDEX one_live_allocation_per_right'),
    'nonunique replay index': (database) =>
      database.exec(
        "DROP INDEX one_live_allocation_per_right; CREATE INDEX one_live_allocation_per_right ON allocations(right_id) WHERE state IN ('pending', 'issued')",
      ),
    'changed replay predicate': (database) =>
      database.exec(
        "DROP INDEX one_live_allocation_per_right; CREATE UNIQUE INDEX one_live_allocation_per_right ON allocations(right_id) WHERE state = 'issued'",
      ),
    'missing field': (database) =>
      rewriteAllocations(database, (sql) =>
        sql
          .replace('  observation_json TEXT,\n', '')
          .replace(
            ",\n  CHECK((state = 'pending' AND observation_json IS NULL) OR (state IN ('issued', 'released') AND observation_json IS NOT NULL))",
            '',
          ),
      ),
    'missing check constraint': (database) =>
      rewriteAllocations(database, (sql) =>
        sql.replace(" CHECK(state IN ('pending', 'issued', 'released'))", ''),
      ),
    'missing foreign key': (database) =>
      rewriteAllocations(database, (sql) =>
        sql.replace(' REFERENCES asset_rights(right_id)', ''),
      ),
    'missing strict typing': (database) =>
      rewriteAllocations(database, (sql) => sql.replace(/ STRICT$/, '')),
    'unexpected trigger': (database) =>
      database.exec(
        "CREATE TRIGGER alter_cap AFTER INSERT ON allocations BEGIN UPDATE backing_pools SET cap = '0'; END",
      ),
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, (t) => {
      const { path } = storage(t);
      const ledger = open(t, path);
      const right = register(ledger);
      ledger.close();
      const edited = new DatabaseSync(path);
      // These empty allocation-table rewrites model faulty migrations, not an untrusted writer.
      change(edited);
      const before = edited
        .prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name')
        .all();
      assert.equal(
        edited.prepare('PRAGMA user_version').get()?.user_version,
        3,
      );
      edited.close();
      assert.throws(
        () => openInstitutionLedger({ path }),
        hasCode('unsupported_database'),
      );
      const preserved = new DatabaseSync(path);
      assert.deepEqual(
        preserved
          .prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name')
          .all(),
        before,
      );
      assert.equal(
        preserved.prepare('SELECT right_id FROM asset_rights').get()?.right_id,
        right.rightId,
      );
      preserved.close();
    });
  }
});

await test('normal SQLite analysis does not invalidate a supported populated ledger', (t) => {
  const { path } = storage(t);
  const ledger = open(t, path);
  const right = register(ledger);
  ledger.close();
  const database = new DatabaseSync(path);
  database.exec('ANALYZE; VACUUM;');
  database.close();
  assert.deepEqual(register(open(t, path)), right);
});

async function race(t: TestContext, jobs: unknown[]) {
  const modulePath = fileURLToPath(new URL('../index.js', import.meta.url));
  const script = `
    import { openInstitutionLedger } from ${JSON.stringify(modulePath)};
    process.stdin.once('data', (bytes) => {
      const job = JSON.parse(bytes.toString());
      const ledger = openInstitutionLedger({ path: job.path });
      process.stdin.once('data', () => {
        try {
          const result = job.action === 'register' ? ledger.registerRight(job.input) : ledger.reserve(job.input);
          process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n');
        } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code }) + '\\n'); }
        ledger.close();
        process.stdin.destroy();
      });
      process.stdout.write('ready\\n');
    });
  `;
  const workers = jobs.map((job) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let ready!: () => void;
    let exited!: () => void;
    let resolveResult!: (result: {
      ok: boolean;
      code?: string;
      result?: { rightId: Hex; requestDigest: Hex };
    }) => void;
    let rejectResult!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const exitPromise = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const resultPromise = new Promise<{
      ok: boolean;
      code?: string;
      result?: { rightId: Hex; requestDigest: Hex };
    }>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let output = '';
    child.stdout.on('data', (bytes) => {
      output += String(bytes);
      while (output.includes('\n')) {
        const index = output.indexOf('\n');
        const line = output.slice(0, index);
        output = output.slice(index + 1);
        if (line === 'ready') ready();
        else resolveResult(JSON.parse(line));
      }
    });
    child.on('error', (error) => {
      ready();
      exited();
      rejectResult(error);
    });
    child.on('exit', (code) => {
      ready();
      exited();
      if (code !== 0)
        rejectResult(new Error('Concurrent ledger process failed'));
    });
    child.stdin.write(JSON.stringify(job));
    return { child, readyPromise, resultPromise, exitPromise };
  });
  await Promise.all(workers.map((worker) => worker.readyPromise));
  for (const worker of workers) worker.child.stdin.write('go\n');
  const results = await Promise.all(
    workers.map((worker) => worker.resultPromise),
  );
  await Promise.all(workers.map((worker) => worker.exitPromise));
  return results;
}

await test(
  'concurrent processes converge on one stable right and reject competing allocations',
  { timeout: 15000 },
  async (t) => {
    const { path } = storage(t);
    const ledger = open(t, path);
    const input = {
      sourceId,
      recordReference: 'same-private-record',
      holder,
      milligrams: '1000',
    };
    const registered = await race(
      t,
      [0, 1].map(() => ({ path, action: 'register', input })),
    );
    assert.ok(registered.every((result) => result.ok));
    assert.equal(registered[0].result?.rightId, registered[1].result?.rightId);
    const right = ledger.findRight({
      sourceId,
      recordReference: input.recordReference,
    })!;
    ledger.setBackingCap({ issuerId, token, milligrams: '2000' });
    const requests = [
      request(right),
      request(right, { requestId: word('61'), gate: token }),
    ];
    const results = await race(
      t,
      requests.map((r) => ({
        path,
        action: 'reserve',
        input: { rightId: right.rightId, request: r },
      })),
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.find((result) => !result.ok)?.code,
      'right_unavailable',
    );
    assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
  },
);

await test(
  'concurrent exact retries return one allocation and independent rights compete for the same cap',
  { timeout: 15000 },
  async (t) => {
    const { path } = storage(t);
    const ledger = open(t, path);
    const right = register(ledger);
    const r = request(right);
    ledger.setBackingCap({ issuerId, token, milligrams: '1000' });
    const retried = await race(
      t,
      [0, 1].map(() => ({
        path,
        action: 'reserve',
        input: { rightId: right.rightId, request: r },
      })),
    );
    assert.ok(retried.every((result) => result.ok));
    assert.equal(
      retried[0].result?.requestDigest,
      retried[1].result?.requestDigest,
    );
    assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
    ledger.releaseUnused(unused(r));
    const other = register(ledger, 'second-right');
    const jobs = [right, other].map((asset, index) => ({
      path,
      action: 'reserve',
      input: {
        rightId: asset.rightId,
        request: request(asset, {
          requestId: index ? word('62') : word('63'),
          reservationId: index ? word('64') : word('65'),
          nonce: String(index),
        }),
      },
    }));
    const results = await race(t, jobs);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok)?.code, 'cap_exceeded');
    assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
  },
);

await test(
  'concurrent processes reserve each request ID, holder nonce and permanent reservation ID once',
  { timeout: 15000 },
  async (t) => {
    for (const collision of ['request-id', 'holder-nonce', 'reservation-id']) {
      await t.test(collision, async (subtest) => {
        const { path } = storage(subtest);
        const ledger = open(subtest, path);
        const first = register(ledger, 'concurrent-first');
        const second = register(ledger, 'concurrent-second');
        ledger.setBackingCap({ issuerId, token, milligrams: '2000' });
        const secondRequest = request(second, {
          requestId: collision === 'request-id' ? word('31') : word('77'),
          nonce: collision === 'holder-nonce' ? '0' : '1',
          reservationId:
            collision === 'reservation-id' ? word('32') : word('78'),
        });
        const results = await race(subtest, [
          {
            path,
            action: 'reserve',
            input: { rightId: first.rightId, request: request(first) },
          },
          {
            path,
            action: 'reserve',
            input: { rightId: second.rightId, request: secondRequest },
          },
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        assert.equal(
          results.find((result) => !result.ok)?.code,
          'request_conflict',
        );
        assert.equal(ledger.getPool({ issuerId, token }).pending, '1000');
      });
    }
  },
);
