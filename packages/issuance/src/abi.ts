import { parseAbi } from 'viem';
import {
  type IssuanceRequest,
  type IssuerPermit,
  ISSUED_EVENT_ABI,
} from '../../domain/src/index.js';
import { type IssuanceBundle } from './schema.js';
import type { Hex } from 'viem';

export const ISSUANCE_GATE_ABI = [
  ...parseAbi([
    'struct Request { uint8 schemaVersion; string action; bytes32 requestId; uint256 chainId; address gate; address token; address recipient; uint256 amount; string unit; bytes32 issuerId; bytes32 reservationId; bytes32 claimCommitment; bytes32 claimUsageId; uint64 policyVersion; uint64 rightsVersion; uint256 nonce; uint64 validUntil; }',
    'struct Permit { bytes32 requestDigest; bytes32 issuerId; uint64 keyVersion; uint256 nonce; uint64 validUntil; }',
    'function issue(Request request, bytes holderSignature, Permit permit, bytes issuerSignature, bytes publicValues, bytes proofBytes) returns (bytes32)',
    'function paused() view returns (bool)',
    'function policies(bytes32 issuerId, uint64 version) view returns (uint64 programVersion, bytes32 sourceId, uint64 sourceKeyVersion, bytes32 termsHash, bool revoked)',
    'function programs(uint64 version) view returns (address verifier, bytes32 codeHash, bytes32 vkey, uint32 profile, bool revoked)',
    'function sourceKeys(bytes32 sourceId, uint64 version) view returns (bytes32 fingerprint, bool revoked)',
    'function issuerKeys(bytes32 issuerId, uint64 version) view returns (address signer, uint64 validUntil, bool revoked)',
    'function rights(bytes32 issuerId,uint64 version) view returns (address token,address adapter,bytes32 adapterCodeHash,bytes32 termsHash,bool revoked)',
    'function openReservation(bytes32 issuerId,uint64 keyVersion,bytes32 reservationId,address recipient,address token,uint256 capacity,uint64 validUntil,bytes32 requestDigest,bytes32 claimUsageId)',
    'function backingPools(bytes32 issuerId,address token) view returns (uint256 cap,uint256 pending,uint256 outstanding)',
    'function usedRequests(bytes32 digest) view returns (bool)',
    'function usedRequestIds(bytes32 requestId) view returns (bool)',
    'function usedHolderNonces(address recipient,uint256 nonce) view returns (bool)',
    'function usedClaims(bytes32 claimUsageId) view returns (bool)',
    'function usedPermitNonces(bytes32 issuerId,uint64 keyVersion,uint256 nonce) view returns (bool)',
    'event ReservationOpened(bytes32 indexed issuerId,bytes32 indexed reservationId,address recipient,address token,uint256 capacity,uint64 validUntil,uint64 keyVersion,bytes32 requestDigest,bytes32 claimUsageId)',
    'function reservations(bytes32 issuerId,bytes32 reservationId) view returns (address recipient,address token,uint256 capacity,uint256 used,uint64 validUntil,bool revoked,bytes32 requestDigest,bytes32 claimUsageId,bool released)',
  ]),
  ...ISSUED_EVENT_ABI,
] as const;
export const SP1_VERIFIER_ABI = parseAbi([
  'function verifyProof(bytes32 programVKey,bytes publicValues,bytes proofBytes) view',
]);
export const ERC20_TOKEN_ABI = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to,uint256 amount) returns (bool)',
]);
export const HTS_TOKEN_ABI = [
  ...parseAbi([
    'function associate() returns (int64 responseCode)',
    'function isAssociated() view returns (bool)',
  ]),
  ...ERC20_TOKEN_ABI,
] as const;
export function toRequestArgs(r: IssuanceRequest) {
  return {
    ...r,
    schemaVersion: Number(r.schemaVersion),
    chainId: BigInt(r.chainId),
    amount: BigInt(r.amount),
    policyVersion: BigInt(r.policyVersion),
    rightsVersion: BigInt(r.rightsVersion),
    nonce: BigInt(r.nonce),
    validUntil: BigInt(r.validUntil),
  };
}
export function toPermitArgs(p: IssuerPermit) {
  return {
    ...p,
    keyVersion: BigInt(p.keyVersion),
    nonce: BigInt(p.nonce),
    validUntil: BigInt(p.validUntil),
  };
}
export function toIssueArgs(bundle: IssuanceBundle, holderSignature: Hex) {
  return [
    toRequestArgs(bundle.request),
    holderSignature,
    toPermitArgs(bundle.permit),
    bundle.issuerSignature,
    bundle.publicValues,
    bundle.proofBytes,
  ] as const;
}
