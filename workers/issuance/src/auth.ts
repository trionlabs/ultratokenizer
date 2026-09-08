import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
} from 'viem';
import { isRecord, WorkerError } from './errors.ts';

export type AuthConfiguration = Readonly<{
  issuer: string;
  audience: string;
  jwks: string;
}>;
export type Principal = Readonly<{ ownerId: string; wallet: Address }>;

/** Authenticated API ownership is separate from a contract's issuer authority. */
export async function authenticate(
  header: string | null,
  config: AuthConfiguration,
  now: Date,
): Promise<Principal> {
  if (!config.issuer || !config.audience || config.jwks.length > 32_768)
    throw new WorkerError('not_configured');
  let jwks: unknown;
  try {
    jwks = JSON.parse(config.jwks);
  } catch {
    throw new WorkerError('not_configured');
  }
  if (
    !isRecord(jwks) ||
    !Array.isArray(jwks.keys) ||
    jwks.keys.length < 1 ||
    jwks.keys.length > 8
  )
    throw new WorkerError('not_configured');
  const keys = jwks.keys;
  if (
    keys.some(
      (key) =>
        !isRecord(key) ||
        key.kty !== 'RSA' ||
        key.alg !== 'RS256' ||
        typeof key.kid !== 'string' ||
        !key.kid ||
        Object.hasOwn(key, 'd') ||
        Object.hasOwn(key, 'k'),
    )
  )
    throw new WorkerError('not_configured');
  if (
    !header ||
    header.length > 8_192 ||
    !header.startsWith('Bearer ') ||
    header.slice(7).includes(' ')
  )
    throw new WorkerError('unauthorized');
  try {
    const resolver = createLocalJWKSet({ keys });
    const { payload, protectedHeader } = await jwtVerify(
      header.slice(7),
      resolver,
      {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.audience,
        typ: 'at+jwt',
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'wallet'],
        maxTokenAge: 300,
        clockTolerance: 0,
        currentDate: now,
      },
    );
    if (
      typeof protectedHeader.kid !== 'string' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      payload.sub.length > 256 ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 300 ||
      typeof payload.wallet !== 'string' ||
      !isAddress(payload.wallet, { strict: true }) ||
      /^0x0{40}$/i.test(payload.wallet)
    )
      throw new Error('Rejected claims.');
    return Object.freeze({
      ownerId: keccak256(
        stringToHex(JSON.stringify([config.issuer, payload.sub])),
      ),
      wallet: getAddress(payload.wallet),
    });
  } catch {
    throw new WorkerError('unauthorized');
  }
}
