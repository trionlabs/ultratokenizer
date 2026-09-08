import { DurableObject } from 'cloudflare:workers';
import type { Hex } from 'viem';
import {
  assertIssuanceRequestActive,
  getIssuanceRequestDigest,
} from '../../../packages/domain/src/index.js';
import type { IssuanceRequest } from '../../../packages/domain/src/index.js';
import {
  isHash,
  observeIssuance,
  type ChainConfiguration,
} from './chain-observer.ts';
import { WorkerError } from './errors.ts';
import {
  LEASE_MS,
  MAX_OBSERVATIONS,
  publicState,
  retryDelay,
  type RequestState,
  type PublicRequestState,
} from './model.ts';

export function chainConfiguration(env: IssuanceEnv): ChainConfiguration {
  return {
    rpcUrl: env.RPC_URL,
    chainId: env.CHAIN_ID,
    gate: env.GATE_ADDRESS,
    codeHash: env.GATE_CODE_HASH,
    confirmations: Number(env.MIN_CONFIRMATIONS),
  };
}

/** One coordinator per canonical request, persisted before any external I/O. */
export class IssuanceCoordinator extends DurableObject<IssuanceEnv> {
  constructor(ctx: DurableObjectState, env: IssuanceEnv) {
    super(ctx, env);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS requests (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL, state TEXT NOT NULL)',
      );
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL)',
      );
    });
  }

  private load(): RequestState | null {
    const rows = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM requests WHERE singleton = 1')
      .toArray();
    return rows[0] ? (JSON.parse(rows[0].state) as RequestState) : null;
  }

  private save(state: RequestState): void {
    // Synchronous transaction prevents a status/event split on storage failure.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'INSERT INTO requests(singleton, revision, state) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, state = excluded.state',
        state.revision,
        JSON.stringify(state),
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO events(sequence, at, status) VALUES (?, ?, ?)',
        state.revision,
        state.updatedAt,
        state.status,
      );
      this.ctx.storage.sql.exec(
        'DELETE FROM events WHERE sequence <= ?',
        state.revision - 128,
      );
    });
  }

  private owned(ownerId: string): RequestState {
    const state = this.load();
    // Do not reveal existence across subjects.
    if (!state || state.ownerId !== ownerId) throw new WorkerError('not_found');
    return state;
  }

  async create(
    ownerId: string,
    request: IssuanceRequest,
  ): Promise<PublicRequestState> {
    assertIssuanceRequestActive(request, BigInt(Math.floor(Date.now() / 1000)));
    const id = getIssuanceRequestDigest(request);
    const current = this.load();
    if (current) {
      if (current.ownerId !== ownerId || current.id !== id)
        throw new WorkerError('conflict');
      return publicState(current);
    }
    const now = Date.now();
    const state: RequestState = {
      schemaVersion: 1,
      id,
      ownerId,
      request,
      status: 'awaiting_submission',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      transactionHash: null,
      priorTransactionHashes: [],
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      nextCheckAt: null,
      observation: null,
    };
    this.save(state);
    return publicState(state);
  }

  async inspect(ownerId: string): Promise<PublicRequestState> {
    const state = this.owned(ownerId);
    // Also repair an alarm if a caller lost the response while scheduling it.
    if (
      (state.status === 'submitted' || state.status === 'checking') &&
      state.nextCheckAt !== null &&
      (await this.ctx.storage.getAlarm()) === null
    )
      await this.ctx.storage.setAlarm(Math.max(Date.now(), state.nextCheckAt));
    return publicState(state);
  }

  async submit(
    ownerId: string,
    transactionHash: Hex,
  ): Promise<PublicRequestState> {
    if (!isHash(transactionHash)) throw new WorkerError('invalid_request');
    const state = this.owned(ownerId);
    if (state.transactionHash !== null) {
      if (state.transactionHash !== transactionHash)
        return this.resolveReplacement(ownerId, state, transactionHash);
      return this.inspect(ownerId);
    }
    if (state.status !== 'awaiting_submission')
      throw new WorkerError('conflict');
    // Submission can be reported after request expiry: the transaction may already have finalized.
    const now = Date.now();
    const next: RequestState = {
      ...state,
      status: 'submitted',
      transactionHash,
      updatedAt: now,
      revision: state.revision + 1,
      nextCheckAt: now + 1_000,
    };
    // Alarm and record share storage's transaction, so a process loss cannot strand submitted work.
    await this.ctx.storage.transaction(async (storage) => {
      await storage.setAlarm(next.nextCheckAt!);
      this.save(next);
    });
    return publicState(next);
  }

  /** Accept a correction only after the candidate itself has confirmed this exact request. */
  private async resolveReplacement(
    ownerId: string,
    state: RequestState,
    candidate: Hex,
  ): Promise<PublicRequestState> {
    if (
      state.status === 'confirmed' ||
      state.status === 'tracking_cancelled' ||
      state.priorTransactionHashes.length >= 8
    )
      throw new WorkerError('conflict');
    const observation = await observeIssuance(
      state.request,
      candidate,
      chainConfiguration(this.env),
    );
    if (observation.outcome !== 'confirmed') throw new WorkerError('conflict');
    const latest = this.owned(ownerId);
    if (latest.revision !== state.revision || !state.transactionHash)
      throw new WorkerError('conflict');
    const next: RequestState = {
      ...latest,
      status: 'confirmed',
      transactionHash: candidate,
      priorTransactionHashes: [
        ...state.priorTransactionHashes,
        state.transactionHash,
      ],
      observation,
      revision: latest.revision + 1,
      updatedAt: Date.now(),
      leaseId: null,
      leaseUntil: null,
      nextCheckAt: null,
    };
    await this.ctx.storage.transaction(async (storage) => {
      await storage.deleteAlarm();
      this.save(next);
    });
    return publicState(next);
  }

  async cancel(ownerId: string): Promise<PublicRequestState> {
    const state = this.owned(ownerId);
    if (state.status === 'tracking_cancelled') return publicState(state);
    if (state.status !== 'awaiting_submission')
      throw new WorkerError('conflict');
    const next: RequestState = {
      ...state,
      status: 'tracking_cancelled',
      updatedAt: Date.now(),
      revision: state.revision + 1,
    };
    this.save(next);
    return publicState(next);
  }

  /** Restart read-only observation after an outage. Never resubmit or release backing. */
  async reconcile(ownerId: string): Promise<PublicRequestState> {
    const state = this.owned(ownerId);
    if (
      state.status === 'submitted' ||
      state.status === 'checking' ||
      state.status === 'confirmed'
    )
      return this.inspect(ownerId);
    if (state.status !== 'attention_required' || !state.transactionHash)
      throw new WorkerError('conflict');
    const now = Date.now();
    if (now - state.updatedAt < 60_000) throw new WorkerError('rate_limited');
    const next: RequestState = {
      ...state,
      status: 'submitted',
      attempts: 0,
      updatedAt: now,
      revision: state.revision + 1,
      nextCheckAt: now + 1_000,
      leaseId: null,
      leaseUntil: null,
    };
    await this.ctx.storage.transaction(async (storage) => {
      await storage.setAlarm(next.nextCheckAt!);
      this.save(next);
    });
    return publicState(next);
  }

  async alarm(): Promise<void> {
    const state = this.load();
    if (
      !state ||
      !state.transactionHash ||
      !['submitted', 'checking'].includes(state.status)
    )
      return;
    const now = Date.now();
    if (
      state.status === 'checking' &&
      state.leaseUntil !== null &&
      now < state.leaseUntil
    ) {
      await this.ctx.storage.setAlarm(state.leaseUntil);
      return;
    }
    if (state.nextCheckAt !== null && now < state.nextCheckAt) {
      await this.ctx.storage.setAlarm(state.nextCheckAt);
      return;
    }
    const leaseId = crypto.randomUUID();
    const checking: RequestState = {
      ...state,
      status: 'checking',
      revision: state.revision + 1,
      updatedAt: now,
      attempts: state.attempts + 1,
      leaseId,
      leaseUntil: now + LEASE_MS,
      nextCheckAt: now + LEASE_MS,
    };
    await this.ctx.storage.transaction(async (storage) => {
      await storage.setAlarm(checking.leaseUntil!);
      this.save(checking);
    });
    let observation;
    try {
      observation = await observeIssuance(
        checking.request,
        checking.transactionHash!,
        chainConfiguration(this.env),
      );
    } catch {
      observation = { outcome: 'pending', reason: 'rpc_unavailable' } as const;
    }
    const latest = this.load();
    // A stale execution cannot overwrite a newer lease after a restart or delayed network call.
    if (
      !latest ||
      latest.leaseId !== leaseId ||
      latest.revision !== checking.revision
    )
      return;
    const finishedAt = Date.now();
    const pending = observation.outcome === 'pending';
    const retry = pending && latest.attempts < MAX_OBSERVATIONS;
    const next: RequestState = {
      ...latest,
      revision: latest.revision + 1,
      updatedAt: finishedAt,
      status: retry
        ? 'submitted'
        : observation.outcome === 'pending'
          ? 'attention_required'
          : observation.outcome,
      observation,
      leaseId: null,
      leaseUntil: null,
      nextCheckAt: retry ? finishedAt + retryDelay(latest.attempts) : null,
    };
    await this.ctx.storage.transaction(async (storage) => {
      if (next.nextCheckAt === null) await storage.deleteAlarm();
      else await storage.setAlarm(next.nextCheckAt);
      this.save(next);
    });
    // No addresses, hashes, JWTs, payloads, source data, or raw provider errors in logs.
    console.info(
      JSON.stringify({
        event: 'issuance_observation',
        outcome: next.status,
        attempt: next.attempts,
      }),
    );
  }
}
