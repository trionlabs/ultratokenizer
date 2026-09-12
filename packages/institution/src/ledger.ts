import { randomBytes } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { inspect } from 'node:util';
import {
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  getClaimUsageId,
  getIssuanceRequestDigest,
  parseIssuanceRequest,
} from '../../domain/src/index.js';
import type {
  Allocation,
  AllocationState,
  BackingPool,
  ChainObservation,
  ExpiredUnopenedObservation,
  InstitutionLedger,
  InstitutionRight,
  IssuedObservation,
  PrivateClaimIdentity,
  RightState,
  UnusedObservation,
} from './types.js';

const messages = {
  invalid_input: 'The institution ledger input is invalid.',
  unsafe_storage:
    'The ledger requires a private directory and a regular private database file.',
  unsupported_database: 'The database is not a supported institution ledger.',
  storage_unavailable: 'The institution ledger operation could not complete.',
  right_not_found: 'The institutional right is not registered.',
  right_conflict: 'The stable right already has different immutable terms.',
  right_unavailable: 'The right already has a pending or issued allocation.',
  request_conflict: 'The request identifiers conflict with another allocation.',
  allocation_not_found: 'The requested allocation does not exist.',
  cap_exceeded:
    'The backing cap cannot cover the pending and outstanding exposure.',
  invalid_outcome: 'A matching definitive chain outcome is required.',
  terminal_conflict: 'A terminal allocation cannot change state.',
  private_identity: 'Private source identity cannot be serialized.',
  closed: 'The institution ledger is closed.',
} as const;

export class InstitutionLedgerError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'InstitutionLedgerError';
  }
}

type Row = Record<string, SQLOutputValue>;
const MAX_AMOUNT = (1n << 63n) - 1n;
const MAX_UINT = (1n << 256n) - 1n;
const APPLICATION_ID = 0x55544c47;
const SCHEMA_VERSION = 3;

function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new InstitutionLedgerError('invalid_input');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    throw new InstitutionLedgerError('invalid_input');
  return value as Record<string, unknown>;
}
function hash(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    /^0x0+$/.test(value)
  )
    throw new InstitutionLedgerError('invalid_input');
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Address {
  if (
    typeof value !== 'string' ||
    !isAddress(value, { strict: true }) ||
    getAddress(value) === zeroAddress
  )
    throw new InstitutionLedgerError('invalid_input');
  return getAddress(value);
}
function integer(value: unknown, maximum = MAX_UINT, zero = false): string {
  if (
    typeof value !== 'string' ||
    value.length > 78 ||
    !(zero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value) ||
    BigInt(value) > maximum
  )
    throw new InstitutionLedgerError('invalid_input');
  return value;
}
function reference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  )
    throw new InstitutionLedgerError('invalid_input');
  return value;
}
function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string')
    throw new InstitutionLedgerError('storage_unavailable');
  return value;
}
function opaqueId(): Hex {
  let value: Hex;
  do {
    value = `0x${randomBytes(32).toString('hex')}`;
  } while (/^0x0+$/.test(value));
  return value;
}

class PrivateIdentity implements PrivateClaimIdentity {
  #sourceId: Hex;
  #claimId: Hex;
  constructor(sourceId: Hex, claimId: Hex) {
    this.#sourceId = sourceId;
    this.#claimId = claimId;
    Object.freeze(this);
  }
  get sourceId() {
    return this.#sourceId;
  }
  get claimId() {
    return this.#claimId;
  }
  toJSON(): never {
    throw new InstitutionLedgerError('private_identity');
  }
  [inspect.custom]() {
    return '[PrivateClaimIdentity: redacted]';
  }
}

function privatePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !isAbsolute(value) ||
    value.includes('\0') ||
    !/\.(?:sqlite|sqlite3|db)$/.test(value)
  )
    throw new InstitutionLedgerError('unsafe_storage');
  try {
    const requested = resolve(value);
    const directory = dirname(requested);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    const uid = process.getuid?.();
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o777) !== 0o700 ||
      (uid !== undefined && parent.uid !== uid)
    )
      throw new InstitutionLedgerError('unsafe_storage');
    const path = join(realpathSync(directory), basename(requested));
    try {
      const fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(fd);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        )
      )
        throw error;
    }
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      (file.mode & 0o777) !== 0o600 ||
      (uid !== undefined && file.uid !== uid)
    )
      throw new InstitutionLedgerError('unsafe_storage');
    return path;
  } catch (error) {
    if (error instanceof InstitutionLedgerError) throw error;
    throw new InstitutionLedgerError('unsafe_storage');
  }
}

const schema = `
CREATE TABLE asset_rights (
  right_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  record_reference TEXT NOT NULL,
  claim_id TEXT NOT NULL UNIQUE,
  claim_usage_id TEXT NOT NULL UNIQUE,
  holder TEXT NOT NULL,
  milligrams TEXT NOT NULL CHECK(length(milligrams) BETWEEN 1 AND 19 AND milligrams NOT GLOB '*[^0-9]*' AND substr(milligrams,1,1) <> '0'),
  UNIQUE(source_id, record_reference)
) STRICT;
CREATE TABLE backing_pools (
  issuer_id TEXT NOT NULL,
  token TEXT NOT NULL,
  cap TEXT NOT NULL CHECK(cap = '0' OR (length(cap) BETWEEN 1 AND 78 AND cap NOT GLOB '*[^0-9]*' AND substr(cap,1,1) <> '0')),
  PRIMARY KEY(issuer_id, token)
) STRICT;
CREATE TABLE allocations (
  request_digest TEXT PRIMARY KEY,
  right_id TEXT NOT NULL REFERENCES asset_rights(right_id),
  issuer_id TEXT NOT NULL,
  token TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  request_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  holder_nonce TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  milligrams TEXT NOT NULL CHECK(length(milligrams) BETWEEN 1 AND 19 AND milligrams NOT GLOB '*[^0-9]*' AND substr(milligrams,1,1) <> '0'),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'issued', 'released')),
  observation_json TEXT,
  FOREIGN KEY(issuer_id, token) REFERENCES backing_pools(issuer_id, token),
  CHECK((state = 'pending' AND observation_json IS NULL) OR (state IN ('issued', 'released') AND observation_json IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_live_allocation_per_right ON allocations(right_id) WHERE state IN ('pending', 'issued');
CREATE UNIQUE INDEX one_live_allocation_per_request_id ON allocations(chain_id, gate, request_id) WHERE state IN ('pending', 'issued');
CREATE UNIQUE INDEX one_live_allocation_per_holder_nonce ON allocations(chain_id, gate, recipient, holder_nonce) WHERE state IN ('pending', 'issued');
CREATE UNIQUE INDEX one_allocation_per_reservation_id ON allocations(chain_id, gate, issuer_id, reservation_id);
CREATE INDEX allocation_exposure ON allocations(issuer_id, token, state);
`;

function schemaDefinition(database: DatabaseSync): string {
  // Compare SQLite's stored definitions, including implicit unique indexes, but
  // omit SQLite's own ANALYZE statistics tables. Root pages and row data vary.
  return JSON.stringify(
    database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT IN ('sqlite_stat1', 'sqlite_stat4') ORDER BY type, name",
      )
      .all(),
  );
}

let expectedSchema: string | undefined;
function supportedSchema(): string {
  if (expectedSchema === undefined) {
    // Use the same SQLite parser and creation recipe as a real new ledger.
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(schema);
      expectedSchema = schemaDefinition(reference);
    } finally {
      reference.close();
    }
  }
  return expectedSchema;
}

/** Node-only trusted institution module. Observations are caller assertions, not chain authentication. */
export function openInstitutionLedger(options: {
  path: string;
  upgradeFromVersion?: 2;
}): InstitutionLedger {
  const input = record(
    options,
    options && Object.hasOwn(options, 'upgradeFromVersion')
      ? ['path', 'upgradeFromVersion']
      : ['path'],
  );
  if (
    Object.hasOwn(input, 'upgradeFromVersion') &&
    input.upgradeFromVersion !== 2
  )
    throw new InstitutionLedgerError('invalid_input');
  const path = privatePath(input.path);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
  } catch {
    throw new InstitutionLedgerError('storage_unavailable');
  }
  let closed = false;

  function statement(sql: string) {
    const query = database.prepare(sql);
    query.setReadBigInts(true);
    return query;
  }
  function one(sql: string, ...values: string[]): Row | undefined {
    return statement(sql).get(...values);
  }
  function transaction<T>(write: boolean, action: () => T): T {
    if (closed) throw new InstitutionLedgerError('closed');
    let started = false;
    try {
      database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      started = true;
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (started) {
        try {
          database.exec('ROLLBACK');
        } catch {
          /* Do not replace the sanitized error. */
        }
      }
      if (error instanceof InstitutionLedgerError) throw error;
      // Never expose SQLite diagnostics, file paths, SQL parameters or private references.
      throw new InstitutionLedgerError('storage_unavailable');
    }
  }
  try {
    database.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA synchronous = EXTRA;',
    );
    transaction(true, () => {
      const application = one('PRAGMA application_id')?.application_id;
      const version = one('PRAGMA user_version')?.user_version;
      if (
        application === 0n &&
        version === 0n &&
        !one(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
        )
      ) {
        database.exec(schema);
        database.exec(
          `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`,
        );
      } else if (
        application !== BigInt(APPLICATION_ID) ||
        (version !== BigInt(SCHEMA_VERSION) &&
          !(version === 2n && input.upgradeFromVersion === 2))
      )
        throw new InstitutionLedgerError('unsupported_database');
      if (schemaDefinition(database) !== supportedSchema())
        throw new InstitutionLedgerError('unsupported_database');
      // Version 3 introduces a distinct terminal observation without changing DDL.
      // Explicit opt-in is required; old writers must be stopped before upgrading.
      if (version === 2n)
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
    // Node 22.17 embeds SQLite 3.50.0, predating the WAL-reset race fix.
    // Keep rollback journaling; EXTRA also syncs its directory after commit deletion.
    if (
      one('PRAGMA journal_mode = DELETE')?.journal_mode !== 'delete' ||
      one('PRAGMA synchronous')?.synchronous !== 3n
    )
      throw new InstitutionLedgerError('storage_unavailable');
  } catch (error) {
    try {
      database.close();
    } catch {
      /* Preserve a sanitized failure. */
    }
    if (error instanceof InstitutionLedgerError) throw error;
    throw new InstitutionLedgerError('storage_unavailable');
  }

  function rightRow(id: Hex): Row {
    const row = one('SELECT * FROM asset_rights WHERE right_id = ?', id);
    if (!row) throw new InstitutionLedgerError('right_not_found');
    return row;
  }
  function rightSnapshot(row: Row): InstitutionRight {
    const active = one(
      "SELECT state FROM allocations WHERE right_id = ? AND state IN ('pending','issued')",
      text(row, 'right_id'),
    );
    return Object.freeze({
      rightId: hash(row.right_id),
      sourceId: hash(row.source_id),
      claimUsageId: hash(row.claim_usage_id),
      holder: address(row.holder),
      milligrams: integer(row.milligrams, MAX_AMOUNT),
      state: (active ? text(active, 'state') : 'available') as RightState,
    });
  }
  function poolSnapshot(issuerId: Hex, token: Address): BackingPool {
    const row = one(
      'SELECT cap FROM backing_pools WHERE issuer_id = ? AND token = ?',
      issuerId,
      token,
    );
    const cap = row ? integer(row.cap, MAX_UINT, true) : '0';
    let pending = 0n;
    let outstanding = 0n;
    // Derived from immutable amounts and terminal states; there is no independently drifting counter.
    for (const allocation of statement(
      "SELECT milligrams,state FROM allocations WHERE issuer_id = ? AND token = ? AND state IN ('pending','issued')",
    ).all(issuerId, token)) {
      const amount = BigInt(integer(allocation.milligrams, MAX_AMOUNT));
      if (allocation.state === 'pending') pending += amount;
      else outstanding += amount;
    }
    if (pending + outstanding > BigInt(cap))
      throw new InstitutionLedgerError('storage_unavailable');
    return Object.freeze({
      issuerId,
      token,
      cap,
      pending: pending.toString(),
      outstanding: outstanding.toString(),
    });
  }
  function allocationSnapshot(row: Row): Allocation {
    return Object.freeze({
      rightId: hash(row.right_id),
      requestDigest: hash(row.request_digest),
      request: parseIssuanceRequest(JSON.parse(text(row, 'request_json'))),
      state: text(row, 'state') as AllocationState,
      observation:
        row.observation_json === null
          ? null
          : Object.freeze(JSON.parse(text(row, 'observation_json'))),
    });
  }
  const observationFields = [
    'kind',
    'requestDigest',
    'chainId',
    'gate',
    'reservationId',
    'claimUsageId',
    'blockHash',
    'blockNumber',
  ] as const;
  function observation(
    value: unknown,
    kind: 'issued' | 'unused' | 'expired-unopened',
  ): IssuedObservation | UnusedObservation | ExpiredUnopenedObservation {
    try {
      const data = record(value, [
        ...observationFields,
        ...(kind === 'issued'
          ? ['transactionHash']
          : kind === 'expired-unopened'
            ? [
                'blockTimestamp',
                'reservationAbsent',
                'requestUsed',
                'claimUsed',
              ]
            : [
                'reason',
                'reservationReleased',
                'reservationUsed',
                'requestUsed',
                'claimUsed',
              ]),
      ]);
      if (data.kind !== kind) throw new Error();
      const common: ChainObservation = {
        requestDigest: hash(data.requestDigest),
        chainId: integer(data.chainId),
        gate: address(data.gate),
        reservationId: hash(data.reservationId),
        claimUsageId: hash(data.claimUsageId),
        blockHash: hash(data.blockHash),
        blockNumber: integer(data.blockNumber, MAX_UINT, true),
      };
      if (kind === 'issued')
        return Object.freeze({
          ...common,
          kind: 'issued',
          transactionHash: hash(data.transactionHash),
        });
      if (kind === 'expired-unopened') {
        if (
          data.reservationAbsent !== true ||
          data.requestUsed !== false ||
          data.claimUsed !== false
        )
          throw new Error();
        return Object.freeze({
          ...common,
          kind,
          blockTimestamp: integer(data.blockTimestamp, MAX_UINT, true),
          reservationAbsent: true,
          requestUsed: false,
          claimUsed: false,
        });
      }
      if (
        (data.reason !== 'revoked-unused' &&
          data.reason !== 'expired-unused') ||
        data.reservationReleased !== true ||
        data.reservationUsed !== '0' ||
        data.requestUsed !== false ||
        data.claimUsed !== false
      )
        throw new Error();
      return Object.freeze({
        ...common,
        kind: 'unused',
        reason: data.reason,
        reservationReleased: true,
        reservationUsed: '0',
        requestUsed: false,
        claimUsed: false,
      });
    } catch {
      throw new InstitutionLedgerError('invalid_outcome');
    }
  }
  function settle(
    value: unknown,
    kind: 'issued' | 'unused' | 'expired-unopened',
  ): Allocation {
    const outcome = observation(value, kind);
    return transaction(true, () => {
      const row = one(
        'SELECT * FROM allocations WHERE request_digest = ?',
        outcome.requestDigest,
      );
      if (!row) throw new InstitutionLedgerError('allocation_not_found');
      const current = allocationSnapshot(row);
      const request = current.request;
      if (
        request.chainId !== outcome.chainId ||
        request.gate !== outcome.gate ||
        request.reservationId !== outcome.reservationId ||
        request.claimUsageId !== outcome.claimUsageId ||
        (outcome.kind === 'expired-unopened' &&
          BigInt(outcome.blockTimestamp) < BigInt(request.validUntil))
      )
        throw new InstitutionLedgerError('invalid_outcome');
      const target = kind === 'issued' ? 'issued' : 'released';
      if (current.state !== 'pending') {
        if (
          current.state !== target ||
          JSON.stringify(current.observation) !== JSON.stringify(outcome)
        )
          throw new InstitutionLedgerError('terminal_conflict');
        return current;
      }
      statement(
        'UPDATE allocations SET state = ?, observation_json = ? WHERE request_digest = ? AND state = ?',
      ).run(target, JSON.stringify(outcome), outcome.requestDigest, 'pending');
      return allocationSnapshot(
        one(
          'SELECT * FROM allocations WHERE request_digest = ?',
          outcome.requestDigest,
        )!,
      );
    });
  }

  return Object.freeze<InstitutionLedger>({
    registerRight(value) {
      const data = record(value, [
        'sourceId',
        'recordReference',
        'holder',
        'milligrams',
      ]);
      const sourceId = hash(data.sourceId);
      const recordReference = reference(data.recordReference);
      const holder = address(data.holder);
      const milligrams = integer(data.milligrams, MAX_AMOUNT);
      return transaction(true, () => {
        const existing = one(
          'SELECT * FROM asset_rights WHERE source_id = ? AND record_reference = ?',
          sourceId,
          recordReference,
        );
        if (existing) {
          if (existing.holder !== holder || existing.milligrams !== milligrams)
            throw new InstitutionLedgerError('right_conflict');
          return rightSnapshot(existing);
        }
        const rightId = opaqueId();
        const claimId = opaqueId();
        const claimUsageId = getClaimUsageId({ sourceId, claimId });
        statement(
          'INSERT INTO asset_rights (right_id,source_id,record_reference,claim_id,claim_usage_id,holder,milligrams) VALUES (?,?,?,?,?,?,?)',
        ).run(
          rightId,
          sourceId,
          recordReference,
          claimId,
          claimUsageId,
          holder,
          milligrams,
        );
        return rightSnapshot(rightRow(rightId));
      });
    },
    findRight(value) {
      const data = record(value, ['sourceId', 'recordReference']);
      const sourceId = hash(data.sourceId);
      const recordReference = reference(data.recordReference);
      return transaction(false, () => {
        const row = one(
          'SELECT * FROM asset_rights WHERE source_id = ? AND record_reference = ?',
          sourceId,
          recordReference,
        );
        return row ? rightSnapshot(row) : null;
      });
    },
    getRight(value) {
      const rightId = hash(value);
      return transaction(false, () => rightSnapshot(rightRow(rightId)));
    },
    privateClaimIdentity(value) {
      const rightId = hash(value);
      return transaction(false, () => {
        const row = rightRow(rightId);
        return new PrivateIdentity(hash(row.source_id), hash(row.claim_id));
      });
    },
    setBackingCap(value) {
      const data = record(value, ['issuerId', 'token', 'milligrams']);
      const issuerId = hash(data.issuerId);
      const token = address(data.token);
      const cap = integer(data.milligrams, MAX_UINT, true);
      return transaction(true, () => {
        const pool = poolSnapshot(issuerId, token);
        if (BigInt(cap) < BigInt(pool.pending) + BigInt(pool.outstanding))
          throw new InstitutionLedgerError('cap_exceeded');
        statement(
          'INSERT INTO backing_pools (issuer_id,token,cap) VALUES (?,?,?) ON CONFLICT(issuer_id,token) DO UPDATE SET cap=excluded.cap',
        ).run(issuerId, token, cap);
        return poolSnapshot(issuerId, token);
      });
    },
    getPool(value) {
      const data = record(value, ['issuerId', 'token']);
      const issuerId = hash(data.issuerId);
      const token = address(data.token);
      return transaction(false, () => poolSnapshot(issuerId, token));
    },
    reserve(value) {
      const data = record(value, ['rightId', 'request']);
      const rightId = hash(data.rightId);
      let request;
      try {
        request = parseIssuanceRequest(data.request);
        integer(request.amount, MAX_AMOUNT);
      } catch {
        throw new InstitutionLedgerError('invalid_input');
      }
      const digest = getIssuanceRequestDigest(request);
      const serialized = JSON.stringify(request);
      return transaction(true, () => {
        const right = rightRow(rightId);
        if (
          right.holder !== request.recipient ||
          right.milligrams !== request.amount ||
          right.claim_usage_id !== request.claimUsageId
        )
          throw new InstitutionLedgerError('right_conflict');
        const existing = one(
          'SELECT * FROM allocations WHERE request_digest = ?',
          digest,
        );
        if (existing) {
          if (
            existing.right_id !== rightId ||
            existing.request_json !== serialized
          )
            throw new InstitutionLedgerError('request_conflict');
          return allocationSnapshot(existing);
        }
        if (
          one(
            "SELECT request_digest FROM allocations WHERE right_id = ? AND state IN ('pending','issued')",
            rightId,
          )
        )
          throw new InstitutionLedgerError('right_unavailable');
        if (
          one(
            "SELECT request_digest FROM allocations WHERE chain_id = ? AND gate = ? AND ((state IN ('pending','issued') AND (request_id = ? OR (recipient = ? AND holder_nonce = ?))) OR (issuer_id = ? AND reservation_id = ?)) LIMIT 1",
            request.chainId,
            request.gate,
            request.requestId,
            request.recipient,
            request.nonce,
            request.issuerId,
            request.reservationId,
          )
        )
          throw new InstitutionLedgerError('request_conflict');
        const pool = poolSnapshot(request.issuerId, request.token);
        if (
          BigInt(pool.pending) +
            BigInt(pool.outstanding) +
            BigInt(request.amount) >
          BigInt(pool.cap)
        )
          throw new InstitutionLedgerError('cap_exceeded');
        statement(
          'INSERT INTO allocations (request_digest,right_id,issuer_id,token,chain_id,gate,request_id,recipient,holder_nonce,reservation_id,milligrams,request_json,state,observation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
        ).run(
          digest,
          rightId,
          request.issuerId,
          request.token,
          request.chainId,
          request.gate,
          request.requestId,
          request.recipient,
          request.nonce,
          request.reservationId,
          request.amount,
          serialized,
          'pending',
        );
        return allocationSnapshot(
          one('SELECT * FROM allocations WHERE request_digest = ?', digest)!,
        );
      });
    },
    getAllocation(value) {
      const digest = hash(value);
      return transaction(false, () => {
        const row = one(
          'SELECT * FROM allocations WHERE request_digest = ?',
          digest,
        );
        return row ? allocationSnapshot(row) : null;
      });
    },
    markIssued(value) {
      return settle(value, 'issued');
    },
    releaseUnused(value) {
      return settle(value, 'unused');
    },
    releaseExpiredUnopened(value) {
      return settle(value, 'expired-unopened');
    },
    close() {
      if (closed) return;
      try {
        database.close();
        closed = true;
      } catch {
        throw new InstitutionLedgerError('storage_unavailable');
      }
    },
  });
}
