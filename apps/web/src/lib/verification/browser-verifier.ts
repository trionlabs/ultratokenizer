import { createWorkerVerifier } from './worker-client';

/** No main-thread verification fallback: worker startup failures stay visible. */
export function createBrowserReceiptVerifier() {
  return createWorkerVerifier(
    () =>
      new Worker(new URL('./receipt.worker.ts', import.meta.url), {
        type: 'module',
        name: 'receipt-verifier',
      }),
  );
}
