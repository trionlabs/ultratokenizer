import { parseAbi } from 'viem';

/** Canonical gate event shared by portable audit and chain observation. */
const issuedAbi = parseAbi([
  'event Issued(bytes32 indexed requestDigest, bytes32 indexed requestId, bytes32 indexed claimUsageId, bytes32 issuerId, bytes32 reservationId, address token, address recipient, uint256 milligrams, uint64 policyVersion, uint64 rightsVersion, bytes32 permitDigest, bytes32 publicValuesHash, bytes32 programVKey)',
]);

for (const event of issuedAbi) {
  for (const input of event.inputs) Object.freeze(input);
  Object.freeze(event.inputs);
  Object.freeze(event);
}

export const ISSUED_EVENT_ABI = Object.freeze(issuedAbi);
