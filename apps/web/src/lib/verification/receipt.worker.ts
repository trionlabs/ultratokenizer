import {
  auditIssuanceReceipt,
  parseIssuanceReceipt,
  parseAuditPolicy,
  createRpcProofVerifier,
  AuditInputError,
} from '../../../../../packages/audit/src/index.js';
import {
  checkPayloadSize,
  checkRpcUrl,
  VerificationError,
  type VerificationRequest,
  type VerificationReply,
} from './contracts';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<unknown>) => void;
  postMessage(reply: VerificationReply): void;
};
scope.onmessage = async ({ data }) => {
  const input = data as Partial<VerificationRequest> | null;
  if (
    !input ||
    input.type !== 'verify-issuance-v1' ||
    !Number.isSafeInteger(input.id) ||
    input.id! < 1
  )
    return;
  const id = input.id!;
  try {
    checkPayloadSize(input.text!, input.policyText!);
    checkRpcUrl(input.rpcUrl);
    const policy = parseAuditPolicy(input.policyText);
    const receipt = parseIssuanceReceipt(input.text!);
    const report = await auditIssuanceReceipt(
      input.text!,
      policy,
      input.rpcUrl
        ? {
            proofVerifier: createRpcProofVerifier({
              policy,
              rpcUrl: input.rpcUrl,
            }),
          }
        : {},
    );
    scope.postMessage({
      id,
      ok: true,
      result: {
        receipt,
        report,
        execution: 'dedicated-worker',
        mode: input.rpcUrl ? 'rpc' : 'offline',
      },
    });
  } catch (error) {
    const code =
      error instanceof VerificationError &&
      (error.code === 'too_large' ||
        error.code === 'invalid_rpc' ||
        error.code === 'invalid_policy' ||
        error.code === 'invalid_receipt')
        ? error.code
        : error instanceof AuditInputError && error.code === 'invalid_policy'
          ? 'invalid_policy'
          : error instanceof AuditInputError && error.code === 'too_large'
            ? 'too_large'
            : 'invalid_receipt';
    scope.postMessage({ id, ok: false, code });
  }
};
