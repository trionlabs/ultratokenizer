import { recoverAddress, type Hex } from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuerPermitDigest,
} from '../../domain/src/index.js';
import {
  parseIssuanceReceipt,
  parseAuditPolicy,
  decodeClaimOutput,
  type AuditPolicy,
  type ProofVerifierIdentity,
  type IssuanceReceipt,
} from './schema.js';

export type AuditCheck = Readonly<{
  id: string;
  status: 'verified' | 'failed' | 'unverified';
  detail: string;
}>;
export type AuditReport = Readonly<{
  format: 'ultratokenizer.audit-report.v1';
  status: 'invalid' | 'incomplete';
  complete: false;
  requestDigest: Hex;
  checks: readonly AuditCheck[];
  missingEvidence: readonly string[];
  limitations: readonly string[];
}>;

/** Optional trusted executable code, configured by the caller, never selected by a receipt. */
export interface ProofVerificationAdapter {
  readonly identity: ProofVerifierIdentity;
  verify(
    input: Readonly<{
      proofBytes: Hex;
      publicValues: Hex;
      programVKey: Hex;
      policy: AuditPolicy;
    }>,
  ): Promise<boolean>;
}

async function signatureMatches(hash: Hex, signature: Hex, expected: string) {
  try {
    return (
      (await recoverAddress({ hash, signature })).toLowerCase() ===
      expected.toLowerCase()
    );
  } catch {
    return false;
  }
}
function pinsMatch(receipt: IssuanceReceipt, policy: AuditPolicy): boolean {
  const request = receipt.request;
  return (
    request.chainId === policy.chainId &&
    request.gate === policy.gate &&
    request.token === policy.token &&
    request.issuerId === policy.issuerId &&
    receipt.permit.keyVersion === policy.issuerKeyVersion &&
    request.policyVersion === policy.policyVersion &&
    request.rightsVersion === policy.rightsVersion &&
    receipt.programVKey === policy.programVKey
  );
}
function proofIdentityMatches(
  adapter: ProofVerificationAdapter,
  policy: AuditPolicy,
): boolean {
  const expected = adapter.identity;
  return (
    expected.proofSystem === policy.proofSystem &&
    expected.outerVersion === policy.outerVersion &&
    expected.verifierAddress.toLowerCase() ===
      policy.verifierAddress.toLowerCase() &&
    expected.verifierCodeHash.toLowerCase() ===
      policy.verifierCodeHash.toLowerCase()
  );
}

/** No app API or chain calls. With no explicit proof adapter, no proof cryptography is performed. */
export async function auditIssuanceReceipt(
  receiptText: string,
  callerPolicy: unknown,
  options: { proofVerifier?: ProofVerificationAdapter } = {},
): Promise<AuditReport> {
  const receipt = parseIssuanceReceipt(receiptText);
  const policy = parseAuditPolicy(callerPolicy);
  const checks: AuditCheck[] = [];
  const check = (id: string, status: AuditCheck['status'], detail: string) =>
    checks.push(Object.freeze({ id, status, detail }));
  const tested = (id: string, valid: boolean, detail: string) =>
    check(id, valid ? 'verified' : 'failed', detail);
  const digest = getIssuanceRequestDigest(receipt.request);
  tested(
    'request_digest',
    digest === receipt.requestDigest,
    'Canonical EIP-712 request digest compared with the bundle.',
  );
  tested(
    'caller_policy',
    pinsMatch(receipt, policy),
    'Chain, gate, token, issuer/key version, policy, rights and program compared with separate caller pins.',
  );
  tested(
    'contract_amount',
    BigInt(receipt.request.amount) <= 9223372036854775807n,
    'Amount fits the gate and mint adapter signed 64-bit range.',
  );
  tested(
    'holder_eoa_signature',
    await signatureMatches(
      digest,
      receipt.holderSignature,
      receipt.request.recipient,
    ),
    'Canonical EOA recovery compared with the request recipient; this does not establish document ownership.',
  );

  let permitDigest: Hex | undefined;
  try {
    permitDigest = getIssuerPermitDigest(receipt.request, receipt.permit);
  } catch {
    /* Safe structured failure, no parser messages or receipt values. */
  }
  tested(
    'permit_binding',
    permitDigest !== undefined,
    'Issuer permit binds the canonical request, issuer and no-later expiry.',
  );
  if (permitDigest) {
    tested(
      'issuer_eoa_signature',
      await signatureMatches(
        permitDigest,
        receipt.issuerSignature,
        policy.issuerAddress,
      ),
      'Canonical EOA recovery compared with the separately pinned issuer address.',
    );
  } else
    check(
      'issuer_eoa_signature',
      'unverified',
      'Permit binding failed, so issuer signature verification was not attempted.',
    );

  try {
    const claim = decodeClaimOutput(receipt.publicValues);
    tested(
      'public_values_binding',
      claim.profileVersion === policy.profileVersion &&
        claim.requestDigest === digest &&
        claim.signerFingerprint === policy.sourceSignerFingerprint &&
        claim.sourceId === policy.sourceId &&
        claim.claimUsageId === receipt.request.claimUsageId &&
        claim.claimCommitment === receipt.request.claimCommitment,
      'The exact 224-byte claim layout binds the canonical request and separately pinned source/profile. This is not a proof validity check.',
    );
    tested(
      'expiry_order',
      BigInt(receipt.permit.validUntil) <= BigInt(receipt.request.validUntil) &&
        BigInt(receipt.request.validUntil) <= BigInt(claim.claimValidUntil),
      'Permit expiry ≤ request expiry ≤ claim expiry. Actual execution time remains unknown.',
    );
  } catch {
    check(
      'public_values_binding',
      'failed',
      'The 224-byte claim output has an invalid ABI value or integer padding.',
    );
    check(
      'expiry_order',
      'unverified',
      'A valid claim expiry could not be decoded.',
    );
  }

  const adapter = options.proofVerifier;
  if (!adapter)
    check(
      'proof_cryptography',
      'unverified',
      'Proof bytes are present, but no caller-trusted cryptographic verifier was supplied.',
    );
  else {
    let identityMatches = false;
    try {
      identityMatches = proofIdentityMatches(adapter, policy);
    } catch {
      /* Failed closed below. */
    }
    if (!identityMatches)
      check(
        'proof_cryptography',
        'failed',
        'The explicit adapter does not match the pinned proof system, outer version and verifier identity.',
      );
    else if (checks.some((item) => item.status === 'failed'))
      check(
        'proof_cryptography',
        'unverified',
        'A prior binding check failed; the proof adapter was not invoked.',
      );
    else {
      try {
        const valid = await adapter.verify(
          Object.freeze({
            proofBytes: receipt.proofBytes,
            publicValues: receipt.publicValues,
            programVKey: policy.programVKey,
            policy,
          }),
        );
        tested(
          'proof_cryptography',
          valid === true,
          'Result from the explicitly trusted, identity-matched proof adapter. No registry history is implied.',
        );
      } catch {
        check(
          'proof_cryptography',
          'unverified',
          'The supplied proof verifier could not complete its check.',
        );
      }
    }
  }
  if (receipt.transaction && receipt.transaction.chainId !== policy.chainId) {
    check(
      'transaction_inclusion',
      'failed',
      'The transaction reference declares a different chain from the caller policy.',
    );
  } else
    check(
      'transaction_inclusion',
      'unverified',
      receipt.transaction
        ? 'A transaction hash is supplied, but inclusion, success, Issued log and finality have not been checked.'
        : 'No transaction reference was supplied.',
    );
  for (const [id, detail] of [
    [
      'historical_registry',
      'Issuer, source, program, policy and rights registry state at execution is unknown.',
    ],
    [
      'historical_reservation',
      'Reservation authorization, available capacity and its consumption at execution are unknown.',
    ],
    [
      'historical_supply',
      'Actual mint adapter execution and token supply/recipient balance effects are unknown.',
    ],
    [
      'historical_token_configuration',
      'Token backend, implementation links, supply roles and transfer configuration at execution have not been independently authenticated. Current deployment checks cannot establish historical state.',
    ],
    [
      'replay_accounting',
      'Request, claim, holder nonce and permit nonce consumption at execution are unknown.',
    ],
    [
      'execution_time',
      'No independently established block time is available to check exclusive expiries.',
    ],
    [
      'current_revocation',
      'Current pause, revocation and expiry state has not been queried. Historical signatures do not establish current validity.',
    ],
    [
      'account_code',
      'EOA recovery was checked; historical account code and ERC-1271 contract-wallet validation were not.',
    ],
  ])
    check(id, 'unverified', detail);
  return Object.freeze({
    format: 'ultratokenizer.audit-report.v1',
    status: checks.some((item) => item.status === 'failed')
      ? 'invalid'
      : 'incomplete',
    complete: false,
    requestDigest: digest,
    checks: Object.freeze(checks),
    missingEvidence: Object.freeze(
      checks
        .filter((item) => item.status === 'unverified')
        .map((item) => item.id),
    ),
    limitations: Object.freeze([
      'Caller trust pins are assumptions supplied outside the receipt, not verified registry decisions.',
      'Signatures do not establish physical gold custody, holder identity, exclusive reserves or enforceable redemption.',
      'EOA signatures only. A transaction reference and expected event are not independent chain evidence.',
      'Offline audit remains incomplete even when an explicit proof adapter verifies cryptography.',
    ]),
  });
}
