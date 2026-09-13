import { getAddress, verifyTypedData } from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  parseIssuanceRequest,
} from '../../../dist/domain/src/index.js';
import { join } from 'node:path';
import {
  check,
  exact,
  randomId,
  sha256,
  ServiceError,
  writeNew,
} from './io.mjs';

export const MAX_PDF_BYTES = 256 * 1024;
const ACTIVE = new Set([
  'reserving',
  'preparing_proof',
  'staging',
  'queued',
  'proving',
  'proof_ready',
  'authorizing',
]);

/** Durable document-to-bundle orchestration; wallet minting stays in the browser. */
export class DemoService {
  constructor(runtime, store, now = () => Math.floor(Date.now() / 1000)) {
    this.runtime = runtime;
    this.store = store;
    this.now = now;
    this.running = new Map();
  }
  async config() {
    const config = await this.runtime.configuration();
    if (
      [...this.store.jobs.values()].some(
        (job) => job.detailCode === 'reservation_uncertain',
      )
    ) {
      return {
        ...config,
        readiness: { canStart: false, blocker: 'reservation_uncertain' },
      };
    }
    if (
      this.running.size > 0 ||
      [...this.store.jobs.values()].some(
        (job) => job.holderSignature && !job.proof,
      )
    ) {
      return {
        ...config,
        readiness: { canStart: false, blocker: 'proof_budget_unavailable' },
      };
    }
    return config;
  }
  async document(bytes) {
    check(
      Buffer.isBuffer(bytes) &&
        bytes.length > 0 &&
        bytes.length <= MAX_PDF_BYTES,
      'document_too_large',
      413,
    );
    check(
      bytes.subarray(0, 9).equals(Buffer.from('%PDF-1.7\n')),
      'unsupported_document',
      415,
    );
    const documentId = sha256(bytes);
    const document = await this.runtime.inspect(documentId, bytes);
    return { documentId, document, ...(await this.config()) };
  }
  async prepare(input) {
    exact(input, ['documentId', 'recipient']);
    check(
      typeof input.documentId === 'string' &&
        /^[0-9a-f]{64}$/.test(input.documentId),
    );
    let recipient;
    try {
      recipient = getAddress(input.recipient);
    } catch {
      throw new ServiceError('wrong_account', 400);
    }
    return this.store.serial(async () => {
      const source = await this.runtime.source(input.documentId);
      check(recipient === source.recipient, 'wrong_account', 400);
      let job = this.store.forDocument(input.documentId);
      if (!job) {
        const request = parseIssuanceRequest(
          await this.runtime.draft(source, {
            recipient,
            requestId: `0x${randomId()}`,
            reservationId: `0x${randomId()}`,
            nonce: BigInt(`0x${randomId()}`).toString(),
            now: this.now(),
          }),
        );
        const config = await this.config();
        const requestDigest = getIssuanceRequestDigest(request);
        const prepared = {
          request,
          sourceId: source.sourceId,
          signerFingerprint: source.sourceSignerFingerprint,
          policyTermsHash: config.terms.policy.hash,
          rightsTermsHash: config.terms.rights.hash,
        };
        await this.runtime.verifyDraft(source, request);
        job = await this.store.create({
          jobId: requestDigest.slice(2),
          documentId: input.documentId,
          request,
          requestDigest,
          prepared,
          status: 'awaiting_signature',
          phase: 'proof',
          detailCode: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      check(
        job.request.recipient === recipient &&
          BigInt(job.request.validUntil) > BigInt(this.now()),
        'job_conflict',
      );
      check(
        ['awaiting_signature', 'blocked'].includes(job.status),
        'job_conflict',
        409,
      );
      if (job.status === 'blocked')
        await this.store.update(job, {
          status: 'awaiting_signature',
          detailCode: null,
        });
      return {
        jobId: job.jobId,
        documentId: job.documentId,
        request: job.request,
        requestDigest: job.requestDigest,
        prepared: job.prepared,
        status: job.status,
        readiness: (await this.config()).readiness,
      };
    });
  }
  async authenticate(job, input) {
    exact(input, ['holderSignature']);
    check(
      typeof input.holderSignature === 'string' &&
        /^0x[0-9a-fA-F]{130}$/.test(input.holderSignature),
      'invalid_signature',
      400,
    );
    let valid = false;
    try {
      valid = await verifyTypedData({
        address: job.request.recipient,
        ...getIssuanceRequestTypedData(job.request),
        signature: input.holderSignature,
      });
    } catch {
      /* fail closed */
    }
    check(valid, 'invalid_signature', 403);
    check(BigInt(job.request.validUntil) > BigInt(this.now()), 'job_conflict');
    return input.holderSignature.toLowerCase();
  }
  async start(id, input) {
    return this.store.serial(async () => {
      const job = this.store.get(id);
      const signature = await this.authenticate(job, input);
      if (
        this.running.has(id) ||
        ACTIVE.has(job.status) ||
        ['ready_to_mint', 'attention_required'].includes(job.status)
      )
        return this.status(id);
      const config = await this.config();
      if (!config.readiness.canStart) {
        await this.store.update(job, {
          status: 'blocked',
          detailCode: config.readiness.blocker,
        });
        return this.status(id);
      }
      await this.runtime.assertCredentialsReady();
      // A durable signature precedes every allocation, chain write and paid network action.
      await this.store.update(job, {
        holderSignature: signature,
        status: 'reserving',
        detailCode: null,
      });
      this.launch(job);
      return this.status(id);
    });
  }
  /** Operator-only continuation of a reviewed local preparation; no HTTP route. */
  async resumePreparedProof(id) {
    return this.store.serial(async () => {
      const job = this.store.get(id);
      await this.authenticate(job, { holderSignature: job.holderSignature });
      check(
        this.running.size === 0 &&
          job.status === 'attention_required' &&
          job.phase === 'proof' &&
          ['invalid_request', 'operations_disabled'].includes(job.detailCode) &&
          job.reservation &&
          !job.proof &&
          !job.bundle &&
          ![...this.store.jobs.values()].some(
            (other) =>
              other !== job &&
              (other.detailCode === 'reservation_uncertain' ||
                (other.holderSignature && !other.proof)),
          ),
        'proof_request_uncertain',
      );
      const folder = this.store.directory(id);
      await this.runtime.checkPreparedProofRecovery(job, folder);
      // An exclusive durable marker makes a second continuation impossible,
      // including after a process crash before staging creates its own journal.
      await writeNew(join(folder, 'prepared-proof-recovery.json'), {
        requestDigest: job.requestDigest,
        reservationTransactionHash: job.reservation.transactionHash,
        startedAt: new Date().toISOString(),
      });
      await this.store.update(job, {
        status: 'preparing_proof',
        detailCode: null,
      });
      this.launch(job, { prepared: true });
      return this.status(id);
    });
  }
  /** Operator-only observation; the existing paid request is never resubmitted. */
  async resumeSubmittedProof(id) {
    const revision = this.store.get(id).journalHash;
    return this.store.serial(async () => {
      const job = this.store.get(id);
      await this.authenticate(job, { holderSignature: job.holderSignature });
      check(
        job.journalHash === revision &&
          this.running.size === 0 &&
          job.status === 'attention_required' &&
          job.phase === 'proof' &&
          job.reservation &&
          !job.proof &&
          !job.bundle &&
          [
            'preparation_failed',
            'proof_observation_unavailable',
            'proof_request_uncertain',
            'service_unavailable',
          ].includes(job.detailCode),
        'proof_request_uncertain',
      );
      const binding = await this.runtime.checkSubmittedProofRecovery(
        job,
        this.store.directory(id),
      );
      await this.store.update(job, {
        status: 'queued',
        detailCode: null,
        observationJournalHash: binding.journalHash,
      });
      this.launch(job, { submitted: true });
      return this.status(id);
    });
  }
  launch(job, options) {
    const work = this.pipeline(job, options)
      .catch(() => {
        job.status = 'attention_required';
        job.detailCode = 'service_unavailable';
      })
      .finally(() => this.running.delete(job.jobId));
    this.running.set(job.jobId, work);
  }
  async pipeline(job, { prepared = false, submitted = false } = {}) {
    try {
      if (!submitted) {
        await this.runtime.assertOperationsEnabled();
        await this.runtime.assertCredentialsReady();
      }
      if (!submitted && !prepared) {
        const reservation = await this.runtime.reserve(
          job,
          this.store.directory(job.jobId),
        );
        await this.store.update(job, {
          reservation,
          status: 'preparing_proof',
        });
      }
      const produce = submitted
        ? this.runtime.observeSubmittedProof.bind(this.runtime)
        : this.runtime.prove.bind(this.runtime);
      const proof = await produce(
        job,
        this.store.directory(job.jobId),
        async (status, detailCode = null) => {
          check(
            [
              'preparing_proof',
              'staging',
              'queued',
              'proving',
              'proof_ready',
            ].includes(status),
            'service_unavailable',
            503,
          );
          check(
            detailCode === null ||
              detailCode === 'proof_observation_unavailable',
            'service_unavailable',
          );
          await this.store.update(job, { status, detailCode });
        },
        { prepared },
      );
      await this.store.update(job, {
        status: 'authorizing',
        phase: 'issuance',
        proof,
      });
      const bundle = await this.runtime.permit(
        job,
        this.store.directory(job.jobId),
      );
      await this.store.update(job, {
        status: 'ready_to_mint',
        phase: 'issuance',
        bundle,
        detailCode: null,
      });
    } catch (error) {
      const code =
        error instanceof ServiceError ? error.code : 'service_unavailable';
      await this.store.update(job, {
        status: 'attention_required',
        detailCode: code,
      });
    }
  }
  async status(id) {
    const job = this.store.get(id);
    if (
      job.status === 'ready_to_mint' &&
      BigInt(job.bundle.permit.validUntil) <= BigInt(this.now())
    ) {
      await this.store.update(job, {
        status: 'attention_required',
        detailCode: 'permit_expired',
      });
    }
    return {
      jobId: job.jobId,
      documentId: job.documentId,
      phase: job.phase,
      status: job.status,
      detailCode: job.detailCode ?? null,
      requestDigest: job.requestDigest,
      bundleReady: job.status === 'ready_to_mint',
      canRetry: false,
      ...(job.reservation?.transactionHash
        ? { transactionHash: job.reservation.transactionHash }
        : {}),
    };
  }
  async bundle(id) {
    const status = await this.status(id);
    check(
      status.bundleReady,
      status.detailCode === 'permit_expired'
        ? 'permit_expired'
        : 'proof_unavailable',
      status.detailCode === 'permit_expired' ? 409 : 404,
    );
    return this.store.get(id).bundle;
  }
  async refreshPermit(id, input) {
    return this.store.serial(async () => {
      const job = this.store.get(id);
      await this.authenticate(job, input);
      await this.status(id);
      if (job.status === 'ready_to_mint') return this.status(id);
      check(
        job.status === 'attention_required' &&
          [
            'permit_expired',
            'issuer_unavailable',
            'deployment_unavailable',
          ].includes(job.detailCode) &&
          job.proof &&
          job.reservation,
        'proof_unavailable',
      );
      await this.runtime.assertOperationsEnabled();
      await this.store.update(job, { status: 'authorizing', detailCode: null });
      try {
        const bundle = await this.runtime.permit(job, this.store.directory(id));
        await this.store.update(job, { status: 'ready_to_mint', bundle });
      } catch (error) {
        await this.store.update(job, {
          status: 'attention_required',
          detailCode:
            error instanceof ServiceError ? error.code : 'issuer_unavailable',
        });
      }
      return this.status(id);
    });
  }
}
