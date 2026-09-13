import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import {
  getIssuanceRequestDigest,
  parseDuplicateFreeJson,
} from '../../../../../packages/domain/src/index.js';
import {
  parsePreparedIssuanceRequest,
  parseIssuanceBundle,
  MAX_BUNDLE_BYTES,
  type PreparedIssuanceRequest,
} from '../issuance';

export const MAX_PDF_BYTES = 256 * 1024;
const RESPONSE_LIMIT = 48 * 1024;
const messages = {
  invalid_request:
    'The document service returned an invalid response. Try again.',
  unsupported_document:
    'Choose one of this issuer’s approved signed PDFs. Other PDFs and email documents are not supported.',
  document_too_large: 'Choose a signed PDF no larger than 256 KB.',
  invalid_document:
    'This PDF could not be authenticated. Choose a supported signed document.',
  wrong_account: 'Connect the recipient wallet shown on this document.',
  invalid_signature:
    'The wallet approval does not match this document request. Review and sign again.',
  job_not_found:
    'This verification job is unavailable. Keep the document and contact the issuer.',
  job_conflict:
    'This document already has an active request. Check its existing status before retrying.',
  proof_provider_unresolved:
    'The proof service is not ready. Your document can be uploaded, but verification cannot start yet.',
  proof_budget_unavailable:
    'The approved proof budget is unavailable. New verification requests are paused.',
  operations_disabled: 'The issuer has paused new verification requests.',
  source_not_admitted:
    'This document signer is not currently admitted by the issuer.',
  ledger_not_ready: 'The issuer ledger is not ready for this document.',
  capacity_exceeded:
    'The issuer cannot reserve the full document amount right now.',
  preparation_failed:
    'The issuance request could not be prepared. No mint was submitted.',
  reservation_uncertain:
    'The reservation outcome needs review. Do not start another request.',
  proof_request_uncertain:
    'The proof request outcome needs review. Do not start another request.',
  proof_observation_unavailable:
    'The submitted proof request could not be checked. The issuer will resume tracking this same request; do not start another.',
  proof_deadline_elapsed:
    'The proof request deadline passed. The issuer must review this request.',
  proof_unavailable: 'The proof service is unavailable. No mint was submitted.',
  proof_invalid:
    'The returned proof did not pass validation. Minting is unavailable.',
  issuer_unavailable:
    'Issuer authorization is unavailable. No mint was submitted.',
  permit_expired:
    'Issuer approval expired. Refresh approval for the existing proof.',
  deployment_unavailable:
    'The testnet configuration is unavailable. You can still choose your document.',
  service_unavailable:
    'The document service is unavailable. Try again when it is ready.',
} as const;
type ErrorCode = keyof typeof messages;
export class DocumentClientError extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
  }
}
export function documentErrorMessage(error: unknown): string {
  return error instanceof DocumentClientError
    ? error.message
    : messages.service_unavailable;
}
export function documentBlocker(
  code: string | null | undefined,
): string | undefined {
  return code && Object.hasOwn(messages, code)
    ? messages[code as ErrorCode]
    : undefined;
}
function invalid(): never {
  throw new DocumentClientError('invalid_request');
}
function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid();
  return result;
}
function text(value: unknown, limit: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > limit ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    invalid();
  return value;
}
function identifier(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid();
  return result;
}
function decimal(value: unknown, positive = false): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    (positive && BigInt(value) === 0n)
  )
    invalid();
  return value;
}
function hash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    invalid();
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Address {
  try {
    return getAddress(text(value, 42));
  } catch {
    return invalid();
  }
}
function errorCode(value: unknown): ErrorCode {
  if (typeof value !== 'string' || !Object.hasOwn(messages, value)) invalid();
  return value as ErrorCode;
}
function readiness(value: unknown) {
  const v = record(value, ['canStart'], ['blocker']);
  if (typeof v.canStart !== 'boolean') invalid();
  const blocker = v.blocker === undefined ? undefined : errorCode(v.blocker);
  if ((v.canStart && blocker) || (!v.canStart && !blocker)) invalid();
  return Object.freeze({ canStart: v.canStart, blocker });
}
function term(value: unknown) {
  const v = record(value, ['text', 'hash']);
  const content = text(v.text, 12 * 1024);
  const digest = hash(v.hash);
  if (keccak256(toHex(content)) !== digest) invalid();
  return Object.freeze({ text: content, hash: digest });
}
function configuration(value: unknown) {
  const v = record(value, ['issuer', 'terms', 'readiness']);
  const i = record(v.issuer, [
    'label',
    'agentId',
    'identityRegistry',
    'issuerId',
    'wallet',
    'selected',
  ]);
  if (i.selected !== true) invalid();
  const t = record(v.terms, ['policy', 'rights', 'checked'], ['blockNumber']);
  if (
    typeof t.checked !== 'boolean' ||
    (t.checked && t.blockNumber === undefined)
  )
    invalid();
  const ready = readiness(v.readiness);
  if (ready.canStart && !t.checked) invalid();
  return Object.freeze({
    issuer: Object.freeze({
      label: text(i.label, 120),
      agentId: decimal(i.agentId),
      identityRegistry: address(i.identityRegistry),
      issuerId: hash(i.issuerId),
      wallet: address(i.wallet),
      selected: true as const,
    }),
    terms: Object.freeze({
      policy: term(t.policy),
      rights: term(t.rights),
      checked: t.checked,
      blockNumber:
        t.blockNumber === undefined ? undefined : decimal(t.blockNumber),
    }),
    readiness: ready,
  });
}
export type DocumentConfiguration = ReturnType<typeof configuration>;
function document(value: unknown) {
  const v = record(value, [
    'documentId',
    'document',
    'issuer',
    'terms',
    'readiness',
  ]);
  const c = configuration({
    issuer: v.issuer,
    terms: v.terms,
    readiness: v.readiness,
  });
  const d = record(v.document, [
    'name',
    'amountMilligrams',
    'recipient',
    'issuerId',
    'sourceId',
    'sourceSignerFingerprint',
    'profile',
    'sha256',
  ]);
  if (d.profile !== 'ultratokenizer-synthetic-gold-v2') invalid();
  const amount = decimal(d.amountMilligrams, true);
  const issuerId = hash(d.issuerId);
  if (BigInt(amount) > 9223372036854775807n || issuerId !== c.issuer.issuerId)
    invalid();
  return Object.freeze({
    ...c,
    documentId: identifier(v.documentId),
    document: Object.freeze({
      name: text(d.name, 120),
      amountMilligrams: amount,
      recipient: address(d.recipient),
      issuerId,
      sourceId: hash(d.sourceId),
      sourceSignerFingerprint: hash(d.sourceSignerFingerprint),
      profile: 'ultratokenizer-synthetic-gold-v2' as const,
      sha256: hash(d.sha256),
    }),
  });
}
export type UploadedDocument = ReturnType<typeof document>;
export type PreparedDocumentJob = Readonly<{
  jobId: string;
  documentId: string;
  requestDigest: Hex;
  prepared: PreparedIssuanceRequest;
  status: 'awaiting_signature';
  readiness: ReturnType<typeof readiness>;
}>;
function preparedJob(
  value: unknown,
  uploaded: UploadedDocument,
  recipient: string,
): PreparedDocumentJob {
  const v = record(value, [
    'jobId',
    'documentId',
    'request',
    'requestDigest',
    'prepared',
    'status',
    'readiness',
  ]);
  let prepared: PreparedIssuanceRequest;
  try {
    prepared = parsePreparedIssuanceRequest(v.prepared);
  } catch {
    return invalid();
  }
  const r = prepared.request;
  const digest = hash(v.requestDigest);
  if (
    v.status !== 'awaiting_signature' ||
    v.documentId !== uploaded.documentId ||
    getIssuanceRequestDigest(r) !== digest ||
    getIssuanceRequestDigest(
      parsePreparedIssuanceRequest({ ...prepared, request: v.request }).request,
    ) !== digest ||
    r.recipient.toLowerCase() !== recipient.toLowerCase() ||
    r.recipient.toLowerCase() !== uploaded.document.recipient.toLowerCase() ||
    r.amount !== uploaded.document.amountMilligrams ||
    r.issuerId !== uploaded.document.issuerId ||
    prepared.sourceId !== uploaded.document.sourceId ||
    prepared.signerFingerprint !== uploaded.document.sourceSignerFingerprint ||
    prepared.policyTermsHash !== uploaded.terms.policy.hash ||
    prepared.rightsTermsHash !== uploaded.terms.rights.hash
  )
    invalid();
  return Object.freeze({
    jobId: identifier(v.jobId),
    documentId: uploaded.documentId,
    requestDigest: digest,
    prepared,
    status: 'awaiting_signature',
    readiness: readiness(v.readiness),
  });
}
const statuses = [
  'awaiting_signature',
  'blocked',
  'reserving',
  'preparing_proof',
  'staging',
  'queued',
  'proving',
  'proof_ready',
  'authorizing',
  'ready_to_mint',
  'attention_required',
] as const;
type Status = (typeof statuses)[number];
type JobBinding = Pick<
  PreparedDocumentJob,
  'jobId' | 'documentId' | 'requestDigest'
>;
/** Browser storage is untrusted; restored authority is checked again by the holder client. */
export function parseSavedDocumentJob(input: string) {
  try {
    const v = record(
      parseDuplicateFreeJson(input, MAX_BUNDLE_BYTES + 16 * 1024),
      ['jobId', 'documentId', 'prepared', 'holderSignature'],
      ['bundle', 'transactionHash', 'unknownSubmission'],
    );
    const prepared = parsePreparedIssuanceRequest(v.prepared);
    if (
      typeof v.holderSignature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(v.holderSignature)
    )
      invalid();
    const job: PreparedDocumentJob = Object.freeze({
      jobId: identifier(v.jobId),
      documentId: identifier(v.documentId),
      prepared,
      requestDigest: getIssuanceRequestDigest(prepared.request),
      status: 'awaiting_signature',
      readiness: Object.freeze({ canStart: false, blocker: 'job_conflict' }),
    });
    const bundle =
      v.bundle === undefined ? undefined : parseIssuanceBundle(v.bundle);
    if (
      bundle &&
      getIssuanceRequestDigest(bundle.request) !== job.requestDigest
    )
      invalid();
    const transactionHash =
      v.transactionHash === undefined ? undefined : hash(v.transactionHash);
    if (
      transactionHash === `0x${'00'.repeat(32)}` ||
      (v.unknownSubmission !== undefined && v.unknownSubmission !== true) ||
      ((transactionHash || v.unknownSubmission) && !bundle)
    )
      invalid();
    return Object.freeze({
      job,
      holderSignature: v.holderSignature as Hex,
      bundle,
      transactionHash,
      unknownSubmission: v.unknownSubmission === true,
    });
  } catch {
    return invalid();
  }
}
export type DocumentJobStatus = Readonly<
  JobBinding & {
    phase: 'proof' | 'issuance' | 'inspect';
    status: Status;
    detailCode: ErrorCode | null;
    bundleReady: boolean;
    canRetry: false;
    transactionHash?: Hex;
  }
>;
function jobStatus(value: unknown, job: JobBinding): DocumentJobStatus {
  const v = record(
    value,
    [
      'jobId',
      'documentId',
      'phase',
      'status',
      'detailCode',
      'requestDigest',
      'bundleReady',
      'canRetry',
    ],
    ['transactionHash'],
  );
  if (
    v.jobId !== job.jobId ||
    v.documentId !== job.documentId ||
    hash(v.requestDigest) !== job.requestDigest ||
    !['proof', 'issuance', 'inspect'].includes(String(v.phase)) ||
    !statuses.includes(v.status as Status) ||
    typeof v.bundleReady !== 'boolean' ||
    v.canRetry !== false ||
    (v.status === 'ready_to_mint') !== v.bundleReady
  )
    invalid();
  return Object.freeze({
    ...job,
    phase: v.phase as DocumentJobStatus['phase'],
    status: v.status as Status,
    detailCode: v.detailCode === null ? null : errorCode(v.detailCode),
    bundleReady: v.bundleReady,
    canRetry: false,
    ...(v.transactionHash === undefined
      ? {}
      : { transactionHash: hash(v.transactionHash) }),
  });
}
export async function validatePdf(file: File): Promise<void> {
  if (file.size > MAX_PDF_BYTES)
    throw new DocumentClientError('document_too_large');
  if (!/\.pdf$/i.test(file.name))
    throw new DocumentClientError('unsupported_document');
  // Full CMS, signed-content and source-profile checks belong to the native service.
  if (
    file.size < 14 ||
    !/^%PDF-1\.[0-9]/.test(await file.slice(0, 8).text()) ||
    !(await file.slice(-1024).text()).includes('%%EOF')
  )
    throw new DocumentClientError('invalid_document');
}

/** Every endpoint is same-origin and every result is bounded and parsed before presentation. */
export function createDocumentClient(fetcher: typeof fetch = fetch) {
  async function call(
    path: string,
    signal: AbortSignal,
    options: RequestInit = {},
    limit = RESPONSE_LIMIT,
  ): Promise<unknown> {
    try {
      const response = await fetcher(path, {
        ...options,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (
        response.redirected ||
        response.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json' ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new DocumentClientError('service_unavailable');
      }
      const reader = response.body.getReader();
      let size = 0,
        content = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > limit) invalid();
          content += decoder.decode(chunk.value, { stream: true });
        }
        content += decoder.decode();
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const value = parseDuplicateFreeJson(content, limit);
      if (!response.ok) {
        const envelope = record(value, ['error']);
        const error = record(envelope.error, ['code', 'message']);
        throw new DocumentClientError(errorCode(error.code));
      }
      return value;
    } catch (error) {
      if (error instanceof DocumentClientError) throw error;
      throw new DocumentClientError('service_unavailable');
    }
  }
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const jobPath = (job: JobBinding, endpoint = '') =>
    `/api/jobs/${identifier(job.jobId)}${endpoint}`;
  return {
    async configuration(signal: AbortSignal) {
      return configuration(await call('/api/config', signal));
    },
    async upload(file: File, signal: AbortSignal) {
      await validatePdf(file);
      return document(
        await call('/api/documents', signal, {
          method: 'POST',
          headers: { 'content-type': 'application/pdf' },
          body: file,
        }),
      );
    },
    async prepare(
      uploaded: UploadedDocument,
      recipient: string,
      signal: AbortSignal,
    ) {
      if (
        address(recipient).toLowerCase() !==
        uploaded.document.recipient.toLowerCase()
      )
        throw new DocumentClientError('wrong_account');
      return preparedJob(
        await call(
          '/api/jobs/prepare',
          signal,
          post({ documentId: uploaded.documentId, recipient }),
        ),
        uploaded,
        recipient,
      );
    },
    async start(
      job: PreparedDocumentJob,
      holderSignature: Hex,
      signal: AbortSignal,
    ) {
      return jobStatus(
        await call(jobPath(job, '/start'), signal, post({ holderSignature })),
        job,
      );
    },
    async status(job: JobBinding, signal: AbortSignal) {
      return jobStatus(await call(jobPath(job), signal), job);
    },
    async bundle(job: PreparedDocumentJob, signal: AbortSignal) {
      let bundle;
      try {
        bundle = parseIssuanceBundle(
          await call(jobPath(job, '/bundle'), signal, {}, MAX_BUNDLE_BYTES),
        );
      } catch (error) {
        if (error instanceof DocumentClientError) throw error;
        return invalid();
      }
      if (getIssuanceRequestDigest(bundle.request) !== job.requestDigest)
        invalid();
      return bundle;
    },
    async refreshPermit(
      job: PreparedDocumentJob,
      holderSignature: Hex,
      signal: AbortSignal,
    ) {
      return jobStatus(
        await call(jobPath(job, '/permit'), signal, post({ holderSignature })),
        job,
      );
    },
  };
}
