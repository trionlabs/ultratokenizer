import {
  parseIssuanceReceipt,
  parseAuditPolicy,
  parseRpcProofObservation,
  REPORT_FORMAT,
  type AuditCheck,
} from '../../../../../packages/audit/src/index.js';
import type { ReceiptVerification } from './contracts';
import { getIssuanceRequestDigest } from '../../../../../packages/domain/src/index.js';

// These are the versioned audit-report.v2 capabilities, not a new verifier.
const unknownChecks = [
  'historical_registry',
  'historical_reservation',
  'historical_supply',
  'historical_token_configuration',
  'replay_accounting',
  'execution_time',
  'current_revocation',
  'account_code',
];
const checkIds = [
  'request_digest',
  'caller_policy',
  'contract_amount',
  'holder_eoa_signature',
  'permit_binding',
  'issuer_eoa_signature',
  'public_values_binding',
  'expiry_order',
  'proof_cryptography',
  'transaction_inclusion',
  ...unknownChecks,
];

function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    throw new Error();
  return value as Record<string, unknown>;
}

function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !('value' in descriptor)) throw new Error();
  }
  return value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit)
    throw new Error();
  return value;
}
function identifier(value: unknown): string {
  const id = text(value, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error();
  return id;
}
function check(value: unknown): AuditCheck {
  const row = record(value, ['id', 'status', 'detail']);
  if (
    row.status !== 'verified' &&
    row.status !== 'failed' &&
    row.status !== 'unverified'
  )
    throw new Error();
  return Object.freeze({
    id: identifier(row.id),
    status: row.status,
    detail: text(row.detail, 4096),
  });
}

// Compare only the bounded canonical input's own data fields; never serialize an
// arbitrary worker value or let its replacement receipt reach presentation code.
function sameData(expected: unknown, actual: unknown): boolean {
  if (!expected || typeof expected !== 'object') return actual === expected;
  const fields = Object.keys(expected);
  const candidate = record(actual, fields);
  return Object.entries(expected).every(([key, value]) =>
    sameData(value, candidate[key]),
  );
}

/** Structural transport validation, not an audit fallback or proof verification. */
export function parseVerificationResult(
  input: unknown,
  receiptText: string,
  policyText: string,
  rpcUrl?: string,
): ReceiptVerification {
  const mode = rpcUrl ? 'rpc' : 'offline';
  const result = record(input, ['receipt', 'report', 'execution', 'mode']);
  if (result.execution !== 'dedicated-worker' || result.mode !== mode)
    throw new Error();
  const receipt = parseIssuanceReceipt(receiptText);
  if (!sameData(receipt, result.receipt)) throw new Error();
  const requestDigest = getIssuanceRequestDigest(receipt.request);
  const report = record(result.report, [
    'format',
    'status',
    'complete',
    'requestDigest',
    'proofVerification',
    'checks',
    'missingEvidence',
    'limitations',
  ]);
  if (
    report.format !== REPORT_FORMAT ||
    report.complete !== false ||
    (report.status !== 'invalid' && report.status !== 'incomplete') ||
    report.requestDigest !== requestDigest
  )
    throw new Error();
  const checks = list(report.checks, 64).map(check);
  const proofVerification =
    report.proofVerification === null
      ? null
      : parseRpcProofObservation(
          report.proofVerification,
          receipt,
          parseAuditPolicy(policyText),
        );
  const proofStatus = checks.find(
    (item) => item.id === 'proof_cryptography',
  )?.status;
  if (
    (proofVerification &&
      (!rpcUrl ||
        proofVerification.rpcOrigin !== new URL(rpcUrl).origin ||
        proofStatus !==
          (proofVerification.result === 'returned' ? 'verified' : 'failed'))) ||
    (proofStatus === 'verified' && !proofVerification)
  )
    throw new Error();
  const ids = checks.map((item) => item.id);
  const missingEvidence = list(report.missingEvidence, 64).map(identifier);
  const missing = checks
    .filter((item) => item.status === 'unverified')
    .map((item) => item.id);
  if (
    checks.length !== checkIds.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !checkIds.includes(id)) ||
    checks.some(
      (item) =>
        ((unknownChecks.includes(item.id) ||
          (mode === 'offline' && item.id === 'proof_cryptography')) &&
          item.status !== 'unverified') ||
        (item.id === 'transaction_inclusion' && item.status === 'verified'),
    ) ||
    new Set(missingEvidence).size !== missingEvidence.length ||
    missingEvidence.length !== missing.length ||
    missing.some((id) => !missingEvidence.includes(id)) ||
    report.status !==
      (checks.some((item) => item.status === 'failed')
        ? 'invalid'
        : 'incomplete')
  )
    throw new Error();
  return Object.freeze({
    receipt,
    report: Object.freeze({
      format: REPORT_FORMAT,
      status: report.status,
      complete: false,
      requestDigest,
      proofVerification,
      checks: Object.freeze(checks),
      missingEvidence: Object.freeze(missingEvidence),
      limitations: Object.freeze(
        list(report.limitations, 32).map((value) => text(value, 4096)),
      ),
    }),
    execution: 'dedicated-worker',
    mode,
  });
}
