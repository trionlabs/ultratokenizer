export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'not_configured'
  | 'unavailable';

const statusCodes: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  not_configured: 503,
  unavailable: 503,
};

/** Fixed error codes never contain tokens, wallet signatures or source data. */
export class WorkerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode) {
    super(code);
    this.name = 'WorkerError';
    this.code = code;
    this.status = statusCodes[code];
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new WorkerError('invalid_request');
  }
  return value;
}

/** Bounds streamed input even when Content-Length is absent or dishonest. */
export async function readJson(
  request: Request | Response,
  maximum: number,
): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (
    declared &&
    (/^[0-9]{1,10}$/.test(declared) ? Number(declared) > maximum : true)
  )
    throw new WorkerError('payload_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkerError('invalid_request');
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 5_000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new WorkerError('payload_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (timedOut) throw new WorkerError('invalid_request');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new WorkerError('invalid_request');
  }
}
