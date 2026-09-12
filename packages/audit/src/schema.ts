import {
  getAddress,
  isAddress,
  zeroAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import {
  parseIssuanceRequest,
  parseIssuerPermit,
  parseDuplicateFreeJson,
  type IssuanceRequest,
  type IssuerPermit,
} from '../../domain/src/index.js';

export const RECEIPT_FORMAT = 'ultratokenizer.issuance-receipt.v1';
export const POLICY_FORMAT = 'ultratokenizer.audit-policy.v1';
export const REPORT_FORMAT = 'ultratokenizer.audit-report.v2';
export const MAX_RECEIPT_BYTES = 256 * 1024;
export const MAX_POLICY_BYTES = 8 * 1024;
export const MAX_PROOF_BYTES = 64 * 1024;

const messages = {
  invalid_receipt: 'The issuance receipt has an invalid or unsupported schema.',
  invalid_policy:
    'The caller trust policy has an invalid or unsupported schema.',
  too_large: 'The input exceeds the supported byte limit.',
  unreadable: 'The input could not be read as a bounded UTF-8 JSON file.',
} as const;
export class AuditInputError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'AuditInputError';
  }
}

export type IssuanceReceipt = Readonly<{
  format: typeof RECEIPT_FORMAT;
  request: IssuanceRequest;
  requestDigest: Hex;
  holderSignature: Hex;
  permit: IssuerPermit;
  issuerSignature: Hex;
  publicValues: Hex;
  proofBytes: Hex;
  programVKey: Hex;
  transaction: Readonly<{ chainId: string; hash: Hex }> | null;
}>;

export type ProofVerifierIdentity = Readonly<{
  proofSystem: 'sp1-groth16';
  outerVersion: string;
  verifierAddress: Address;
  verifierCodeHash: Hex;
}>;
export type AuditPolicy = Readonly<
  ProofVerifierIdentity & {
    format: typeof POLICY_FORMAT;
    chainId: string;
    gate: Address;
    token: Address;
    issuerId: Hex;
    issuerAddress: Address;
    issuerKeyVersion: string;
    policyVersion: string;
    rightsVersion: string;
    programVKey: Hex;
    profileVersion: string;
    sourceId: Hex;
    sourceSignerFingerprint: Hex;
  }
>;

/** A bounded observation under a caller-trusted RPC, not independent inclusion evidence. */
export type RpcProofObservation = Readonly<{
  format: 'ultratokenizer.rpc-proof-observation.v1';
  chainId: string;
  blockNumber: string;
  blockHash: Hex;
  verifierAddress: Address;
  verifierCodeHash: Hex;
  outerVersion: string;
  programVKey: Hex;
  publicValuesHash: Hex;
  proofBytesHash: Hex;
  method: 'verifyProof(bytes32,bytes,bytes)';
  result: 'returned' | 'reverted';
  assurance: 'trusted-rpc';
  rpcOrigin: string;
}>;

export function parseRpcProofObservation(
  input: unknown,
  receipt: IssuanceReceipt,
  policy: AuditPolicy,
): RpcProofObservation {
  const value = object(input, [
    'format',
    'chainId',
    'blockNumber',
    'blockHash',
    'verifierAddress',
    'verifierCodeHash',
    'outerVersion',
    'programVKey',
    'publicValuesHash',
    'proofBytesHash',
    'method',
    'result',
    'assurance',
    'rpcOrigin',
  ]);
  if (
    value.format !== 'ultratokenizer.rpc-proof-observation.v1' ||
    value.method !== 'verifyProof(bytes32,bytes,bytes)' ||
    (value.result !== 'returned' && value.result !== 'reverted') ||
    value.assurance !== 'trusted-rpc' ||
    value.outerVersion !== policy.outerVersion ||
    typeof value.rpcOrigin !== 'string' ||
    value.rpcOrigin.length > 2048
  )
    throw new Error('Invalid proof observation.');
  const origin = new URL(value.rpcOrigin);
  if (
    origin.origin !== value.rpcOrigin ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new Error('Invalid proof observation origin.');
  const observation: RpcProofObservation = {
    format: 'ultratokenizer.rpc-proof-observation.v1',
    chainId: uint(value.chainId, 256),
    blockNumber: value.blockNumber === '0' ? '0' : uint(value.blockNumber, 256),
    blockHash: hex(value.blockHash, 32),
    verifierAddress: address(value.verifierAddress),
    verifierCodeHash: hex(value.verifierCodeHash, 32),
    outerVersion: policy.outerVersion,
    programVKey: hex(value.programVKey, 32),
    publicValuesHash: hex(value.publicValuesHash, 32),
    proofBytesHash: hex(value.proofBytesHash, 32),
    method: value.method,
    result: value.result,
    assurance: value.assurance,
    rpcOrigin: value.rpcOrigin,
  };
  if (
    value.outerVersion !== policy.outerVersion ||
    observation.chainId !== policy.chainId ||
    observation.chainId !== receipt.request.chainId ||
    observation.verifierAddress !== policy.verifierAddress ||
    observation.verifierCodeHash !== policy.verifierCodeHash ||
    observation.programVKey !== policy.programVKey ||
    observation.programVKey !== receipt.programVKey ||
    observation.publicValuesHash !== keccak256(receipt.publicValues) ||
    observation.proofBytesHash !== keccak256(receipt.proofBytes)
  )
    throw new Error('Proof observation differs from caller inputs.');
  return Object.freeze(observation);
}

function object(
  input: unknown,
  keys: readonly string[],
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
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw new Error();
  // Plain data only. No getters may execute during a library caller's parse.
  if (
    own.some(
      (key) => !('value' in Object.getOwnPropertyDescriptor(input, key)!),
    )
  )
    throw new Error();
  return input as Record<string, unknown>;
}
function uint(value: unknown, bits: number): string {
  if (
    typeof value !== 'string' ||
    value.length > 78 ||
    !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) >= 1n << BigInt(bits)
  )
    throw new Error();
  return value;
}
function hex(value: unknown, bytes: number, nonzero = true): Hex {
  if (
    typeof value !== 'string' ||
    value.length !== 2 + bytes * 2 ||
    !/^0x[0-9a-fA-F]+$/.test(value) ||
    (nonzero && /^0x0+$/.test(value))
  )
    throw new Error();
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Address {
  if (
    typeof value !== 'string' ||
    value.length !== 42 ||
    !isAddress(value, { strict: true }) ||
    value.toLowerCase() === zeroAddress
  )
    throw new Error();
  return getAddress(value);
}
function signature(value: unknown): Hex {
  const normalized = hex(value, 65);
  const r = BigInt(normalized.slice(0, 66));
  const s = BigInt(`0x${normalized.slice(66, 130)}`);
  const v = normalized.slice(130);
  if (
    r === 0n ||
    r >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n ||
    s === 0n ||
    s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
    (v !== '1b' && v !== '1c')
  )
    throw new Error();
  return normalized;
}
function decodeJson(text: string, limit: number): unknown {
  if (typeof text !== 'string') throw new Error();
  if (text.length > limit || new TextEncoder().encode(text).byteLength > limit)
    throw new AuditInputError('too_large');
  return parseDuplicateFreeJson(text, limit);
}

/** Strict public bundle. Documents, witnesses, keys and registry claims are rejected as unknown fields. */
export function parseIssuanceReceipt(text: string): IssuanceReceipt {
  try {
    const value = object(decodeJson(text, MAX_RECEIPT_BYTES), [
      'format',
      'request',
      'requestDigest',
      'holderSignature',
      'permit',
      'issuerSignature',
      'publicValues',
      'proofBytes',
      'programVKey',
      'transaction',
    ]);
    if (value.format !== RECEIPT_FORMAT) throw new Error();
    if (
      typeof value.proofBytes !== 'string' ||
      value.proofBytes.length <= 2 ||
      value.proofBytes.length > 2 + MAX_PROOF_BYTES * 2 ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.proofBytes)
    )
      throw new Error();
    let transaction: IssuanceReceipt['transaction'] = null;
    if (value.transaction !== null) {
      const reference = object(value.transaction, ['chainId', 'hash']);
      transaction = Object.freeze({
        chainId: uint(reference.chainId, 256),
        hash: hex(reference.hash, 32),
      });
    }
    return Object.freeze({
      format: RECEIPT_FORMAT,
      request: parseIssuanceRequest(value.request),
      requestDigest: hex(value.requestDigest, 32),
      holderSignature: signature(value.holderSignature),
      permit: parseIssuerPermit(value.permit),
      issuerSignature: signature(value.issuerSignature),
      publicValues: hex(value.publicValues, 224),
      proofBytes: value.proofBytes.toLowerCase() as Hex,
      programVKey: hex(value.programVKey, 32),
      transaction,
    });
  } catch (error) {
    throw error instanceof AuditInputError
      ? error
      : new AuditInputError('invalid_receipt');
  }
}

/** Caller-controlled trust input. Never extract this from a receipt or an untrusted receipt link. */
export function parseAuditPolicy(input: unknown): AuditPolicy {
  try {
    const value = object(
      typeof input === 'string' ? decodeJson(input, MAX_POLICY_BYTES) : input,
      [
        'format',
        'chainId',
        'gate',
        'token',
        'issuerId',
        'issuerAddress',
        'issuerKeyVersion',
        'policyVersion',
        'rightsVersion',
        'programVKey',
        'profileVersion',
        'sourceId',
        'sourceSignerFingerprint',
        'proofSystem',
        'outerVersion',
        'verifierAddress',
        'verifierCodeHash',
      ],
    );
    if (
      value.format !== POLICY_FORMAT ||
      value.proofSystem !== 'sp1-groth16' ||
      typeof value.outerVersion !== 'string' ||
      !/^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(value.outerVersion)
    )
      throw new Error();
    return Object.freeze({
      format: POLICY_FORMAT,
      chainId: uint(value.chainId, 256),
      gate: address(value.gate),
      token: address(value.token),
      issuerId: hex(value.issuerId, 32),
      issuerAddress: address(value.issuerAddress),
      issuerKeyVersion: uint(value.issuerKeyVersion, 64),
      policyVersion: uint(value.policyVersion, 64),
      rightsVersion: uint(value.rightsVersion, 64),
      programVKey: hex(value.programVKey, 32),
      profileVersion: uint(value.profileVersion, 32),
      sourceId: hex(value.sourceId, 32),
      sourceSignerFingerprint: hex(value.sourceSignerFingerprint, 32),
      proofSystem: 'sp1-groth16',
      outerVersion: value.outerVersion,
      verifierAddress: address(value.verifierAddress),
      verifierCodeHash: hex(value.verifierCodeHash, 32),
    });
  } catch (error) {
    throw error instanceof AuditInputError
      ? error
      : new AuditInputError('invalid_policy');
  }
}

export type ClaimOutput = Readonly<{
  profileVersion: string;
  requestDigest: Hex;
  signerFingerprint: Hex;
  sourceId: Hex;
  claimUsageId: Hex;
  claimCommitment: Hex;
  claimValidUntil: string;
}>;
/** Exact static ABI layout of IssuanceGate.Evidence. Reject non-canonical integer padding. */
export function decodeClaimOutput(publicValues: Hex): ClaimOutput {
  try {
    const raw = hex(publicValues, 224).slice(2);
    const word = (index: number) =>
      `0x${raw.slice(index * 64, (index + 1) * 64)}` as Hex;
    return Object.freeze({
      profileVersion: uint(BigInt(word(0)).toString(), 32),
      requestDigest: hex(word(1), 32),
      signerFingerprint: hex(word(2), 32),
      sourceId: hex(word(3), 32),
      claimUsageId: hex(word(4), 32),
      claimCommitment: hex(word(5), 32),
      claimValidUntil: uint(BigInt(word(6)).toString(), 64),
    });
  } catch {
    throw new AuditInputError('invalid_receipt');
  }
}
