import type { EIP1193Provider, Hex } from 'viem';
import { parseBrowserRpcUrl } from '../browser-rpc';
import {
  createIssuanceClient,
  parseDeploymentConfig,
  getTokenBackend,
  parseIssuanceBundle,
  parseTransactionHash,
  assertBundleDeployment,
  IssuanceClientError,
  type IssuanceClient,
  type IssuanceBundle,
  type DeploymentConfig,
  type ConnectedWallet,
  type IssuanceReceipt,
  type TokenTransactionIntent,
} from '../issuance';

type Operation =
  | 'connecting'
  | 'checking'
  | 'signing'
  | 'simulating'
  | 'submitting'
  | 'confirming'
  | 'associating'
  | 'refreshing'
  | 'transferring';
type Outcome = 'pending' | 'confirmed' | 'unresolved' | 'reverted';
export type IssuanceSnapshot = Readonly<{
  deployment?: DeploymentConfig;
  bundle?: IssuanceBundle;
  wallet?: ConnectedWallet;
  providerAvailable: boolean;
  sourceProof: 'unchecked' | 'accepted';
  signature?: Hex;
  simulation: 'unchecked' | 'passed';
  disclosed: boolean;
  busy?: Operation;
  error?: string;
  unknownSubmission?: 'issuance' | 'association' | 'transfer';
  transaction?: Readonly<{ hash: Hex; outcome: Outcome }>;
  receipt?: IssuanceReceipt;
  balanceMg?: bigint;
  tokenIntent?: TokenTransactionIntent;
  tokenTransaction?: Readonly<{
    hash: Hex;
    kind: 'association' | 'transfer';
    outcome: Outcome;
  }>;
}>;

export function operationError(error: unknown): string {
  if (error instanceof IssuanceClientError) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 4001
  )
    return 'The wallet request was declined. No approval was recorded here.';
  return 'The operation did not complete. Check wallet activity and the configured RPC before retrying.';
}

/** Presentation state follows real client results. The client and Gate remain the authority. */
export function createIssuanceSession(
  makeClient: typeof createIssuanceClient = createIssuanceClient,
) {
  let state: IssuanceSnapshot = Object.freeze({
    providerAvailable: false,
    sourceProof: 'unchecked',
    simulation: 'unchecked',
    disclosed: false,
  });
  let provider: EIP1193Provider | undefined;
  let client: IssuanceClient | undefined;
  let walletRevision = 0;
  let disposed = false;
  let attempted:
    | { client: IssuanceClient; bundle: IssuanceBundle; signature: Hex }
    | undefined;
  let submitted:
    | {
        client: IssuanceClient;
        bundle: IssuanceBundle;
        signature: Hex;
        hash: Hex;
      }
    | undefined;
  let tokenAttempted:
    { client: IssuanceClient; intent: TokenTransactionIntent } | undefined;
  let tokenSendStarted = false;
  const listeners = new Set<(value: IssuanceSnapshot) => void>();
  function update(patch: Partial<IssuanceSnapshot>) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }
  function canReplace() {
    if (
      state.busy ||
      state.unknownSubmission ||
      state.transaction?.outcome === 'pending' ||
      state.transaction?.outcome === 'unresolved' ||
      state.tokenTransaction?.outcome === 'pending' ||
      state.tokenTransaction?.outcome === 'unresolved'
    )
      throw new Error(
        'Reconcile the pending transaction before replacing this session.',
      );
  }
  function resetChecks() {
    submitted = undefined;
    attempted = undefined;
    update({
      sourceProof: 'unchecked',
      signature: undefined,
      simulation: 'unchecked',
      disclosed: false,
      transaction: undefined,
      receipt: undefined,
      error: undefined,
      unknownSubmission: undefined,
    });
  }
  function requireClient() {
    if (!provider || !state.deployment) throw new Error();
    client ??= makeClient({ provider, deployment: state.deployment });
    return client;
  }
  function requireBundle() {
    if (!state.bundle) throw new Error();
    return state.bundle;
  }
  async function run(
    operation: Operation,
    task: (revision: number) => Promise<void>,
  ) {
    if (state.busy || disposed) return;
    update({ busy: operation, error: undefined });
    try {
      await task(walletRevision);
    } catch (error) {
      if (
        error instanceof IssuanceClientError &&
        error.code === 'transaction_uncertain' &&
        (operation === 'submitting' ||
          (tokenSendStarted &&
            ['associating', 'transferring'].includes(operation)))
      ) {
        update({
          unknownSubmission:
            operation === 'submitting'
              ? 'issuance'
              : operation === 'associating'
                ? 'association'
                : 'transfer',
          error:
            'The wallet may have sent this transaction but returned no hash. Inspect wallet activity before any retry.',
        });
      } else update({ error: operationError(error) });
    } finally {
      tokenSendStarted = false;
      update({ busy: undefined });
    }
  }
  function unchanged(revision: number) {
    if (revision === walletRevision) return true;
    update({
      error:
        'The wallet changed during this check. Connect and check the request again.',
    });
    return false;
  }
  function requireNewTokenAction() {
    if (
      !state.wallet ||
      state.unknownSubmission ||
      state.transaction?.outcome === 'pending' ||
      state.transaction?.outcome === 'unresolved' ||
      state.tokenTransaction?.outcome === 'pending' ||
      state.tokenTransaction?.outcome === 'unresolved'
    )
      throw new Error();
    return state.wallet.address;
  }
  async function sendToken(
    operation:
      | { kind: 'association' }
      | { kind: 'transfer'; recipient: string; milligrams: string },
    revision: number,
  ) {
    const account = requireNewTokenAction();
    const currentClient = requireClient();
    const intent = await currentClient.prepareTokenTransaction(
      operation,
      account,
    );
    if (!unchanged(revision)) return;
    // Preserve the complete attempted action before the wallet can broadcast it.
    tokenAttempted = { client: currentClient, intent };
    update({ tokenIntent: intent, tokenTransaction: undefined });
    tokenSendStarted = true;
    const hash = await currentClient.sendTokenTransaction(intent);
    // A wallet/provider change must never discard a returned transaction hash.
    update({
      tokenTransaction: { hash, kind: intent.kind, outcome: 'pending' },
    });
  }
  return {
    read: () => state,
    subscribe(listener: (value: IssuanceSnapshot) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    setProvider(next: EIP1193Provider | undefined) {
      if (next !== provider) {
        walletRevision++;
        update({
          wallet: undefined,
          sourceProof: 'unchecked',
          signature: undefined,
          simulation: 'unchecked',
          balanceMg: undefined,
        });
      }
      provider = next;
      client = undefined;
      update({ providerAvailable: !!next });
    },
    walletChanged() {
      walletRevision++;
      update({
        wallet: undefined,
        sourceProof: 'unchecked',
        signature: undefined,
        simulation: 'unchecked',
        balanceMg: undefined,
        error:
          'Wallet account or network changed. Reconnect before a new action; submitted transactions remain reconcilable.',
      });
    },
    loadDeployment(text: string) {
      canReplace();
      const deployment = parseDeploymentConfig(text);
      parseBrowserRpcUrl(deployment.rpcUrl);
      client = undefined;
      tokenAttempted = undefined;
      resetChecks();
      update({
        deployment,
        bundle: undefined,
        wallet: undefined,
        balanceMg: undefined,
        tokenTransaction: undefined,
        tokenIntent: undefined,
      });
    },
    loadBundle(text: string) {
      canReplace();
      const bundle = parseIssuanceBundle(text);
      if (state.deployment) assertBundleDeployment(bundle, state.deployment);
      tokenAttempted = undefined;
      resetChecks();
      update({
        bundle,
        tokenTransaction: undefined,
        tokenIntent: undefined,
        balanceMg: undefined,
      });
    },
    disclose(value: boolean) {
      if (!state.busy) update({ disclosed: value });
    },
    connect() {
      return run('connecting', async (revision) => {
        const wallet = await requireClient().connect();
        if (unchanged(revision)) update({ wallet });
      });
    },
    check() {
      return run('checking', async (revision) => {
        update({
          sourceProof: 'unchecked',
          signature: undefined,
          simulation: 'unchecked',
        });
        await requireClient().validate(requireBundle());
        if (unchanged(revision)) update({ sourceProof: 'accepted' });
      });
    },
    sign() {
      return run('signing', async (revision) => {
        if (
          !state.disclosed ||
          state.sourceProof !== 'accepted' ||
          state.transaction ||
          state.unknownSubmission
        )
          throw new Error();
        update({ signature: undefined, simulation: 'unchecked' });
        const signature = await requireClient().sign(requireBundle());
        if (unchanged(revision)) update({ signature });
      });
    },
    simulate() {
      return run('simulating', async (revision) => {
        if (!state.signature || state.transaction || state.unknownSubmission)
          throw new Error();
        update({ simulation: 'unchecked' });
        await requireClient().simulate(requireBundle(), state.signature);
        if (unchanged(revision)) update({ simulation: 'passed' });
      });
    },
    submit() {
      return run('submitting', async () => {
        if (
          !state.disclosed ||
          !state.signature ||
          state.simulation !== 'passed' ||
          state.transaction ||
          state.unknownSubmission
        )
          throw new Error();
        const currentClient = requireClient();
        const bundle = requireBundle();
        const signature = state.signature;
        attempted = { client: currentClient, bundle, signature };
        const hash = await currentClient.submit(bundle, signature);
        // Keep a real submitted hash even if the wallet changed while its dialog was open.
        submitted = { client: currentClient, bundle, signature, hash };
        update({ transaction: { hash, outcome: 'pending' } });
      });
    },
    recoverIssuanceHash(hash: string) {
      return run('confirming', async () => {
        const attempt = attempted;
        if (
          !attempt ||
          !(
            state.unknownSubmission === 'issuance' ||
            state.transaction?.outcome === 'unresolved'
          )
        )
          throw new Error(
            'Use the transaction hash from the wallet that submitted this request.',
          );
        const candidate = parseTransactionHash(hash);
        // Keep the original reference until the captured reader authenticates this call.
        try {
          const receipt = await attempt.client.wait(
            attempt.bundle,
            attempt.signature,
            candidate,
          );
          submitted = { ...attempt, hash: candidate };
          update({
            unknownSubmission: undefined,
            transaction: { hash: candidate, outcome: 'confirmed' },
            receipt,
          });
        } catch (error) {
          // Matching calldata can be replayed in another wallet attempt. Only
          // the retained submitted hash identifies this attempt's own revert.
          if (
            error instanceof IssuanceClientError &&
            error.code === 'transaction_reverted'
          ) {
            if (submitted?.hash !== candidate)
              throw new IssuanceClientError('issuance_recovery_unresolved');
            submitted = { ...attempt, hash: candidate };
            update({
              unknownSubmission: undefined,
              transaction: { hash: candidate, outcome: 'reverted' },
              receipt: undefined,
            });
          }
          throw error;
        }
      });
    },
    acknowledgeNotSent() {
      if (state.busy || !state.unknownSubmission) return;
      attempted = undefined;
      if (state.unknownSubmission !== 'issuance') tokenAttempted = undefined;
      update({
        unknownSubmission: undefined,
        sourceProof: 'unchecked',
        signature: undefined,
        simulation: 'unchecked',
        ...(state.unknownSubmission !== 'issuance'
          ? { tokenIntent: undefined, tokenTransaction: undefined }
          : {}),
        error:
          'Wallet activity was reviewed. Run the checks again before a new submission.',
      });
    },
    confirm() {
      return run('confirming', async () => {
        if (!submitted) throw new Error();
        const { client: reader, bundle, signature, hash } = submitted;
        try {
          const receipt = await reader.wait(bundle, signature, hash);
          update({ transaction: { hash, outcome: 'confirmed' }, receipt });
        } catch (error) {
          update({
            transaction: {
              hash,
              outcome:
                error instanceof IssuanceClientError &&
                error.code === 'transaction_reverted'
                  ? 'reverted'
                  : 'unresolved',
            },
          });
          throw error;
        }
      });
    },
    refreshBalance() {
      return run('refreshing', async (revision) => {
        const balanceMg = await requireClient().balance();
        if (unchanged(revision)) update({ balanceMg });
      });
    },
    associate() {
      return run('associating', async (revision) => {
        if (state.deployment && getTokenBackend(state.deployment) === 'ats')
          throw new IssuanceClientError('unsupported_operation');
        await sendToken({ kind: 'association' }, revision);
      });
    },
    transfer(recipient: string, milligrams: string) {
      return run('transferring', async (revision) => {
        await sendToken({ kind: 'transfer', recipient, milligrams }, revision);
      });
    },
    recoverTokenHash(hash: string) {
      return run('confirming', async () => {
        const attempt = tokenAttempted;
        if (
          !attempt ||
          !(
            state.unknownSubmission === attempt.intent.kind ||
            state.tokenTransaction?.outcome === 'unresolved'
          )
        )
          throw new Error(
            'Use the transaction hash from the wallet that submitted this token action.',
          );
        const candidate = parseTransactionHash(hash);
        // A bad recovery hash cannot replace the original reference or intent.
        try {
          await attempt.client.waitTokenTransaction(candidate, attempt.intent);
        } catch (error) {
          // The client reports a revert only after authenticating this intent.
          if (
            error instanceof IssuanceClientError &&
            error.code === 'transaction_reverted'
          ) {
            update({
              unknownSubmission: undefined,
              tokenTransaction: {
                hash: candidate,
                kind: attempt.intent.kind,
                outcome: 'reverted',
              },
            });
          }
          throw error;
        }
        update({
          unknownSubmission: undefined,
          tokenTransaction: {
            hash: candidate,
            kind: attempt.intent.kind,
            outcome: 'confirmed',
          },
          balanceMg: undefined,
        });
      });
    },
    confirmToken() {
      return run('confirming', async () => {
        const transaction = state.tokenTransaction;
        const attempt = tokenAttempted;
        if (!transaction || !attempt) throw new Error();
        try {
          await attempt.client.waitTokenTransaction(
            transaction.hash,
            attempt.intent,
          );
          update({
            tokenTransaction: { ...transaction, outcome: 'confirmed' },
            balanceMg: undefined,
          });
        } catch (error) {
          update({
            tokenTransaction: {
              ...transaction,
              outcome:
                error instanceof IssuanceClientError &&
                error.code === 'transaction_reverted'
                  ? 'reverted'
                  : 'unresolved',
            },
          });
          throw error;
        }
      });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
