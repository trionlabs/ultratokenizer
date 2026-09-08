import { verifySampleReceipt } from '../adapters/sample-receipt';
import {
  checkPayloadSize,
  VerificationError,
  type VerificationRequest,
  type VerificationReply,
} from './contracts';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<unknown>) => void;
  postMessage(reply: VerificationReply): void;
};
scope.onmessage = ({ data }) => {
  const input = data as Partial<VerificationRequest> | null;
  if (
    !input ||
    input.type !== 'verify-sample-v1' ||
    !Number.isSafeInteger(input.id) ||
    input.id! < 1
  )
    return;
  const id = input.id!;
  try {
    checkPayloadSize(input.text!);
    const receipt = verifySampleReceipt(input.text!);
    scope.postMessage({
      id,
      ok: true,
      result: {
        receipt,
        execution: 'dedicated-worker',
        requestIntegrity: 'consistent',
        evidence: 'not-verified',
        issuer: 'not-verified',
        proof: 'not-verified',
        chain: 'not-verified',
      },
    });
  } catch (error) {
    // Never send parser internals, stack traces or input values back to the view.
    const code =
      error instanceof VerificationError
        ? 'too_large'
        : error instanceof Error &&
            error.message.startsWith('Request digest mismatch.')
          ? 'digest_mismatch'
          : 'invalid_receipt';
    scope.postMessage({ id, ok: false, code });
  }
};
