import { getAddress, isAddress, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { RequestValidationError } from './errors.js';

export const ISSUANCE_REQUEST_VERSION = '1';
export const GOLD_UNIT = 'XAU_MILLIGRAM';

const fields = [
  'schemaVersion',
  'action',
  'requestId',
  'chainId',
  'gate',
  'token',
  'recipient',
  'amount',
  'unit',
  'issuerId',
  'reservationId',
  'claimCommitment',
  'claimUsageId',
  'policyVersion',
  'rightsVersion',
  'nonce',
  'validUntil',
] as const;

export type IssuanceRequest = Readonly<{
  schemaVersion: typeof ISSUANCE_REQUEST_VERSION;
  action: 'ISSUE';
  requestId: Hex;
  chainId: string;
  gate: Address;
  token: Address;
  recipient: Address;
  /** Gold quantity in milligrams; token base-unit conversion is a separate check. */
  amount: string;
  unit: typeof GOLD_UNIT;
  /** Institution identity, distinct from its current signing key. */
  issuerId: Hex;
  reservationId: Hex;
  claimCommitment: Hex;
  /** This module validates the identifier's format, not its derivation or uniqueness. */
  claimUsageId: Hex;
  policyVersion: string;
  rightsVersion: string;
  nonce: string;
  /** Exclusive expiry, expressed in Unix seconds. */
  validUntil: string;
}>;

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestValidationError(
      'invalid_shape',
      '$',
      'Request must be a plain object.',
    );
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RequestValidationError(
      'invalid_shape',
      '$',
      'Request must be a plain object.',
    );
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !fields.some((field) => field === key)) {
      throw new RequestValidationError(
        'unknown_field',
        typeof key === 'string' ? key : '$',
        'Request contains an unsupported field.',
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) {
      throw new RequestValidationError(
        'missing_field',
        field,
        `Request requires ${field}.`,
      );
    }
  }
  return input as Record<string, unknown>;
}

function literal<T extends string>(
  value: unknown,
  field: string,
  expected: T,
): T {
  if (value !== expected) {
    throw new RequestValidationError(
      'invalid_literal',
      field,
      `Unsupported ${field}.`,
    );
  }
  return expected;
}

function uint(
  value: unknown,
  field: string,
  bits: 64 | 256,
  allowZero = false,
): string {
  // Bound length before BigInt conversion; arbitrary-size input must not consume unbounded work.
  const maximumDigits = bits === 64 ? 20 : 78;
  if (
    typeof value !== 'string' ||
    value.length > maximumDigits ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new RequestValidationError(
      'invalid_integer',
      field,
      `${field} must be a canonical unsigned decimal string.`,
    );
  }
  const integer = BigInt(value);
  if (
    (!allowZero && integer === BigInt(0)) ||
    integer >= BigInt(1) << BigInt(bits)
  ) {
    throw new RequestValidationError(
      'integer_out_of_range',
      field,
      `${field} is outside its permitted range.`,
    );
  }
  return value;
}

function address(value: unknown, field: string): Address {
  if (
    typeof value !== 'string' ||
    !isAddress(value, { strict: true }) ||
    value.toLowerCase() === zeroAddress
  ) {
    throw new RequestValidationError(
      'invalid_address',
      field,
      `${field} must be a nonzero EVM address with a valid checksum when mixed-case.`,
    );
  }
  return getAddress(value);
}

function identifier(value: unknown, field: string): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    /^0x0{64}$/.test(value)
  ) {
    throw new RequestValidationError(
      'invalid_identifier',
      field,
      `${field} must be a nonzero 32-byte hex value.`,
    );
  }
  return value.toLowerCase() as Hex;
}

/** Validate untrusted input without authenticating evidence or consulting a registry. */
export function parseIssuanceRequest(input: unknown): IssuanceRequest {
  const value = record(input);
  return Object.freeze({
    schemaVersion: literal(
      value.schemaVersion,
      'schemaVersion',
      ISSUANCE_REQUEST_VERSION,
    ),
    action: literal(value.action, 'action', 'ISSUE'),
    requestId: identifier(value.requestId, 'requestId'),
    chainId: uint(value.chainId, 'chainId', 256),
    gate: address(value.gate, 'gate'),
    token: address(value.token, 'token'),
    recipient: address(value.recipient, 'recipient'),
    amount: uint(value.amount, 'amount', 256),
    unit: literal(value.unit, 'unit', GOLD_UNIT),
    issuerId: identifier(value.issuerId, 'issuerId'),
    reservationId: identifier(value.reservationId, 'reservationId'),
    claimCommitment: identifier(value.claimCommitment, 'claimCommitment'),
    claimUsageId: identifier(value.claimUsageId, 'claimUsageId'),
    policyVersion: uint(value.policyVersion, 'policyVersion', 64),
    rightsVersion: uint(value.rightsVersion, 'rightsVersion', 64),
    nonce: uint(value.nonce, 'nonce', 256, true),
    validUntil: uint(value.validUntil, 'validUntil', 64),
  });
}

/** Stable JSON for storage/export. Sign the EIP-712 digest, not this string. */
export function serializeIssuanceRequest(input: unknown): string {
  return JSON.stringify(parseIssuanceRequest(input));
}

/** A request is valid only strictly before its expiry; caller supplies the clock. */
export function assertIssuanceRequestActive(
  input: unknown,
  now: bigint,
): IssuanceRequest {
  const request = parseIssuanceRequest(input);
  if (typeof now !== 'bigint' || now < BigInt(0)) {
    throw new RequestValidationError(
      'invalid_time',
      'now',
      'Current time must be nonnegative Unix seconds as a bigint.',
    );
  }
  if (now >= BigInt(request.validUntil)) {
    throw new RequestValidationError(
      'expired_request',
      'validUntil',
      'Request has expired.',
    );
  }
  return request;
}
