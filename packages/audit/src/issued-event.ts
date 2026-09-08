import { encodeAbiParameters, encodeEventTopics, keccak256 } from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuerPermitDigest,
  ISSUED_EVENT_ABI,
} from '../../domain/src/index.js';
import { parseIssuanceReceipt } from './schema.js';

export { ISSUED_EVENT_ABI };

/** Expected bytes derived from a bundle, NEVER an assertion that this log occurred. */
export function getExpectedIssuedEvent(receiptText: string) {
  const receipt = parseIssuanceReceipt(receiptText);
  const request = receipt.request;
  const digest = getIssuanceRequestDigest(request);
  return Object.freeze({
    address: request.gate,
    topics: Object.freeze(
      encodeEventTopics({
        abi: ISSUED_EVENT_ABI,
        eventName: 'Issued',
        args: {
          requestDigest: digest,
          requestId: request.requestId,
          claimUsageId: request.claimUsageId,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        request.issuerId,
        request.reservationId,
        request.token,
        request.recipient,
        BigInt(request.amount),
        BigInt(request.policyVersion),
        BigInt(request.rightsVersion),
        getIssuerPermitDigest(request, receipt.permit),
        keccak256(receipt.publicValues),
        receipt.programVKey,
      ],
    ),
  });
}
