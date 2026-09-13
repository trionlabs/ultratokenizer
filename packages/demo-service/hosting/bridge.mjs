import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  TOKEN_HEADER,
  GatewayError,
  forwardJson,
  jsonError,
  publicOrigin,
  validToken,
} from './policy.mjs';

export function createPublicBridge({
  origin,
  token,
  port,
  upstreamPort,
  localOrigin,
  fetchImpl = fetch,
  timeoutMs,
}) {
  publicOrigin(origin);
  const local = new URL(localOrigin);
  if (
    !validToken(token) ||
    local.origin !== localOrigin ||
    local.protocol !== 'http:' ||
    local.hostname !== '127.0.0.1' ||
    ![port, upstreamPort].every(
      (value) => Number.isInteger(value) && value > 1023 && value < 65536,
    ) ||
    port === upstreamPort
  )
    throw new Error('Invalid bridge configuration.');
  const expected = Buffer.from(token, 'hex');
  let active = 0;
  const server = createServer(async (incoming, outgoing) => {
    let response;
    try {
      const supplied = incoming.headers[TOKEN_HEADER];
      if (
        incoming.headers.host !== `127.0.0.1:${port}` ||
        !validToken(supplied) ||
        !timingSafeEqual(expected, Buffer.from(supplied, 'hex'))
      )
        throw new GatewayError(403);
      if (active >= 4) throw new GatewayError(503, 'service_unavailable');
      active += 1;
      try {
        const headers = new Headers();
        for (const key of [
          'origin',
          'content-type',
          'content-length',
          'sec-fetch-site',
        ]) {
          if (incoming.headers[key] !== undefined)
            headers.set(key, incoming.headers[key]);
        }
        const request = new Request(`${origin}${incoming.url}`, {
          method: incoming.method,
          headers,
          body:
            incoming.method === 'POST' ? Readable.toWeb(incoming) : undefined,
          duplex: 'half',
        });
        response = await forwardJson({
          request,
          path: incoming.url,
          expectedOrigin: origin,
          upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
          headers: new Headers({ origin: localOrigin }),
          fetchImpl,
          timeoutMs,
        });
      } finally {
        active -= 1;
      }
    } catch (error) {
      response =
        error instanceof GatewayError
          ? jsonError(error.status, error.code)
          : jsonError();
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
