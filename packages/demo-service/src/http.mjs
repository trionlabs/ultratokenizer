import { createServer } from 'node:http';
import { parseDuplicateFreeJson } from '../../../dist/domain/src/index.js';
import { ServiceError, check } from './io.mjs';
import { MAX_PDF_BYTES } from './service.mjs';

const ERRORS = {
  invalid_request: 'This request is not supported.',
  unsupported_document: 'Choose one of the signed demo PDFs.',
  document_too_large: 'The PDF exceeds the supported size.',
  invalid_document: 'The signed document could not be verified.',
  wrong_account: 'Connect the wallet named in this document.',
  invalid_signature:
    'Approve this exact request in the document holder wallet.',
  job_not_found: 'This preparation could not be found.',
  job_conflict: 'This document already has a different or expired preparation.',
  proof_provider_unresolved:
    'The earlier proof request still needs provider reconciliation.',
  proof_budget_unavailable:
    'The current proof run must finish or receive budget approval before another can start.',
  operations_disabled: 'The operator has not enabled this proof run.',
  source_not_admitted:
    'This document signer is not admitted for this deployment.',
  ledger_not_ready: 'The allocation is not ready in the institution ledger.',
  capacity_exceeded: 'The issuer has insufficient available backing capacity.',
  preparation_failed: 'Proof preparation needs operator attention.',
  reservation_uncertain:
    'The reservation needs reconciliation before another attempt.',
  proof_request_uncertain: 'The submitted proof request needs reconciliation.',
  proof_request_rejected:
    'The proof service rejected this request. Minting is unavailable and no automatic retry will occur.',
  proof_observation_unavailable:
    'Proof status is temporarily unavailable. The existing request is retained and will not be submitted again.',
  proof_deadline_elapsed:
    'The proof deadline passed without a verified result.',
  proof_unavailable: 'The verified proof package is not ready yet.',
  proof_invalid: 'The returned proof did not pass verification.',
  issuer_unavailable: 'Issuer authorization needs operator attention.',
  permit_expired: 'Refresh the issuer authorization for this same proof.',
  deployment_unavailable: 'The configured deployment could not be checked.',
  service_unavailable: 'The local preparation service is unavailable.',
};
async function body(request, maximum) {
  const length = request.headers['content-length'];
  if (length !== undefined)
    check(
      /^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= maximum,
      'document_too_large',
      413,
    );
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    check(size <= maximum, 'document_too_large', 413);
    parts.push(part);
  }
  check(size > 0);
  return Buffer.concat(parts, size);
}
function response(reply, status, value) {
  reply.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  reply.end(JSON.stringify(value));
}
export function createApiServer(service, { origin, port }) {
  let active = 0;
  const hosts = new Set([new URL(origin).host, `127.0.0.1:${port}`]);
  const server = createServer(async (request, reply) => {
    try {
      check(hosts.has(request.headers.host), 'invalid_request', 403);
      if (request.headers.origin)
        check(request.headers.origin === origin, 'invalid_request', 403);
      if (request.headers['sec-fetch-site'])
        check(
          ['same-origin', 'same-site', 'none'].includes(
            request.headers['sec-fetch-site'],
          ),
          'invalid_request',
          403,
        );
      if (request.method === 'POST')
        check(request.headers.origin === origin, 'invalid_request', 403);
      check(active < 4, 'service_unavailable', 503);
      active += 1;
      try {
        const url = new URL(request.url, origin);
        check(!url.search && !url.hash && url.origin === origin);
        const route =
          /^\/api\/jobs\/([0-9a-f]{64})(?:\/(start|bundle|permit))?$/.exec(
            url.pathname,
          );
        let result;
        if (request.method === 'GET' && url.pathname === '/api/health')
          result = { status: 'local-demo-service' };
        else if (request.method === 'GET' && url.pathname === '/api/config')
          result = await service.config();
        else if (
          request.method === 'POST' &&
          url.pathname === '/api/documents'
        ) {
          check(
            request.headers['content-type'] === 'application/pdf',
            'unsupported_document',
            415,
          );
          result = await service.document(await body(request, MAX_PDF_BYTES));
        } else if (
          request.method === 'POST' &&
          (url.pathname === '/api/jobs/prepare' ||
            route?.[2] === 'start' ||
            route?.[2] === 'permit')
        ) {
          check(
            request.headers['content-type']?.split(';')[0].trim() ===
              'application/json',
          );
          const bytes = await body(request, 16 * 1024);
          let value;
          try {
            value = parseDuplicateFreeJson(bytes.toString('utf8'), 16 * 1024);
          } catch {
            throw new ServiceError('invalid_request', 400);
          }
          result =
            url.pathname === '/api/jobs/prepare'
              ? await service.prepare(value)
              : route[2] === 'start'
                ? await service.start(route[1], value)
                : await service.refreshPermit(route[1], value);
        } else if (request.method === 'GET' && route && !route[2])
          result = await service.status(route[1]);
        else if (request.method === 'GET' && route?.[2] === 'bundle')
          result = await service.bundle(route[1]);
        else throw new ServiceError('invalid_request', 404);
        response(reply, 200, result);
      } finally {
        active -= 1;
      }
    } catch (error) {
      const code =
        error instanceof ServiceError && Object.hasOwn(ERRORS, error.code)
          ? error.code
          : 'service_unavailable';
      response(reply, error instanceof ServiceError ? error.status : 503, {
        error: { code, message: ERRORS[code] },
      });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  return server;
}
