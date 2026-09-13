import type { createIssuanceSession } from './issuance-session';
import type { Hex } from 'viem';
import { getIssuanceRequestDigest } from '../../../../../packages/domain/src/index.js';
import type { IssuanceBundle } from '../issuance';
import {
  createDocumentClient,
  documentErrorMessage,
  DocumentClientError,
  parseSavedDocumentJob,
  type DocumentConfiguration,
  type UploadedDocument,
  type PreparedDocumentJob,
  type DocumentJobStatus,
} from './document-client';

type HolderSession = ReturnType<typeof createIssuanceSession>;
export type DocumentSnapshot = Readonly<{
  configuration?: DocumentConfiguration;
  document?: UploadedDocument;
  job?: PreparedDocumentJob;
  status?: DocumentJobStatus;
  statusCheckedAt?: number;
  pending?:
    | 'configuration'
    | 'upload'
    | 'preparing'
    | 'starting'
    | 'checking'
    | 'approval';
  reviewed: boolean;
  started: boolean;
  error?: string;
  errorCode?: string;
  recovery?: Readonly<{ hash?: Hex }>;
  /**
   * A saved job was found but could not be read. Work may already exist on the
   * service under it, so a separate session requires explicit acknowledgment.
   */
  unreadable: boolean;
}>;

/** A job never becomes a proof or a receipt merely because time has elapsed. */
export function createDocumentSession(
  holder: HolderSession,
  api = createDocumentClient(),
) {
  let state: DocumentSnapshot = Object.freeze({
    reviewed: false,
    started: false,
    unreadable: false,
  });
  const listeners = new Set<(value: DocumentSnapshot) => void>();
  let controller: AbortController | undefined;
  let version = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let walletKey = '';
  let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  let retainedSignature: Hex | undefined;
  let retainedBundle: IssuanceBundle | undefined;
  let retainedHash: Hex | undefined;
  let retainedUnknown = false;
  let retiring = false;
  const storageKey = 'ultratokenizer.document-job.v1';
  const unsubscribe = holder.subscribe((value) => {
    const key = `${value.wallet?.address.toLowerCase() ?? ''}/${value.wallet?.chainId ?? ''}`;
    if (walletKey !== key) {
      walletKey = key;
      update({ reviewed: false });
    }
    if (
      !retiring &&
      state.job &&
      value.bundle &&
      getIssuanceRequestDigest(value.bundle.request) === state.job.requestDigest
    ) {
      retainedBundle = value.bundle;
      if (value.transaction) retainedHash = value.transaction.hash;
      if (value.unknownSubmission === 'issuance' || value.busy === 'submitting')
        retainedUnknown = true;
      if (value.transaction) retainedUnknown = false;
      persist();
    }
  });
  function update(patch: Partial<DocumentSnapshot>) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }
  function blocked() {
    const h = holder.read();
    return !!(
      h.busy ||
      h.pendingOperation ||
      h.unknownSubmission ||
      h.transaction ||
      h.tokenTransaction?.outcome === 'pending' ||
      h.tokenTransaction?.outcome === 'unresolved'
    );
  }
  function persist() {
    if (!state.job || !retainedSignature || !state.started) return;
    try {
      storage?.setItem(
        storageKey,
        JSON.stringify({
          jobId: state.job.jobId,
          documentId: state.job.documentId,
          prepared: state.job.prepared,
          holderSignature: retainedSignature,
          ...(retainedBundle ? { bundle: retainedBundle } : {}),
          ...(retainedHash ? { transactionHash: retainedHash } : {}),
          ...(retainedUnknown ? { unknownSubmission: true } : {}),
        }),
      );
    } catch {
      /* Optional storage; the current job remains usable. */
    }
  }
  async function run(
    pending: NonNullable<DocumentSnapshot['pending']>,
    action: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (state.pending || disposed) return;
    const revision = ++version;
    const request = new AbortController();
    controller = request;
    update({
      pending,
      ...(state.unreadable ? {} : { error: undefined, errorCode: undefined }),
    });
    const current = () =>
      !disposed && revision === version && !request.signal.aborted;
    try {
      await action(request.signal, current);
    } catch (error) {
      if (current())
        update({
          error: documentErrorMessage(error),
          errorCode:
            error instanceof DocumentClientError ? error.code : undefined,
        });
    } finally {
      if (current()) update({ pending: undefined });
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (
      disposed ||
      !state.started ||
      !state.status ||
      ['blocked', 'attention_required', 'ready_to_mint'].includes(
        state.status.status,
      )
    )
      return;
    timer = setTimeout(() => {
      void checkStatus();
    }, 3_000);
  }
  async function acceptBundle(signal: AbortSignal, current: () => boolean) {
    if (!state.job) return;
    const job = state.job;
    if (!holder.read().signature || !holder.read().preparedRequest) {
      if (!retainedSignature) return;
      // Observing a running job needs no chain scan. Restore the saved approval
      // only when a returned bundle can actually be verified.
      await holder.restorePreparedRequest(job.prepared, retainedSignature);
      if (
        !current() ||
        state.job !== job ||
        holder.read().error ||
        !holder.read().signature ||
        !holder.read().preparedRequest
      )
        return;
    }
    const bundle = await api.bundle(job, signal);
    if (current() && state.job === job)
      await holder.acceptPreparedBundle(bundle);
  }
  async function checkStatus() {
    if (!state.job) return;
    const job = state.job;
    await run('checking', async (signal, current) => {
      const status = await api.status(job, signal);
      if (!current() || state.job !== job) return;
      update({ status, statusCheckedAt: Date.now() });
      if (status.bundleReady && holder.read().sourceProof !== 'accepted')
        await acceptBundle(signal, current);
    });
    // A network failure stops polling. Explicit retry only observes the existing job.
    if (!state.error) schedule();
  }
  return {
    read: () => state,
    restoreStorage(value: typeof storage) {
      storage = value;
      if (state.job) return;
      try {
        const saved = storage?.getItem(storageKey);
        if (!saved) return;
        const restored = parseSavedDocumentJob(saved);
        retainedSignature = restored.holderSignature;
        retainedBundle = restored.bundle;
        retainedHash = restored.transactionHash;
        retainedUnknown = restored.unknownSubmission;
        update({
          job: restored.job,
          started: true,
          ...(retainedHash || retainedUnknown
            ? { recovery: Object.freeze({ hash: retainedHash }) }
            : {}),
        });
      } catch {
        update({
          unreadable: true,
          error:
            'The saved request could not be opened. Removing this browser record will not cancel any work already started by the issuer.',
        });
      }
    },
    subscribe(listener: (value: DocumentSnapshot) => void) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    disclose(reviewed: boolean) {
      if (!state.pending && !blocked()) update({ reviewed });
    },
    async loadConfiguration() {
      await run('configuration', async (signal, current) => {
        const configuration = await api.configuration(signal);
        if (current()) update({ configuration });
      });
    },
    async upload(file: File) {
      if (state.started || state.unreadable || blocked()) return;
      if (state.pending === 'configuration') {
        version++;
        controller?.abort();
        update({ pending: undefined });
      }
      await run('upload', async (signal, current) => {
        holder.clearPreparedRequest();
        try {
          storage?.removeItem(storageKey);
        } catch {
          /* Optional browser storage. */
        }
        retainedSignature = undefined;
        retainedBundle = undefined;
        retainedHash = undefined;
        retainedUnknown = false;
        update({
          document: undefined,
          job: undefined,
          status: undefined,
          reviewed: false,
        });
        const document = await api.upload(file, signal);
        if (current()) update({ document, configuration: document });
      });
    },
    async verifyAndMint() {
      if (state.started || blocked() || !state.document || !state.reviewed)
        return;
      const document = state.document;
      const wallet = holder.read().wallet;
      if (
        !wallet ||
        wallet.address.toLowerCase() !==
          document.document.recipient.toLowerCase()
      ) {
        update({ error: new DocumentClientError('wrong_account').message });
        return;
      }
      await run('preparing', async (signal, current) => {
        if (
          !holder.read().deployment ||
          wallet.chainId !== holder.read().deployment?.auditPolicy.chainId
        )
          throw new DocumentClientError('deployment_unavailable');
        if (!document.terms.checked)
          throw new DocumentClientError('deployment_unavailable');
        if (!state.started && !document.readiness.canStart)
          throw new DocumentClientError(
            document.readiness.blocker ?? 'operations_disabled',
          );
        const job =
          state.job ?? (await api.prepare(document, wallet.address, signal));
        if (!current()) return;
        update({ job });
        if (!state.started && !job.readiness.canStart)
          throw new DocumentClientError(
            job.readiness.blocker ?? 'operations_disabled',
          );
        if (!current() || !state.reviewed) return;
        holder.disclose(true);
        await holder.approvePreparedRequest(job.prepared);
        const signature = holder.read().signature;
        if (!current() || !signature || holder.read().error || !state.reviewed)
          return;
        if (state.started) {
          if (state.status?.bundleReady) await acceptBundle(signal, current);
          return;
        }
        // Keep the job even if the POST response is lost. A retry reads its status;
        // it never silently sends a second reservation or proof request.
        retainedSignature = signature;
        update({ pending: 'starting', started: true });
        persist();
        const status = await api.start(job, signature, signal);
        if (current()) {
          update({ status });
          if (status.bundleReady) await acceptBundle(signal, current);
        }
      });
      if (!state.error) schedule();
    },
    checkStatus,
    async recoverSubmission(hash = state.recovery?.hash) {
      if (blocked() || !hash || !retainedBundle || !retainedSignature) return;
      await run('checking', async (_signal, current) => {
        await holder.restoreIssuedBundle(
          retainedBundle!,
          retainedSignature!,
          hash,
        );
        if (current() && holder.read().transaction)
          update({ recovery: undefined });
      });
    },
    async resume() {
      if (blocked() || !state.job || !retainedSignature) return;
      const job = state.job;
      const signature = retainedSignature;
      await run('checking', async (signal, current) => {
        const wallet = holder.read().wallet;
        let status = await api.status(job, signal);
        if (!current() || state.job !== job) return;
        update({ status, statusCheckedAt: Date.now() });
        // A running job is observed immediately. Only a start that never reached
        // the service needs its saved approval rechecked before resubmission.
        if (status.status === 'awaiting_signature') {
          if (!wallet || holder.read().wallet !== wallet)
            throw new DocumentClientError('wrong_account');
          await holder.restorePreparedRequest(job.prepared, signature);
          const approval = holder.read();
          if (!current() || !approval.signature || approval.error) return;
          if (
            approval.wallet !== wallet ||
            approval.signature !== signature ||
            approval.busy ||
            approval.pendingOperation
          )
            throw new DocumentClientError('wrong_account');
          status = await api.start(job, signature, signal);
        }
        if (current()) {
          update({ status });
          if (status.bundleReady) await acceptBundle(signal, current);
        }
      });
      if (!state.error) schedule();
    },
    /**
     * Remove only an unreadable local record, after acknowledging that issuer
     * work is not cancelled. A known signed job or wallet outcome is retained.
     */
    discard(acknowledged = false) {
      if (
        !acknowledged ||
        !state.unreadable ||
        state.job ||
        state.started ||
        state.recovery ||
        retainedSignature ||
        retainedBundle ||
        retainedHash ||
        retainedUnknown ||
        blocked() ||
        state.pending
      )
        return;
      try {
        storage?.removeItem(storageKey);
      } catch {
        update({ error: 'The browser could not remove the saved request.' });
        return;
      }
      version++;
      controller?.abort();
      clearTimeout(timer);
      holder.clearPreparedRequest();
      retainedSignature = undefined;
      retainedBundle = undefined;
      retainedHash = undefined;
      retainedUnknown = false;
      state = Object.freeze({
        reviewed: false,
        started: false,
        unreadable: false,
        configuration: state.configuration,
      });
      for (const listener of listeners) listener(state);
    },
    async refreshPermit() {
      if (blocked() || !state.job || !retainedSignature) return;
      const job = state.job,
        signature = retainedSignature,
        wallet = holder.read().wallet;
      await run('approval', async (signal, current) => {
        if (
          !wallet ||
          wallet.address.toLowerCase() !==
            job.prepared.request.recipient.toLowerCase()
        )
          throw new DocumentClientError('wrong_account');
        // A reload keeps the public approval without slow chain reads. Restore
        // it only for this explicit same-proof authorization refresh.
        if (!holder.read().signature || !holder.read().preparedRequest)
          await holder.restorePreparedRequest(job.prepared, signature);
        const approval = holder.read();
        if (!current() || state.job !== job || approval.error) return;
        if (
          approval.wallet !== wallet ||
          approval.signature !== signature ||
          !approval.preparedRequest ||
          getIssuanceRequestDigest(approval.preparedRequest.request) !==
            job.requestDigest ||
          approval.busy ||
          approval.pendingOperation
        )
          throw new DocumentClientError('wrong_account');
        const status = await api.refreshPermit(job, signature, signal);
        if (current() && state.job === job) {
          update({ status });
          if (status.bundleReady) await acceptBundle(signal, current);
        }
      });
      if (!state.error) schedule();
    },
    startAnotherDocument() {
      const h = holder.read();
      if (
        disposed ||
        state.pending ||
        !state.started ||
        !state.job ||
        h.busy ||
        h.pendingOperation ||
        h.unknownSubmission ||
        h.tokenTransaction?.outcome === 'pending' ||
        h.tokenTransaction?.outcome === 'unresolved' ||
        h.transaction?.outcome !== 'confirmed' ||
        !h.receipt ||
        h.receipt.transaction?.hash !== h.transaction.hash ||
        h.receipt.requestDigest !== state.job.requestDigest ||
        getIssuanceRequestDigest(h.receipt.request) !== state.job.requestDigest
      )
        return false;
      try {
        storage?.removeItem(storageKey);
      } catch {
        update({
          error:
            'The browser could not remove the completed request. Save its receipt and try again.',
        });
        return false;
      }
      // Holder updates must not write the completed job back during retirement.
      retiring = true;
      let cleared = false;
      try {
        cleared = holder.clearCompletedIssuance();
      } finally {
        retiring = false;
        if (!cleared) persist();
      }
      if (!cleared) return false;
      version++;
      controller?.abort();
      clearTimeout(timer);
      retainedSignature = undefined;
      retainedBundle = undefined;
      retainedHash = undefined;
      retainedUnknown = false;
      state = Object.freeze({
        configuration: state.configuration,
        reviewed: false,
        started: false,
        unreadable: false,
      });
      for (const listener of listeners) listener(state);
      return true;
    },
    dispose() {
      disposed = true;
      version++;
      controller?.abort();
      clearTimeout(timer);
      unsubscribe();
      listeners.clear();
    },
  };
}

export const documentStatusLabel: Record<DocumentJobStatus['status'], string> =
  {
    awaiting_signature: 'Awaiting your wallet approval',
    blocked: 'Verification cannot start',
    reserving: 'Reserving the document amount',
    preparing_proof: 'Preparing the signed document for proof',
    staging: 'Preparing the Succinct submission',
    queued: 'Proof request queued',
    proving: 'Generating the SP1 proof',
    proof_ready: 'Checking the returned proof',
    authorizing: 'Requesting issuer approval',
    ready_to_mint: 'Proof and issuer approval received',
    attention_required: 'This request needs attention',
  };
