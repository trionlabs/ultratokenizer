import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
import type { Hex } from 'viem';
import { RequestValidationError } from './errors.js';

/**
 * Canonical type string for the claim usage derivation. It is the domain
 * separator: hashing it produces the first word, keeping this digest distinct
 * from request digests and claim commitments.
 */
export const CLAIM_USAGE_TYPE =
  'UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)';

/**
 * Authenticated fields from a signed source capsule that identify one claim.
 * `claimId` is the claim subject key: a stable, high-entropy, opaque source
 * claim identifier. None of these are holder wallets, salts or policy versions.
 */
export type ClaimIdentity = Readonly<{
  sourceId: Hex;
  claimId: Hex;
}>;

const identityFields = ['sourceId', 'claimId'] as const;

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

/**
 * Stable, privacy-preserving claim usage identifier:
 *
 *   keccak256(abi.encode(typeHash, sourceId, claimId))
 *
 * It is a one-way hash of authenticated capsule identifiers, never a raw
 * document or account identifier, and it does not depend on any holder wallet,
 * issuer, salt or policy version. The caller must supply authenticated source fields;
 * this function validates their shape but not their authenticity.
 */
export function getClaimUsageId(input: unknown): Hex {
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
      'Claim identity must be a plain object.',
    );
  }
  const data = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(data)) {
    if (
      typeof key !== 'string' ||
      !identityFields.some((field) => field === key)
    ) {
      throw new RequestValidationError(
        'unknown_field',
        typeof key === 'string' ? key : '$',
        'Unsupported claim identity field.',
      );
    }
  }
  for (const field of identityFields) {
    if (!Object.hasOwn(data, field)) {
      throw new RequestValidationError(
        'missing_field',
        field,
        'Required claim identity field is missing.',
      );
    }
    if (!('value' in Object.getOwnPropertyDescriptor(data, field)!)) {
      throw new RequestValidationError(
        'invalid_shape',
        field,
        'Claim identity must contain data properties only.',
      );
    }
  }
  const sourceId = identifier(data.sourceId, 'sourceId');
  const claimId = identifier(data.claimId, 'claimId');
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [keccak256(stringToHex(CLAIM_USAGE_TYPE)), sourceId, claimId],
    ),
  );
}
