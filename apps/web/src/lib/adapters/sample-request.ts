import {
  getIssuanceRequestDigest,
  parseIssuanceRequest,
} from '../../../../../packages/domain/src/index.js';

/** Synthetic identifiers only. No signer, prover, registry or network call occurs. */
export function sampleRequest(amountMg: string) {
  return parseIssuanceRequest({
    schemaVersion: '1',
    action: 'ISSUE',
    requestId: `0x${'11'.repeat(32)}`,
    chainId: '296',
    gate: `0x${'11'.repeat(20)}`,
    token: `0x${'22'.repeat(20)}`,
    recipient: `0x${'33'.repeat(20)}`,
    amount: amountMg,
    unit: 'XAU_MILLIGRAM',
    issuerId: `0x${'22'.repeat(32)}`,
    reservationId: `0x${'33'.repeat(32)}`,
    claimCommitment: `0x${'44'.repeat(32)}`,
    claimUsageId: `0x${'55'.repeat(32)}`,
    policyVersion: '1',
    rightsVersion: '1',
    nonce: '0',
    validUntil: '2000000000',
  });
}

export function sampleDigest(amountMg: string): string {
  return getIssuanceRequestDigest(sampleRequest(amountMg));
}
