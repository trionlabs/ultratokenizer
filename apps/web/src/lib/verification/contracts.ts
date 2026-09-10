import type {
  AuditReport,
  IssuanceReceipt,
} from '../../../../../packages/audit/src/index.js';
import { browserRpcMessage, parseBrowserRpcUrl } from '../browser-rpc.ts';

// Preflight bounds mirror the audit parser; the worker rechecks them before parsing.
export const MAX_RECEIPT_BYTES = 256 * 1024;
export const MAX_POLICY_BYTES = 8 * 1024;
export const VERIFICATION_TIMEOUT_MS = 45_000;
export const verificationMessages = {
  too_large:
    'Choose a receipt up to 256 KB and an independent policy up to 8 KB.',
  invalid_receipt:
    'The issuance receipt is invalid or unsupported. Sample receipts are not accepted.',
  invalid_policy: 'The independent caller trust policy is missing or invalid.',
  invalid_rpc: browserRpcMessage,
  unavailable:
    'The verification worker could not start. This browser cannot verify the receipt right now.',
  timeout:
    'Receipt verification timed out. Check the configured RPC if enabled, then retry.',
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
  receipt: IssuanceReceipt;
  report: AuditReport;
  execution: 'dedicated-worker';
  mode: 'offline' | 'rpc';
}>;
export interface ReceiptVerifier {
  verify(
    text: string,
    options: { policyText: string; rpcUrl?: string; signal?: AbortSignal },
  ): Promise<ReceiptVerification>;
  dispose(): void;
}
export type VerificationRequest = Readonly<{
  type: 'verify-issuance-v1';
  id: number;
  text: string;
  policyText: string;
  rpcUrl?: string;
}>;
export type VerificationReply =
  | { id: number; ok: true; result: ReceiptVerification }
  | {
      id: number;
      ok: false;
      code: 'invalid_receipt' | 'invalid_policy' | 'invalid_rpc' | 'too_large';
    };

export function checkPayloadSize(text: string, policyText: string): void {
  if (typeof text !== 'string') throw new VerificationError('invalid_receipt');
  if (typeof policyText !== 'string')
    throw new VerificationError('invalid_policy');
  for (const [value, limit] of [
    [text, MAX_RECEIPT_BYTES],
    [policyText, MAX_POLICY_BYTES],
  ] as const) {
    if (
      value.length > limit ||
      new TextEncoder().encode(value).byteLength > limit
    )
      throw new VerificationError('too_large');
  }
}

export function checkRpcUrl(value: string | undefined): void {
  if (value === undefined) return;
  try {
    parseBrowserRpcUrl(value);
  } catch {
    throw new VerificationError('invalid_rpc');
  }
}
