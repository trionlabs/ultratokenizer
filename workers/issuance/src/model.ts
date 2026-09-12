import type { Hex } from 'viem';
import type { IssuanceRequest } from '../../../packages/domain/src/index.js';

export type Observation =
  | Readonly<{
      outcome: 'pending';
      reason: 'not_indexed' | 'not_final' | 'rpc_unavailable';
    }>
  | Readonly<{
      outcome: 'rejected';
      reason: 'transaction_reverted' | 'issuance_mismatch' | 'gate_mismatch';
    }>
  | Readonly<{
      outcome: 'confirmed';
      blockNumber: string;
      blockHash: Hex;
      logIndex: string;
      permitDigest: Hex;
      publicValuesHash: Hex;
      programVKey: Hex;
    }>;

export type RequestStatus =
  | 'awaiting_submission'
  | 'submitted'
  | 'checking'
  | 'confirmed'
  | 'rejected'
  | 'attention_required'
  | 'tracking_cancelled';

export type RequestState = {
  schemaVersion: 1;
  id: Hex;
  ownerId: string;
  request: IssuanceRequest;
  status: RequestStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  transactionHash: Hex | null;
  priorTransactionHashes: Hex[];
  attempts: number;
  leaseId: string | null;
  leaseUntil: number | null;
  nextCheckAt: number | null;
  observation: Observation | null;
};

export type PublicRequestState = Omit<
  RequestState,
  'ownerId' | 'leaseId' | 'leaseUntil'
>;

export function publicState(state: RequestState): PublicRequestState {
  const {
    ownerId: _owner,
    leaseId: _lease,
    leaseUntil: _until,
    ...result
  } = state;
  return result;
}

/** Bounded retries are observation retries. No function here submits a transaction. */
export function retryDelay(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.min(attempt - 1, 6), 300_000);
}

export const MAX_OBSERVATIONS = 24;
export const LEASE_MS = 90_000;
export const MAX_OPEN_REQUESTS = 32;
export const MAX_RETAINED_REQUESTS = 128;
export const MAX_CONCURRENT_OBSERVATIONS = 4;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
