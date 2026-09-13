// This gateway forwards only the existing document API. The issuer service still
// owns document admission, holder signatures, reservations and proof spending.
export const TOKEN_HEADER = 'x-ultratokenizer-gateway';
export const MAX_PDF_BYTES = 256 * 1024;
export const MAX_JSON_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 160 * 1024;
export const TIMEOUT_MS = 30_000;

export class GatewayError extends Error {
  constructor(status, code = 'invalid_request') {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function jsonError(status = 503, code = 'service_unavailable') {
  return jsonResponse(status, {
    error: {
      code,
      message:
        code === 'service_unavailable'
          ? 'The document service is temporarily unavailable.'
          : code === 'document_too_large'
            ? 'The document exceeds the supported size.'
            : 'This request is not supported.',
    },
  });
}

export function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

export function publicOrigin(value) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
    url.hostname.endsWith('.localhost')
  )
    throw new GatewayError(503, 'service_unavailable');
  return url.origin;
}

export function validToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
}

export function routePolicy(method, path) {
  if (method === 'GET' && /^\/api\/(health|config)$/.test(path))
    return { maximum: 0 };
  if (method === 'POST' && path === '/api/documents')
    return { maximum: MAX_PDF_BYTES, type: 'application/pdf' };
  if (method === 'POST' && path === '/api/jobs/prepare')
    return { maximum: MAX_JSON_BYTES, type: 'application/json' };
  if (method === 'GET' && /^\/api\/jobs\/[0-9a-f]{64}(?:\/bundle)?$/.test(path))
    return { maximum: 0 };
  if (
    method === 'POST' &&
    /^\/api\/jobs\/[0-9a-f]{64}\/(?:start|permit)$/.test(path)
  )
    return { maximum: MAX_JSON_BYTES, type: 'application/json' };
  throw new GatewayError(404);
}

export function checkRequest(request, expectedOrigin, path) {
  // Apply the expression to the raw path at the Node boundary too, before URL
  // normalization can discard traversal, query strings or encoded separators.
  const policy = routePolicy(request.method, path);
  const origin = request.headers.get('origin');
  if (
    (origin !== null && origin !== expectedOrigin) ||
    (request.method === 'POST' && origin !== expectedOrigin)
  )
    throw new GatewayError(403);
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site))
    throw new GatewayError(403);
  const length = request.headers.get('content-length');
  if (
    length !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > policy.maximum)
  )
    throw new GatewayError(413, 'document_too_large');
  if (
    policy.type &&
    request.headers.get('content-type')?.split(';')[0].trim() !== policy.type
  )
    throw new GatewayError(415);
  return policy;
}

export async function boundedBody(stream, maximum, signal) {
  if (!stream) return undefined;
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new GatewayError(503, 'service_unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new GatewayError(413, 'document_too_large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}

export async function forwardJson({
  request,
  path,
  expectedOrigin,
  upstreamOrigin,
  headers,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  const policy = checkRequest(request, expectedOrigin, path);
  const signal = AbortSignal.timeout(timeoutMs);
  const bytes = await boundedBody(request.body, policy.maximum, signal);
  if (request.method === 'POST' && !bytes?.length) throw new GatewayError(400);
  if (policy.type) headers.set('content-type', policy.type);
  headers.set('accept', 'application/json');
  const upstream = await fetchImpl(`${upstreamOrigin}${path}`, {
    method: request.method,
    headers,
    body: request.method === 'POST' ? bytes : undefined,
    redirect: 'manual',
    signal,
  });
  if (
    upstream.status < 200 ||
    (upstream.status >= 300 && upstream.status < 400) ||
    upstream.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json'
  ) {
    void upstream.body?.cancel().catch(() => {});
    throw new GatewayError(503, 'service_unavailable');
  }
  // Do not forward arbitrary origin headers, cookies, redirects or error bodies.
  let value;
  try {
    const responseBytes = await boundedBody(
      upstream.body,
      MAX_RESPONSE_BYTES,
      signal,
    );
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(responseBytes),
    );
  } catch {
    throw new GatewayError(503, 'service_unavailable');
  }
  return jsonResponse(upstream.status, value);
}
