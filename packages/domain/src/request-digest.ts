import { hashTypedData } from 'viem';
import { parseIssuanceRequest } from './issuance-request.js';

const requestFields = [
  { name: 'schemaVersion', type: 'uint8' },
  { name: 'action', type: 'string' },
  { name: 'requestId', type: 'bytes32' },
  { name: 'token', type: 'address' },
  { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'unit', type: 'string' },
  { name: 'issuerId', type: 'bytes32' },
  { name: 'reservationId', type: 'bytes32' },
  { name: 'claimCommitment', type: 'bytes32' },
  { name: 'claimUsageId', type: 'bytes32' },
  { name: 'policyVersion', type: 'uint64' },
  { name: 'rightsVersion', type: 'uint64' },
  { name: 'nonce', type: 'uint256' },
  { name: 'validUntil', type: 'uint64' },
] as const;

/**
 * Chain and gate are bound by the EIP-712 domain; all other fields are in the message.
 * Consumers must still check signer authority, proof validity and stateful replay protection.
 */
export function getIssuanceRequestTypedData(input: unknown) {
  const request = parseIssuanceRequest(input);
  return {
    domain: {
      name: 'Ultratokenizer',
      version: request.schemaVersion,
      chainId: BigInt(request.chainId),
      verifyingContract: request.gate,
    },
    // Give each caller its own definition so mutation cannot corrupt later digests.
    types: { IssuanceRequest: requestFields.map((field) => ({ ...field })) },
    primaryType: 'IssuanceRequest' as const,
    message: {
      schemaVersion: Number(request.schemaVersion),
      action: request.action,
      requestId: request.requestId,
      token: request.token,
      recipient: request.recipient,
      amount: BigInt(request.amount),
      unit: request.unit,
      issuerId: request.issuerId,
      reservationId: request.reservationId,
      claimCommitment: request.claimCommitment,
      claimUsageId: request.claimUsageId,
      policyVersion: BigInt(request.policyVersion),
      rightsVersion: BigInt(request.rightsVersion),
      nonce: BigInt(request.nonce),
      validUntil: BigInt(request.validUntil),
    },
  };
}

/** Deterministic EIP-712 digest; no signing, proof generation or chain access. */
export function getIssuanceRequestDigest(input: unknown) {
  return hashTypedData(getIssuanceRequestTypedData(input));
}
