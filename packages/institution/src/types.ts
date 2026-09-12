import type { Address, Hex } from 'viem';
import type { IssuanceRequest } from '../../domain/src/index.js';

export type RightState = 'available' | 'pending' | 'issued';
export type AllocationState = 'pending' | 'issued' | 'released';

/** Public-safe snapshot. Neither the institutional record reference nor claimId is included. */
export type InstitutionRight = Readonly<{
  rightId: Hex;
  sourceId: Hex;
  claimUsageId: Hex;
  holder: Address;
  milligrams: string;
  state: RightState;
}>;

export type RegisterRightInput = Readonly<{
  sourceId: Hex;
  recordReference: string;
  holder: Address;
  milligrams: string;
}>;

export type BackingPool = Readonly<{
  issuerId: Hex;
  token: Address;
  cap: string;
  pending: string;
  outstanding: string;
}>;

export type ChainObservation = Readonly<{
  requestDigest: Hex;
  chainId: string;
  gate: Address;
  reservationId: Hex;
  claimUsageId: Hex;
  blockHash: Hex;
  blockNumber: string;
}>;
export type IssuedObservation = ChainObservation &
  Readonly<{ kind: 'issued'; transactionHash: Hex }>;
export type UnusedObservation = ChainObservation &
  Readonly<{
    kind: 'unused';
    reason: 'revoked-unused' | 'expired-unused';
    reservationReleased: true;
    reservationUsed: '0';
    requestUsed: false;
    claimUsed: false;
  }>;
export type ExpiredUnopenedObservation = ChainObservation &
  Readonly<{
    kind: 'expired-unopened';
    blockTimestamp: string;
    reservationAbsent: true;
    requestUsed: false;
    claimUsed: false;
  }>;

export type Allocation = Readonly<{
  rightId: Hex;
  requestDigest: Hex;
  request: IssuanceRequest;
  state: AllocationState;
  observation:
    | IssuedObservation
    | UnusedObservation
    | ExpiredUnopenedObservation
    | null;
}>;

/** Explicit private access for constructing an institution-signed source document. */
export interface PrivateClaimIdentity {
  readonly sourceId: Hex;
  readonly claimId: Hex;
  toJSON(): never;
}

export interface InstitutionLedger {
  registerRight(input: RegisterRightInput): InstitutionRight;
  findRight(
    input: Readonly<{ sourceId: Hex; recordReference: string }>,
  ): InstitutionRight | null;
  getRight(rightId: Hex): InstitutionRight;
  privateClaimIdentity(rightId: Hex): PrivateClaimIdentity;
  setBackingCap(
    input: Readonly<{ issuerId: Hex; token: Address; milligrams: string }>,
  ): BackingPool;
  getPool(input: Readonly<{ issuerId: Hex; token: Address }>): BackingPool;
  reserve(
    input: Readonly<{ rightId: Hex; request: IssuanceRequest }>,
  ): Allocation;
  getAllocation(requestDigest: Hex): Allocation | null;
  markIssued(observation: IssuedObservation): Allocation;
  releaseUnused(observation: UnusedObservation): Allocation;
  releaseExpiredUnopened(observation: ExpiredUnopenedObservation): Allocation;
  close(): void;
}
