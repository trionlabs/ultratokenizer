import { hashTypedData } from 'viem';
import type { Hex } from 'viem';
import { RequestValidationError } from './errors.js';
import { parseIssuanceRequest } from './issuance-request.js';
import { getIssuanceRequestDigest } from './request-digest.js';

export type IssuerPermit = Readonly<{
  requestDigest: Hex;
  issuerId: Hex;
  keyVersion: string;
  nonce: string;
  validUntil: string;
}>;

const fields = [
  'requestDigest',
  'issuerId',
  'keyVersion',
  'nonce',
  'validUntil',
] as const;

/** Parses a distinct issuer authorization, without authenticating its signer or live registry state. */
export function parseIssuerPermit(input: unknown): IssuerPermit {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new RequestValidationError(
      'invalid_shape',
      '$',
      'Permit must be a plain object.',
    );
  }
  const data = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string' || !fields.some((field) => field === key)) {
      throw new RequestValidationError(
        'unknown_field',
        typeof key === 'string' ? key : '$',
        'Unsupported permit field.',
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(data, field))
      throw new RequestValidationError(
        'missing_field',
        field,
        'Required permit field is missing.',
      );
  }
  const identifier = (field: 'requestDigest' | 'issuerId'): Hex => {
    const value = data[field];
    if (
      typeof value !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(value) ||
      /^0x0{64}$/.test(value)
    ) {
      throw new RequestValidationError(
        'invalid_identifier',
        field,
        'Permit requires a nonzero bytes32 identifier.',
      );
    }
    return value.toLowerCase() as Hex;
  };
  const integer = (field: 'keyVersion' | 'nonce' | 'validUntil'): string => {
    const value = data[field];
    const bits = field === 'nonce' ? 256 : 64;
    if (
      typeof value !== 'string' ||
      value.length > (bits === 64 ? 20 : 78) ||
      !/^(0|[1-9][0-9]*)$/.test(value)
    ) {
      throw new RequestValidationError(
        'invalid_integer',
        field,
        'Permit integers must be canonical decimal strings.',
      );
    }
    if (
      (field !== 'nonce' && value === '0') ||
      BigInt(value) >= 1n << BigInt(bits)
    ) {
      throw new RequestValidationError(
        'integer_out_of_range',
        field,
        'Permit integer is out of range.',
      );
    }
    return value;
  };
  return Object.freeze({
    requestDigest: identifier('requestDigest'),
    issuerId: identifier('issuerId'),
    keyVersion: integer('keyVersion'),
    nonce: integer('nonce'),
    validUntil: integer('validUntil'),
  });
}

/** Binds the permit to the complete canonical request and the same EIP-712 chain/gate domain. */
export function getIssuerPermitTypedData(
  requestInput: unknown,
  permitInput: unknown,
) {
  const request = parseIssuanceRequest(requestInput);
  const permit = parseIssuerPermit(permitInput);
  if (
    permit.requestDigest !== getIssuanceRequestDigest(request) ||
    permit.issuerId !== request.issuerId
  ) {
    throw new RequestValidationError(
      'invalid_identifier',
      'requestDigest',
      'Permit does not authorize this request and issuer.',
    );
  }
  if (BigInt(permit.validUntil) > BigInt(request.validUntil)) {
    throw new RequestValidationError(
      'invalid_time',
      'validUntil',
      'Permit must expire no later than its request.',
    );
  }
  return {
    domain: {
      name: 'Ultratokenizer',
      version: '1',
      chainId: BigInt(request.chainId),
      verifyingContract: request.gate,
    },
    primaryType: 'IssuerPermit' as const,
    types: {
      IssuerPermit: [
        { name: 'requestDigest', type: 'bytes32' },
        { name: 'issuerId', type: 'bytes32' },
        { name: 'keyVersion', type: 'uint64' },
        { name: 'nonce', type: 'uint256' },
        { name: 'validUntil', type: 'uint64' },
      ],
    },
    message: {
      requestDigest: permit.requestDigest,
      issuerId: permit.issuerId,
      keyVersion: BigInt(permit.keyVersion),
      nonce: BigInt(permit.nonce),
      validUntil: BigInt(permit.validUntil),
    },
  };
}

/** Historical hashing is allowed. Execution must additionally check live expiry, revocation and nonce use. */
export function getIssuerPermitDigest(
  requestInput: unknown,
  permitInput: unknown,
): Hex {
  return hashTypedData(getIssuerPermitTypedData(requestInput, permitInput));
}
