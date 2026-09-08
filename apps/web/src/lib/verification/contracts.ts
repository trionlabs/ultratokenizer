import type { SampleReceipt } from '../adapters/sample-receipt';

export const MAX_RECEIPT_BYTES = 64 * 1024;
export const VERIFICATION_TIMEOUT_MS = 8_000;

export const verificationMessages = {
  too_large: 'Choose a sample receipt smaller than 64 KB.',
  invalid_receipt:
    'This receipt is invalid or unsupported. Choose a sample v1 receipt.',
  digest_mismatch:
    'Request digest mismatch. The request or digest was changed.',
  unavailable:
    'The verification worker could not start. This browser cannot verify the receipt right now.',
  timeout: 'Receipt verification timed out. Try again with a supported sample.',
  cancelled: 'Receipt verification was cancelled.',
  failed: 'The verification worker stopped unexpectedly. Try again.',
} as const;

export type VerificationErrorCode = keyof typeof verificationMessages;
export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  constructor(code: VerificationErrorCode) {
    super(verificationMessages[code]);
    this.name = 'VerificationError';
    this.code = code;
  }
}

export type ReceiptVerification = Readonly<{
  receipt: SampleReceipt;
  execution: 'dedicated-worker';
  requestIntegrity: 'consistent';
  evidence: 'not-verified';
  issuer: 'not-verified';
  proof: 'not-verified';
  chain: 'not-verified';
}>;

/** Latest request wins. Abort, timeout and disposal terminate CPU work, not just its display. */
export interface ReceiptVerifier {
  verify(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReceiptVerification>;
  dispose(): void;
}

export type VerificationRequest = Readonly<{
  type: 'verify-sample-v1';
  id: number;
  text: string;
}>;
export type VerificationReply =
  | { id: number; ok: true; result: ReceiptVerification }
  | {
      id: number;
      ok: false;
      code: 'invalid_receipt' | 'digest_mismatch' | 'too_large';
    };

export function checkPayloadSize(text: string): void {
  // Reject huge strings before allocating the UTF-8 buffer, then bound actual bytes.
  if (
    typeof text !== 'string' ||
    text.length > MAX_RECEIPT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_RECEIPT_BYTES
  )
    throw new VerificationError('too_large');
}
