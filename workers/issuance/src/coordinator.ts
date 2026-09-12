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
  MAX_OPEN_REQUESTS,
  MAX_RETAINED_REQUESTS,
  MAX_SUBJECT_OPEN_REQUESTS,
  MAX_SUBJECT_RETAINED_REQUESTS,
  MAX_CONCURRENT_OBSERVATIONS,
  RETENTION_MS,
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

/** One bounded tenant database; request ownership remains subject-specific. */
export class IssuanceCoordinator extends DurableObject<IssuanceEnv> {
  constructor(ctx: DurableObjectState, env: IssuanceEnv) {
    super(ctx, env);
    this.ctx.storage.transactionSync(() => {
      // Legacy singleton objects remain untouched. Deployment uses a fresh class
      // namespace; an existing operator must export/drain before switching.
      for (const [table, expected] of [
        ['requests', 'id,revision,state'],
        ['events', 'request_id,sequence,at,status'],
      ]) {
        const columns = this.ctx.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray();
        if (
          columns.length &&
          columns.map((column) => column.name).join(',') !== expected
        )
          throw new WorkerError('not_configured');
      }
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)',
      );
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS events (request_id TEXT NOT NULL, sequence INTEGER NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY(request_id, sequence))',
      );
    });
  }

  private load(id: Hex): RequestState | null {
    const rows = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM requests WHERE id = ?', id)
      .toArray();
    return rows[0] ? (JSON.parse(rows[0].state) as RequestState) : null;
  }

  private all(): RequestState[] {
    // ponytail: at most 128 retained rows; indexed scheduling belongs after a
    // separately reviewed quota increase, not in this bounded tenant service.
    return this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM requests')
      .toArray()
      .map((row) => JSON.parse(row.state) as RequestState);
  }

  private save(state: RequestState): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO requests(id, revision, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state',
      state.id,
      state.revision,
      JSON.stringify(state),
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO events(request_id, sequence, at, status) VALUES (?, ?, ?, ?)',
      state.id,
      state.revision,
      state.updatedAt,
      state.status,
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM events WHERE request_id = ? AND sequence <= ?',
      state.id,
      state.revision - 128,
    );
  }

  private async mutate<T>(action: () => T): Promise<T> {
    return this.ctx.storage.transaction(async (storage) => {
      const now = Date.now();
      for (const state of this.all()) {
        if (now < state.createdAt + RETENTION_MS || this.leased(state, now))
          continue;
        // Deletes tracking only. No chain transaction, reservation release or
        // claim consumption decision can follow from retention expiry.
        this.ctx.storage.sql.exec(
          'DELETE FROM events WHERE request_id = ?',
          state.id,
        );
        this.ctx.storage.sql.exec(
          'DELETE FROM requests WHERE id = ?',
          state.id,
        );
      }
      const result = action();
      const deadlines = this.all().flatMap((state) => {
        // Retired records are inaccessible but keep their capacity while an
        // observer holds its lease; expiry must not admit overlapping work.
        if (now >= state.createdAt + RETENTION_MS && this.leased(state, now))
          return [state.leaseUntil!];
        return [
          state.createdAt + RETENTION_MS,
          ...(state.leaseId && state.leaseUntil !== null
            ? [state.leaseUntil]
            : state.nextCheckAt !== null
              ? [state.nextCheckAt]
              : []),
        ];
      });
      if (deadlines.length) {
        const next = Math.max(Date.now() + 1_000, Math.min(...deadlines));
        const scheduled = await storage.getAlarm();
        // Reads must not keep postponing a due observation or cleanup alarm.
        if (scheduled === null || next < scheduled)
          await storage.setAlarm(next);
      } else await storage.deleteAlarm();
      return result;
    });
  }

  private owned(ownerId: string, id: Hex): RequestState {
    const state = this.load(id);
    if (
      !state ||
      state.ownerId !== ownerId ||
      Date.now() >= state.createdAt + RETENTION_MS
    )
      throw new WorkerError('not_found');
    return state;
  }

  private leased(state: RequestState, now: number): boolean {
    return (
      state.leaseId !== null &&
      state.leaseUntil !== null &&
      state.leaseUntil > now
    );
  }

  private lease(state: RequestState, now: number): RequestState {
    return {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      leaseId: crypto.randomUUID(),
      leaseUntil: now + LEASE_MS,
    };
  }

  async create(
    ownerId: string,
    request: IssuanceRequest,
  ): Promise<PublicRequestState> {
    return this.mutate(() => {
      assertIssuanceRequestActive(
        request,
        BigInt(Math.floor(Date.now() / 1000)),
      );
      const id = getIssuanceRequestDigest(request);
      const current = this.load(id);
      if (current) {
        if (current.ownerId !== ownerId) throw new WorkerError('conflict');
        if (Date.now() >= current.createdAt + RETENTION_MS)
          throw new WorkerError('rate_limited');
        return publicState(current);
      }
      const retained = this.all();
      const open = retained.filter(
        (state) =>
          state.status !== 'confirmed' && state.status !== 'tracking_cancelled',
      );
      if (
        retained.length >= MAX_RETAINED_REQUESTS ||
        open.length >= MAX_OPEN_REQUESTS ||
        retained.filter((state) => state.ownerId === ownerId).length >=
          MAX_SUBJECT_RETAINED_REQUESTS ||
        open.filter((state) => state.ownerId === ownerId).length >=
          MAX_SUBJECT_OPEN_REQUESTS
      )
        throw new WorkerError('rate_limited');
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
    });
  }

  async inspect(ownerId: string, id: Hex): Promise<PublicRequestState> {
    return this.mutate(() => publicState(this.owned(ownerId, id)));
  }

  async submit(
    ownerId: string,
    id: Hex,
    transactionHash: Hex,
  ): Promise<PublicRequestState> {
    if (!isHash(transactionHash)) throw new WorkerError('invalid_request');
    const state = this.owned(ownerId, id);
    if (
      state.transactionHash !== null &&
      state.transactionHash !== transactionHash
    )
      return this.resolveReplacement(ownerId, id, transactionHash);
    return this.mutate(() => {
      const current = this.owned(ownerId, id);
      if (current.transactionHash === transactionHash)
        return publicState(current);
      if (
        current.status !== 'awaiting_submission' ||
        current.transactionHash !== null
      )
        throw new WorkerError('conflict');
      // The actual transaction may have finalized before request expiry.
      const next: RequestState = {
        ...current,
        status: 'submitted',
        transactionHash,
        updatedAt: Date.now(),
        revision: current.revision + 1,
        nextCheckAt: Date.now() + 1_000,
      };
      this.save(next);
      return publicState(next);
    });
  }

  /** Candidate checks share the tenant's durable observation lease budget. */
  private async resolveReplacement(
    ownerId: string,
    id: Hex,
    candidate: Hex,
  ): Promise<PublicRequestState> {
    const checking = await this.mutate(() => {
      const state = this.owned(ownerId, id);
      if (
        state.status === 'confirmed' ||
        state.status === 'tracking_cancelled' ||
        !state.transactionHash ||
        state.priorTransactionHashes.length >= 8
      )
        throw new WorkerError('conflict');
      const now = Date.now();
      if (
        this.leased(state, now) ||
        this.all().filter((item) => this.leased(item, now)).length >=
          MAX_CONCURRENT_OBSERVATIONS
      )
        throw new WorkerError('rate_limited');
      const next = this.lease(state, now);
      this.save(next);
      return next;
    });
    let observation;
    try {
      observation = await observeIssuance(
        checking.request,
        candidate,
        chainConfiguration(this.env),
      );
    } catch {
      observation = { outcome: 'pending', reason: 'rpc_unavailable' } as const;
    }
    const result = await this.mutate(() => {
      const latest = this.owned(ownerId, id);
      if (
        latest.leaseId !== checking.leaseId ||
        latest.revision !== checking.revision ||
        latest.createdAt !== checking.createdAt
      )
        throw new WorkerError('conflict');
      const next: RequestState = {
        ...latest,
        revision: latest.revision + 1,
        updatedAt: Date.now(),
        leaseId: null,
        leaseUntil: null,
      };
      if (observation.outcome === 'confirmed') {
        next.status = 'confirmed';
        next.transactionHash = candidate;
        next.priorTransactionHashes = [
          ...latest.priorTransactionHashes,
          latest.transactionHash!,
        ];
        next.observation = observation;
        next.nextCheckAt = null;
      }
      this.save(next);
      return observation.outcome === 'confirmed' ? publicState(next) : null;
    });
    if (!result) throw new WorkerError('conflict');
    return result;
  }

  async cancel(ownerId: string, id: Hex): Promise<PublicRequestState> {
    return this.mutate(() => {
      const state = this.owned(ownerId, id);
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
    });
  }

  async reconcile(ownerId: string, id: Hex): Promise<PublicRequestState> {
    return this.mutate(() => {
      const state = this.owned(ownerId, id);
      if (
        state.status === 'submitted' ||
        state.status === 'checking' ||
        state.status === 'confirmed'
      )
        return publicState(state);
      if (
        (state.status !== 'attention_required' &&
          state.status !== 'rejected') ||
        !state.transactionHash
      )
        throw new WorkerError('conflict');
      const now = Date.now();
      if (this.leased(state, now) || now - state.updatedAt < 60_000)
        throw new WorkerError('rate_limited');
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
      this.save(next);
      return publicState(next);
    });
  }

  async alarm(): Promise<void> {
    const checking = await this.mutate(() => {
      const now = Date.now();
      // An abandoned candidate lease does not change the original transaction.
      for (const state of this.all()) {
        if (state.leaseId && !this.leased(state, now)) {
          this.save({
            ...state,
            revision: state.revision + 1,
            updatedAt: now,
            leaseId: null,
            leaseUntil: null,
          });
        }
      }
      const all = this.all();
      let slots =
        MAX_CONCURRENT_OBSERVATIONS -
        all.filter((state) => this.leased(state, now)).length;
      const selected: RequestState[] = [];
      for (const state of all.sort(
        (a, b) => (a.nextCheckAt ?? Infinity) - (b.nextCheckAt ?? Infinity),
      )) {
        if (
          !state.transactionHash ||
          !['submitted', 'checking'].includes(state.status) ||
          this.leased(state, now) ||
          state.nextCheckAt === null ||
          state.nextCheckAt > now
        )
          continue;
        if (state.attempts >= MAX_OBSERVATIONS) {
          this.save({
            ...state,
            status: 'attention_required',
            revision: state.revision + 1,
            updatedAt: now,
            nextCheckAt: null,
            leaseId: null,
            leaseUntil: null,
            observation: { outcome: 'pending', reason: 'rpc_unavailable' },
          });
          continue;
        }
        if (slots <= 0) break;
        const next: RequestState = {
          ...this.lease(state, now),
          status: 'checking',
          attempts: state.attempts + 1,
          nextCheckAt: now + LEASE_MS,
        };
        this.save(next);
        selected.push(next);
        slots--;
      }
      return selected;
    });
    await Promise.all(
      checking.map(async (current) => {
        let observation;
        try {
          observation = await observeIssuance(
            current.request,
            current.transactionHash!,
            chainConfiguration(this.env),
          );
        } catch {
          observation = {
            outcome: 'pending',
            reason: 'rpc_unavailable',
          } as const;
        }
        await this.mutate(() => {
          const latest = this.load(current.id);
          if (
            !latest ||
            latest.leaseId !== current.leaseId ||
            latest.revision !== current.revision ||
            latest.createdAt !== current.createdAt
          )
            return;
          const now = Date.now();
          const retry =
            observation.outcome === 'pending' &&
            latest.attempts < MAX_OBSERVATIONS;
          const next: RequestState = {
            ...latest,
            revision: latest.revision + 1,
            updatedAt: now,
            status: retry
              ? 'submitted'
              : observation.outcome === 'pending'
                ? 'attention_required'
                : observation.outcome,
            observation,
            leaseId: null,
            leaseUntil: null,
            nextCheckAt: retry ? now + retryDelay(latest.attempts) : null,
          };
          this.save(next);
        });
        console.info(
          JSON.stringify({
            event: 'issuance_observation',
            outcome: observation.outcome,
            attempt: current.attempts,
          }),
        );
      }),
    );
  }
}

/** Fresh v2 namespace. The old class export is retained without deleting its storage. */
export class IssuanceTenantCoordinator extends IssuanceCoordinator {}
