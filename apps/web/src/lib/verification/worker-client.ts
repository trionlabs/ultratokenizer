import { parseVerificationResult } from './reply';
import {
  checkPayloadSize,
  checkRpcUrl,
  VerificationError,
  VERIFICATION_TIMEOUT_MS,
  type ReceiptVerifier,
  type ReceiptVerification,
  type VerificationRequest,
  type VerificationReply,
  type VerificationErrorCode,
} from './contracts.ts';

/** Internal seam supports the real browser Worker and deterministic lifecycle tests. */
export interface WorkerPort {
  postMessage(message: VerificationRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

export function createWorkerVerifier(
  createWorker: () => WorkerPort,
  timeoutMs = VERIFICATION_TIMEOUT_MS,
): ReceiptVerifier {
  let nextId = 0;
  let disposed = false;
  let cancel: (() => void) | undefined;
  return {
    verify(text, options) {
      cancel?.();
      if (disposed) return Promise.reject(new VerificationError('unavailable'));
      if (options.signal?.aborted)
        return Promise.reject(new VerificationError('cancelled'));
      try {
        checkPayloadSize(text, options.policyText);
        checkRpcUrl(options.rpcUrl);
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise<ReceiptVerification>((resolve, reject) => {
        let worker: WorkerPort;
        try {
          worker = createWorker();
        } catch {
          reject(new VerificationError('unavailable'));
          return;
        }
        const id = ++nextId;
        let settled = false;
        const abort = () => finish('cancelled');
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        function finish(
          code?: VerificationErrorCode,
          result?: ReceiptVerification,
        ) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
          if (cancel === abort) cancel = undefined;
          if (code) reject(new VerificationError(code));
          else resolve(result!);
        }
        cancel = abort;
        options.signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = (event) => {
          try {
            const reply = event.data as Partial<VerificationReply> | null;
            if (!reply || typeof reply !== 'object') {
              finish('failed');
              return;
            }
            if (reply.id !== id) return;
            if (reply.ok === false) {
              finish(
                [
                  'invalid_receipt',
                  'invalid_policy',
                  'invalid_rpc',
                  'too_large',
                ].includes(reply.code ?? '')
                  ? reply.code
                  : 'failed',
              );
            } else if (reply.ok === true) {
              finish(
                undefined,
                parseVerificationResult(
                  reply.result,
                  text,
                  options.rpcUrl ? 'rpc' : 'offline',
                ),
              );
            } else finish('failed');
          } catch {
            // A malformed reply must settle this job instead of escaping an event handler.
            finish('failed');
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          finish('failed');
        };
        worker.onmessageerror = () => finish('failed');
        try {
          worker.postMessage({
            type: 'verify-issuance-v1',
            id,
            text,
            policyText: options.policyText,
            ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
          });
        } catch {
          finish('unavailable');
        }
      });
    },
    dispose() {
      disposed = true;
      cancel?.();
    },
  };
}
