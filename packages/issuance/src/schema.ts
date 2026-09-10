import { type Hex, type Address } from 'viem';
import {
  parseIssuanceRequest,
  parseIssuerPermit,
  getIssuanceRequestDigest,
  getIssuerPermitDigest,
  type IssuanceRequest,
  type IssuerPermit,
} from '../../domain/src/index.js';
import {
  parseAuditPolicy,
  decodeClaimOutput,
  MAX_PROOF_BYTES,
  type AuditPolicy,
} from '../../audit/src/index.js';
import { parseAtsBackend, type AtsBackend } from './ats.js';

export const BUNDLE_FORMAT = 'ultratokenizer.issuance-bundle.v1';
export const DEPLOYMENT_FORMAT = 'ultratokenizer.deployment.v1';
export const DEPLOYMENT_V2_FORMAT = 'ultratokenizer.deployment.v2';
export const MAX_BUNDLE_BYTES = 160 * 1024;
export const MAX_DEPLOYMENT_BYTES = 64 * 1024;

const messages = {
  invalid_bundle:
    'The issuance bundle is invalid or does not bind one complete request.',
  invalid_deployment:
    'An independent, complete deployment configuration is required.',
  unsupported_profile:
    'This source profile is not accepted for this deployment purpose.',
  wrong_chain: 'The wallet or RPC is connected to a different chain.',
  wrong_account: 'The selected wallet does not authorize this request.',
  deployment_mismatch:
    'The observed contracts do not match the independently configured deployment.',
  expired: 'The request, claim or institution permit has expired.',
  invalid_signature:
    'An authorization signature does not match the request and accepted signer.',
  invalid_proof: 'The configured verifier rejected the cryptographic proof.',
  transaction_reverted: 'The transaction reverted and did not complete.',
  issuance_mismatch:
    'The transaction does not contain the exact expected issuance.',
  transaction_uncertain:
    'The transaction outcome is unresolved. Keep its hash and reconcile before retrying.',
  issuance_preflight_unavailable:
    'Issuance checks could not complete. No wallet transaction was requested.',
  issuance_recovery_unresolved:
    'The matching call reverted, but it does not identify the original wallet submission. Keep the original reference and reconcile before retrying.',
  association_failed: 'Token association did not succeed.',
  token_preflight_unavailable:
    'Token checks could not complete. No wallet transaction was requested.',
  invalid_token_intent:
    'A complete, valid token transaction intent is required.',
  stale_token_intent:
    'The wallet nonce changed. Prepare this token operation again.',
  token_mismatch:
    'The transaction does not match the intended token operation.',
  unsupported_operation: 'This token does not support token association.',
  invalid_transfer:
    'A positive, exactly representable token quantity and valid recipient are required.',
  reservation_mismatch:
    'The observed reservation does not match this exact request.',
  already_used: 'This request, claim or permit has already been used.',
  capacity_exceeded:
    'The accepted backing pool cannot reserve this complete amount.',
} as const;
export class IssuanceClientError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'IssuanceClientError';
  }
}

export type IssuanceBundle = Readonly<{
  format: typeof BUNDLE_FORMAT;
  request: IssuanceRequest;
  permit: IssuerPermit;
  issuerSignature: Hex;
  publicValues: Hex;
  proofBytes: Hex;
  programVKey: Hex;
}>;
export type ClaimProof = Pick<
  IssuanceBundle,
  'request' | 'publicValues' | 'proofBytes' | 'programVKey'
>;
type DeploymentFields = Readonly<{
  purpose: 'test' | 'production';
  rpcUrl: string;
  gateCodeHash: Hex;
  confirmations: number;
  auditPolicy: AuditPolicy;
}>;
export type DeploymentConfig = DeploymentFields &
  (
    | Readonly<{ format: typeof DEPLOYMENT_FORMAT }>
    | Readonly<{
        format: typeof DEPLOYMENT_V2_FORMAT;
        backend: Readonly<{ kind: 'hts' }> | AtsBackend;
      }>
  );

/** Legacy deployment v1 exclusively identifies the original native HTS path. */
export function getTokenBackend(deployment: DeploymentConfig): 'hts' | 'ats' {
  return deployment.format === DEPLOYMENT_FORMAT
    ? 'hts'
    : deployment.backend.kind;
}

function record(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error();
  const own = Reflect.ownKeys(input);
  if (
    own.length !== fields.length ||
    own.some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(input, key)!),
    )
  )
    throw new Error();
  return input as Record<string, unknown>;
}
function bounded(input: unknown, limit: number): unknown {
  if (typeof input !== 'string') return input;
  if (input.length > limit || new TextEncoder().encode(input).length > limit)
    throw new Error();
  return JSON.parse(input);
}
export function bytes(input: unknown, maximum: number, exact?: number): Hex {
  if (
    typeof input !== 'string' ||
    input.length < 4 ||
    input.length > 2 + maximum * 2 ||
    !/^0x(?:[a-fA-F0-9]{2})+$/.test(input) ||
    (exact !== undefined && input.length !== 2 + exact * 2)
  )
    throw new Error();
  return input.toLowerCase() as Hex;
}
export function nonzeroHash(input: unknown): Hex {
  const result = bytes(input, 32, 32);
  if (/^0x0+$/.test(result)) throw new Error();
  return result;
}
export function rpcUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error();
  const url = new URL(input);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error();
  return url.toString();
}

/** An export's status label is not trusted; the issuer rechecks its proof against pinned contracts. */
export function parseClaimProofExport(input: unknown): ClaimProof {
  try {
    const value = record(bounded(input, MAX_BUNDLE_BYTES), [
      'status',
      'proofMode',
      'zeroKnowledge',
      'issuerAuthorityChecked',
      'outerCircuitVersion',
      'proofBytes',
      'publicValues',
      'programVKey',
      'request',
    ]);
    if (
      value.status !== 'verified_groth16_export' ||
      value.proofMode !== 'groth16' ||
      value.zeroKnowledge !== true ||
      value.issuerAuthorityChecked !== false ||
      value.outerCircuitVersion !== 'v6.1.0'
    )
      throw new Error();
    const request = parseIssuanceRequest(value.request);
    const publicValues = bytes(value.publicValues, 224, 224);
    const claim = decodeClaimOutput(publicValues);
    if (
      BigInt(request.amount) > 9223372036854775807n ||
      claim.profileVersion !== '2' ||
      claim.requestDigest !== getIssuanceRequestDigest(request) ||
      claim.claimCommitment !== request.claimCommitment ||
      claim.claimUsageId !== request.claimUsageId ||
      BigInt(request.validUntil) > BigInt(claim.claimValidUntil)
    )
      throw new Error();
    return Object.freeze({
      request,
      publicValues,
      proofBytes: bytes(value.proofBytes, 356, 356),
      programVKey: nonzeroHash(value.programVKey),
    });
  } catch {
    throw new IssuanceClientError('invalid_bundle');
  }
}

/** A public proof/permit bundle is input, never its own deployment trust policy. */
export function parseIssuanceBundle(input: unknown): IssuanceBundle {
  try {
    const value = record(bounded(input, MAX_BUNDLE_BYTES), [
      'format',
      'request',
      'permit',
      'issuerSignature',
      'publicValues',
      'proofBytes',
      'programVKey',
    ]);
    if (value.format !== BUNDLE_FORMAT) throw new Error();
    const request = parseIssuanceRequest(value.request);
    const permit = parseIssuerPermit(value.permit);
    getIssuerPermitDigest(request, permit);
    if (BigInt(request.amount) > 9223372036854775807n) throw new Error();
    const publicValues = bytes(value.publicValues, 224, 224);
    const claim = decodeClaimOutput(publicValues);
    if (
      claim.profileVersion !== '2' ||
      claim.requestDigest !== getIssuanceRequestDigest(request) ||
      claim.claimCommitment !== request.claimCommitment ||
      claim.claimUsageId !== request.claimUsageId ||
      BigInt(request.validUntil) > BigInt(claim.claimValidUntil)
    )
      throw new Error();
    return Object.freeze({
      format: BUNDLE_FORMAT,
      request,
      permit,
      issuerSignature: bytes(value.issuerSignature, 65, 65),
      publicValues,
      proofBytes: bytes(value.proofBytes, MAX_PROOF_BYTES),
      programVKey: nonzeroHash(value.programVKey),
    });
  } catch {
    throw new IssuanceClientError('invalid_bundle');
  }
}

/** Explicit caller trust/configuration, loaded separately from any imported claim. */
export function parseDeploymentConfig(input: unknown): DeploymentConfig {
  try {
    const candidate = bounded(input, MAX_DEPLOYMENT_BYTES);
    if (!candidate || typeof candidate !== 'object') throw new Error();
    const format = Object.getOwnPropertyDescriptor(candidate, 'format')?.value;
    if (format !== DEPLOYMENT_FORMAT && format !== DEPLOYMENT_V2_FORMAT)
      throw new Error();
    const value = record(candidate, [
      'format',
      'purpose',
      'rpcUrl',
      'gateCodeHash',
      'confirmations',
      'auditPolicy',
      ...(format === DEPLOYMENT_V2_FORMAT ? ['backend'] : []),
    ]);
    if (
      (value.purpose !== 'test' && value.purpose !== 'production') ||
      !Number.isSafeInteger(value.confirmations) ||
      Number(value.confirmations) < 1 ||
      Number(value.confirmations) > 32
    )
      throw new Error();
    const auditPolicy = parseAuditPolicy(value.auditPolicy);
    // Profile 2 proves the explicit synthetic capsule. Real cryptography does not
    // turn a fixture into real institutional evidence. A future real profile needs
    // its own implemented parser, program identity and acceptance rule here.
    if (
      auditPolicy.profileVersion !== '2' ||
      auditPolicy.outerVersion !== 'v6.1.0' ||
      value.purpose !== 'test' ||
      auditPolicy.chainId === '295'
    )
      throw new IssuanceClientError('unsupported_profile');
    const fields = {
      purpose: value.purpose,
      rpcUrl: rpcUrl(value.rpcUrl),
      gateCodeHash: nonzeroHash(value.gateCodeHash),
      confirmations: Number(value.confirmations),
      auditPolicy,
    } as const;
    if (format === DEPLOYMENT_FORMAT)
      return Object.freeze({ format: DEPLOYMENT_FORMAT, ...fields });
    const rawBackend = value.backend;
    const kind =
      rawBackend && typeof rawBackend === 'object'
        ? Object.getOwnPropertyDescriptor(rawBackend, 'kind')?.value
        : undefined;
    let backend: Readonly<{ kind: 'hts' }> | AtsBackend;
    if (kind === 'hts') {
      record(rawBackend, ['kind']);
      backend = Object.freeze({ kind: 'hts' });
    } else backend = parseAtsBackend(rawBackend);
    return Object.freeze({ format: DEPLOYMENT_V2_FORMAT, ...fields, backend });
  } catch (error) {
    if (error instanceof IssuanceClientError) throw error;
    throw new IssuanceClientError('invalid_deployment');
  }
}

export function assertBundleDeployment(
  bundle: IssuanceBundle,
  deployment: DeploymentConfig,
): void {
  assertProofDeployment(bundle, deployment);
  if (bundle.permit.keyVersion !== deployment.auditPolicy.issuerKeyVersion)
    throw new IssuanceClientError('deployment_mismatch');
}

export function assertProofDeployment(
  bundle: ClaimProof,
  deployment: DeploymentConfig,
): void {
  const p = deployment.auditPolicy;
  const r = bundle.request;
  const claim = decodeClaimOutput(bundle.publicValues);
  if (
    r.chainId !== p.chainId ||
    r.gate !== p.gate ||
    r.token !== p.token ||
    r.issuerId !== p.issuerId ||
    r.policyVersion !== p.policyVersion ||
    r.rightsVersion !== p.rightsVersion ||
    bundle.programVKey !== p.programVKey ||
    claim.profileVersion !== p.profileVersion ||
    claim.sourceId !== p.sourceId ||
    claim.signerFingerprint !== p.sourceSignerFingerprint
  )
    throw new IssuanceClientError('deployment_mismatch');
}

export type ConnectedWallet = Readonly<{ address: Address; chainId: string }>;
