import { getAddress, type EIP1193Provider, type Hex } from 'viem';
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
const OPERATION_DEADLINE_MS = 120_000;
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
  pendingOperation?: Operation;
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
  let foreground: symbol | undefined;
  let delayed: { id: symbol; operation: Operation } | undefined;
  const listeners = new Set<(value: IssuanceSnapshot) => void>();
  function providerCode(error: unknown) {
    return error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  }
  async function observedWallet(
    currentProvider: EIP1193Provider,
    requestAccess: boolean,
  ): Promise<ConnectedWallet> {
    const addresses = await currentProvider.request({
      method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts',
    });
    if (!Array.isArray(addresses) || !addresses[0])
      throw new IssuanceClientError('wrong_account');
    const chainId = await currentProvider.request({ method: 'eth_chainId' });
    if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId))
      throw new IssuanceClientError('wrong_chain');
    return Object.freeze({
      address: getAddress(addresses[0]),
      chainId: BigInt(chainId).toString(),
    });
  }
  function update(patch: Partial<IssuanceSnapshot>) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }
  function canReplace() {
    if (
      state.busy ||
      state.pendingOperation ||
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
  function retainIssuanceHash(hash: Hex) {
    const previous = state.transaction;
    update({
      unknownSubmission: undefined,
      transaction:
        previous?.hash === hash
          ? previous
          : { hash, outcome: previous ? 'unresolved' : 'pending' },
      ...(previous && previous.hash !== hash
        ? {
            receipt: undefined,
            error:
              'The late wallet hash differs from the reconciled hash. Check the original issuance again.',
          }
        : { error: undefined }),
    });
  }
  function preserveRecoveryConflict(
    kind: 'issuance' | 'token',
    previousHash: Hex | undefined,
    candidate: Hex,
  ) {
    const transaction = state.transaction;
    const tokenTransaction = state.tokenTransaction;
    const current = kind === 'issuance' ? transaction : tokenTransaction;
    // An explicit recovery may correct an older hash, but cannot silently
    // replace a different provider hash received while its reader was pending.
    if (!current || current.hash === previousHash || current.hash === candidate)
      return false;
    const error =
      'The wallet returned a different hash while recovery was running. Reconcile the retained wallet hash before a new action.';
    if (kind === 'issuance' && transaction)
      update({
        unknownSubmission: undefined,
        transaction: { ...transaction, outcome: 'unresolved' },
        receipt: undefined,
        error,
      });
    else if (tokenTransaction)
      update({
        unknownSubmission: undefined,
        tokenTransaction: { ...tokenTransaction, outcome: 'unresolved' },
        balanceMg: undefined,
        error,
      });
    return true;
  }
  function submissionKind(operation: Operation) {
    if (operation === 'submitting') return 'issuance' as const;
    if (tokenSendStarted && operation === 'associating')
      return 'association' as const;
    if (tokenSendStarted && operation === 'transferring')
      return 'transfer' as const;
    return undefined;
  }
  async function run(
    operation: Operation,
    task: (revision: number) => Promise<void>,
  ) {
    // A deadline does not cancel the original call. Only reconciliation may
    // overlap a delayed send; it cannot start another wallet action.
    if (
      state.busy ||
      disposed ||
      (delayed &&
        !(operation === 'confirming' && submissionKind(delayed.operation)))
    )
      return;
    const id = Symbol(operation);
    foreground = id;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    update({ busy: operation, error: undefined });
    const completion = (async () => {
      try {
        await task(walletRevision);
        if (expired && !submissionKind(operation))
          update({
            error:
              'The delayed check finished. Run the checks again before a new action.',
          });
      } catch (error) {
        const kind = submissionKind(operation);
        const transaction =
          kind === 'issuance' ? state.transaction : state.tokenTransaction;
        // Reconciliation may have completed while the original provider was
        // silent. Its later error cannot erase an authenticated outcome.
        if (
          kind &&
          ['confirmed', 'reverted'].includes(transaction?.outcome ?? '')
        )
          return;
        if (
          kind &&
          error instanceof IssuanceClientError &&
          ['transaction_uncertain', 'transaction_declined'].includes(error.code)
        ) {
          update({
            unknownSubmission: kind,
            error:
              error.code === 'transaction_declined'
                ? error.message
                : 'The wallet may have sent this transaction but returned no hash. Inspect wallet activity before any retry.',
          });
        } else {
          // A delayed preflight may eventually prove that no transaction method
          // was called. Only an explicit client error can clear that ambiguity.
          const noSend =
            expired &&
            kind &&
            error instanceof IssuanceClientError &&
            [
              'issuance_preflight_unavailable',
              'token_preflight_unavailable',
              'wrong_chain',
              'wrong_account',
              'wallet_rejected',
              'stale_token_intent',
            ].includes(error.code);
          update({
            ...(noSend ? { unknownSubmission: undefined } : {}),
            error: operationError(error),
          });
        }
      } finally {
        if (operation === 'associating' || operation === 'transferring')
          tokenSendStarted = false;
        if (delayed?.id === id) {
          delayed = undefined;
          update({ pendingOperation: undefined });
        }
        if (foreground === id) {
          foreground = undefined;
          update({ busy: undefined });
        }
      }
    })();
    // Receipt reconciliation already has a bounded RPC/receipt deadline and
    // never creates a wallet transaction. Do not detach concurrent readers.
    if (operation === 'confirming') return completion;
    try {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            delayed = { id, operation };
            if (foreground === id) foreground = undefined;
            const kind = submissionKind(operation);
            update({
              busy: undefined,
              pendingOperation: operation,
              ...(kind ? { unknownSubmission: kind } : {}),
              error: kind
                ? 'The wallet call is still pending. A timeout does not cancel it. Inspect wallet activity or reconcile its hash; a new submission remains blocked.'
                : 'The check is still pending. A timeout does not cancel a wallet prompt. Wait for its response before starting another action.',
            });
            resolve();
          }, OPERATION_DEADLINE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function unchanged(revision: number) {
    // Discard late checks and never turn expired token preparation into a send.
    if (disposed || state.pendingOperation) return false;
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
    const previous = state.tokenTransaction;
    update({
      unknownSubmission: undefined,
      tokenTransaction:
        previous?.hash === hash
          ? previous
          : {
              hash,
              kind: intent.kind,
              outcome: previous ? 'unresolved' : 'pending',
            },
      ...(previous && previous.hash !== hash
        ? {
            error:
              'The late wallet hash differs from the reconciled hash. Check the original token intent again.',
            balanceMg: undefined,
          }
        : { error: undefined }),
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
      const wallet = state.wallet;
      client = undefined;
      tokenAttempted = undefined;
      resetChecks();
      update({
        deployment,
        bundle: undefined,
        wallet,
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
        const currentProvider = provider;
        if (!currentProvider) throw new IssuanceClientError('wrong_account');
        let wallet: ConnectedWallet;
        if (state.deployment) {
          try {
            wallet = await requireClient().connect();
          } catch (error) {
            if (
              error instanceof IssuanceClientError &&
              error.code === 'wrong_chain'
            ) {
              const observed = await observedWallet(currentProvider, false);
              if (provider === currentProvider && !state.pendingOperation)
                update({ wallet: observed });
            }
            throw error;
          }
        } else {
          wallet = await observedWallet(currentProvider, true);
        }
        if (provider === currentProvider && unchanged(revision))
          update({ wallet });
      });
    },
    switchToTestnet() {
      canReplace();
      return run('connecting', async () => {
        const currentProvider = provider;
        const deployment = state.deployment;
        const expected = state.wallet;
        if (
          !currentProvider ||
          deployment?.auditPolicy.chainId !== '296' ||
          !expected
        )
          throw new IssuanceClientError('wrong_chain');
        const chainId = '0x128';
        const switchChain = () =>
          currentProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId }],
          });
        try {
          await switchChain();
        } catch (error) {
          if (providerCode(error) === 4001)
            throw new IssuanceClientError('wallet_rejected');
          if (providerCode(error) !== 4902)
            throw new IssuanceClientError('wallet_network_unavailable');
          try {
            await currentProvider.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId,
                  chainName: 'Hedera Testnet',
                  nativeCurrency: {
                    name: 'HBAR',
                    symbol: 'HBAR',
                    decimals: 18,
                  },
                  rpcUrls: ['https://testnet.hashio.io/api'],
                  blockExplorerUrls: ['https://hashscan.io/testnet'],
                },
              ],
            });
            await switchChain();
          } catch (addError) {
            if (providerCode(addError) === 4001)
              throw new IssuanceClientError('wallet_rejected');
            throw new IssuanceClientError('wallet_network_unavailable');
          }
        }
        const observed = await observedWallet(currentProvider, false);
        if (observed.chainId !== '296')
          throw new IssuanceClientError('wrong_chain');
        if (observed.address !== expected.address) {
          update({ wallet: undefined });
          throw new IssuanceClientError('wrong_account');
        }
        if (provider !== currentProvider || state.deployment !== deployment)
          throw new IssuanceClientError('wrong_account');
        update({ wallet: observed });
        const verified = await requireClient().connect();
        if (verified.address !== expected.address) {
          update({ wallet: undefined });
          throw new IssuanceClientError('wrong_account');
        }
        if (provider === currentProvider && state.deployment === deployment)
          update({ wallet: verified });
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
        retainIssuanceHash(hash);
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
        const previousHash = state.transaction?.hash;
        // Keep the original reference until the captured reader authenticates this call.
        try {
          const receipt = await attempt.client.wait(
            attempt.bundle,
            attempt.signature,
            candidate,
          );
          if (preserveRecoveryConflict('issuance', previousHash, candidate))
            return;
          submitted = { ...attempt, hash: candidate };
          update({
            unknownSubmission: undefined,
            transaction: { hash: candidate, outcome: 'confirmed' },
            receipt,
          });
        } catch (error) {
          if (preserveRecoveryConflict('issuance', previousHash, candidate))
            return;
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
      if (state.busy || state.pendingOperation || !state.unknownSubmission)
        return;
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
        const previousHash = state.tokenTransaction?.hash;
        // A bad recovery hash cannot replace the original reference or intent.
        try {
          await attempt.client.waitTokenTransaction(candidate, attempt.intent);
        } catch (error) {
          if (preserveRecoveryConflict('token', previousHash, candidate))
            return;
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
        if (preserveRecoveryConflict('token', previousHash, candidate)) return;
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
