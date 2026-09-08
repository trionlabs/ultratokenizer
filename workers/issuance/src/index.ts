import { verifyTypedData, type Hex } from 'viem';
import {
  assertIssuanceRequestActive,
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
} from '../../../packages/domain/src/index.js';
import { authenticate } from './auth.ts';
import { isHash, validateChainConfiguration } from './chain-observer.ts';
import { chainConfiguration, IssuanceCoordinator } from './coordinator.ts';
import { exactKeys, readJson, WorkerError } from './errors.ts';

export { IssuanceCoordinator };

function response(value: unknown, status: number, origin?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return new Response(JSON.stringify(value), { status, headers });
}

export default {
  async fetch(request: Request, env: IssuanceEnv): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const allowedOrigin =
      origin && origin === env.ALLOWED_ORIGIN ? origin : undefined;
    try {
      if (url.pathname === '/healthz' && request.method === 'GET')
        return response(
          { status: 'up', module: 'issuance-coordinator', schemaVersion: 1 },
          200,
        );
      if (origin && !allowedOrigin) throw new WorkerError('forbidden');
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) throw new WorkerError('forbidden');
        const result = new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': allowedOrigin,
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Authorization, Content-Type',
            'access-control-max-age': '300',
            vary: 'Origin',
            'cache-control': 'no-store',
          },
        });
        return result;
      }
      validateChainConfiguration(chainConfiguration(env));
      const edgeLimit = await env.API_RATE_LIMIT.limit({
        key: `edge:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`,
      });
      if (!edgeLimit.success) throw new WorkerError('rate_limited');
      const principal = await authenticate(
        request.headers.get('authorization'),
        {
          issuer: env.AUTH_ISSUER,
          audience: env.AUTH_AUDIENCE,
          jwks: env.AUTH_JWKS,
        },
        new Date(),
      );
      const limit = await env.API_RATE_LIMIT.limit({ key: principal.ownerId });
      if (!limit.success) throw new WorkerError('rate_limited');
      if (url.search) throw new WorkerError('invalid_request');
      const route =
        /^\/v1\/requests\/(0x[0-9a-f]{64})(?:\/(transactions|cancel|reconcile))?$/.exec(
          url.pathname,
        );
      if (request.method === 'POST' && url.pathname === '/v1/requests') {
        if (
          request.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json'
        )
          throw new WorkerError('invalid_request');
        const body = exactKeys(await readJson(request, 16_384), [
          'request',
          'holderSignature',
        ]);
        let canonical;
        try {
          canonical = assertIssuanceRequestActive(
            body.request,
            BigInt(Math.floor(Date.now() / 1000)),
          );
        } catch {
          throw new WorkerError('invalid_request');
        }
        if (canonical.recipient !== principal.wallet)
          throw new WorkerError('forbidden');
        if (
          canonical.chainId !== env.CHAIN_ID ||
          canonical.gate.toLowerCase() !== env.GATE_ADDRESS.toLowerCase()
        )
          throw new WorkerError('invalid_request');
        if (
          typeof body.holderSignature !== 'string' ||
          !/^0x[0-9a-fA-F]{130}$/.test(body.holderSignature)
        )
          throw new WorkerError('invalid_request');
        let valid = false;
        try {
          valid = await verifyTypedData({
            ...getIssuanceRequestTypedData(canonical),
            address: principal.wallet,
            signature: body.holderSignature as Hex,
          });
        } catch {
          throw new WorkerError('invalid_request');
        }
        if (!valid) throw new WorkerError('forbidden');
        const id = getIssuanceRequestDigest(canonical);
        const result = await env.REQUESTS.getByName(id).create(
          principal.ownerId,
          canonical,
        );
        return response(result, 200, allowedOrigin);
      }
      if (!route || !isHash(route[1])) throw new WorkerError('not_found');
      const stub = env.REQUESTS.getByName(route[1]);
      if (request.method === 'GET' && !route[2])
        return response(
          await stub.inspect(principal.ownerId),
          200,
          allowedOrigin,
        );
      if (request.method === 'POST' && route[2] === 'transactions') {
        if (
          request.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json'
        )
          throw new WorkerError('invalid_request');
        const body = exactKeys(await readJson(request, 256), [
          'transactionHash',
        ]);
        if (!isHash(body.transactionHash))
          throw new WorkerError('invalid_request');
        return response(
          await stub.submit(
            principal.ownerId,
            body.transactionHash.toLowerCase() as Hex,
          ),
          202,
          allowedOrigin,
        );
      }
      if (request.method === 'POST' && route[2] === 'cancel')
        return response(
          await stub.cancel(principal.ownerId),
          200,
          allowedOrigin,
        );
      if (request.method === 'POST' && route[2] === 'reconcile')
        return response(
          await stub.reconcile(principal.ownerId),
          202,
          allowedOrigin,
        );
      throw new WorkerError('not_found');
    } catch (error) {
      // RPC serializes custom errors as Error; preserve only our known fixed messages.
      const known =
        error instanceof Error &&
        [
          'invalid_request',
          'unauthorized',
          'forbidden',
          'not_found',
          'conflict',
          'payload_too_large',
          'rate_limited',
          'not_configured',
        ].includes(error.message);
      const failure =
        error instanceof WorkerError
          ? error
          : known
            ? new WorkerError(
                error.message as ConstructorParameters<typeof WorkerError>[0],
              )
            : new WorkerError('unavailable');
      console.warn(
        JSON.stringify({ event: 'api_rejected', code: failure.code }),
      );
      const result = response(
        { error: failure.code },
        failure.status,
        allowedOrigin,
      );
      if (failure.status === 401)
        result.headers.set('www-authenticate', 'Bearer');
      if (failure.status === 429) result.headers.set('retry-after', '60');
      return result;
    }
  },
} satisfies ExportedHandler<IssuanceEnv>;
