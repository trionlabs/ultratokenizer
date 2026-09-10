import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { ERC20_TOKEN_ABI, HTS_TOKEN_ABI } from './abi.js';
import { type createChainContext } from './chain.js';
import { getTokenBackend, IssuanceClientError, nonzeroHash } from './schema.js';

export type TokenOperation =
  | Readonly<{ kind: 'association' }>
  | Readonly<{ kind: 'transfer'; recipient: string; milligrams: string }>;
export type TokenTransactionIntent = Readonly<{
  format: 'ultratokenizer.token-intent.v1';
  chainId: string;
  token: Address;
  account: Address;
  nonce: string;
}> &
  TokenOperation;

function record(input: unknown, fields: readonly string[]) {
  if (
    !input ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== fields.length ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(input, key)!),
    )
  )
    throw new IssuanceClientError('invalid_token_intent');
  return input as Record<string, unknown>;
}
function address(value: unknown): Address {
  if (
    typeof value !== 'string' ||
    !isAddress(value, { strict: true }) ||
    getAddress(value) === zeroAddress
  )
    throw new IssuanceClientError('invalid_token_intent');
  return getAddress(value);
}
function operation(input: unknown): TokenOperation {
  const kind =
    input && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'kind')?.value
      : undefined;
  const data = record(
    input,
    kind === 'transfer' ? ['kind', 'recipient', 'milligrams'] : ['kind'],
  );
  if (kind === 'association') return Object.freeze({ kind });
  if (
    kind !== 'transfer' ||
    typeof data.milligrams !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(data.milligrams) ||
    BigInt(data.milligrams) > 9223372036854775807n
  )
    throw new IssuanceClientError('invalid_transfer');
  return Object.freeze({
    kind,
    recipient: address(data.recipient),
    milligrams: data.milligrams,
  });
}
export function parseTokenTransactionIntent(
  input: unknown,
): TokenTransactionIntent {
  const kind =
    input && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'kind')?.value
      : undefined;
  const data = record(input, [
    'format',
    'chainId',
    'token',
    'account',
    'nonce',
    'kind',
    ...(kind === 'transfer' ? ['recipient', 'milligrams'] : []),
  ]);
  if (
    data.format !== 'ultratokenizer.token-intent.v1' ||
    typeof data.chainId !== 'string' ||
    !/^[1-9][0-9]{0,9}$/.test(data.chainId) ||
    typeof data.nonce !== 'string' ||
    !/^(0|[1-9][0-9]{0,15})$/.test(data.nonce) ||
    BigInt(data.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new IssuanceClientError('invalid_token_intent');
  return Object.freeze({
    format: data.format,
    chainId: data.chainId,
    token: address(data.token),
    account: address(data.account),
    nonce: data.nonce,
    ...operation(
      kind === 'transfer'
        ? { kind, recipient: data.recipient, milligrams: data.milligrams }
        : { kind },
    ),
  });
}

/** Keeps signed transaction identity separate from wallet state and current mint authority. */
export function createTokenOperations(
  context: ReturnType<typeof createChainContext>,
) {
  const {
    deployment,
    policy,
    reader,
    wallet,
    activeAccount,
    canonicalReceipt,
    assertCanonical,
    send,
  } = context;
  const ats =
    deployment.format === 'ultratokenizer.deployment.v2' &&
    deployment.backend.kind === 'ats'
      ? deployment.backend
      : undefined;
  function supported(op: TokenOperation) {
    if (op.kind === 'association' && getTokenBackend(deployment) !== 'hts')
      throw new IssuanceClientError('unsupported_operation');
  }
  function bound(value: unknown) {
    const intent = parseTokenTransactionIntent(value);
    if (intent.chainId !== policy.chainId || intent.token !== policy.token)
      throw new IssuanceClientError('invalid_token_intent');
    supported(intent);
    return intent;
  }
  async function prepareTokenTransaction(
    value: TokenOperation,
    expectedAccount?: Address,
  ): Promise<TokenTransactionIntent> {
    const op = operation(value);
    supported(op);
    const account = await activeAccount(expectedAccount);
    const nonce = await reader.getTransactionCount({
      address: account,
      blockTag: 'pending',
    });
    if (!Number.isSafeInteger(nonce) || nonce < 0)
      throw new IssuanceClientError('transaction_uncertain');
    return parseTokenTransactionIntent({
      format: 'ultratokenizer.token-intent.v1',
      chainId: policy.chainId,
      token: policy.token,
      account,
      nonce: String(nonce),
      ...op,
    });
  }
  async function freshAccount(intent: TokenTransactionIntent) {
    const account = await activeAccount(intent.account);
    const nonce = Number(intent.nonce);
    if (
      (await reader.getTransactionCount({
        address: account,
        blockTag: 'pending',
      })) !== nonce
    )
      throw new IssuanceClientError('stale_token_intent');
    return account;
  }
  async function submission(
    intent: TokenTransactionIntent,
  ): Promise<() => Promise<Hex>> {
    const account = await freshAccount(intent);
    const nonce = Number(intent.nonce);
    if (intent.kind === 'association') {
      const simulated = await reader.simulateContract({
        account,
        address: policy.token,
        abi: HTS_TOKEN_ABI,
        functionName: 'associate',
      });
      if (simulated.result !== 22n)
        throw new IssuanceClientError('association_failed');
      await freshAccount(intent);
      return () => wallet.writeContract({ ...simulated.request, nonce });
    }
    if (
      (await reader.readContract({
        address: policy.token,
        abi: ERC20_TOKEN_ABI,
        functionName: 'decimals',
      })) !== 3
    )
      throw new IssuanceClientError('deployment_mismatch');
    const simulated = await reader.simulateContract({
      account,
      address: policy.token,
      abi: ERC20_TOKEN_ABI,
      functionName: 'transfer',
      args: [getAddress(intent.recipient), BigInt(intent.milligrams)],
    });
    if (!simulated.result) throw new IssuanceClientError('invalid_transfer');
    await freshAccount(intent);
    return () => wallet.writeContract({ ...simulated.request, nonce });
  }
  async function sendTokenTransaction(
    value: TokenTransactionIntent,
  ): Promise<Hex> {
    const intent = bound(value);
    let submit;
    try {
      submit = await submission(intent);
    } catch (error) {
      if (
        error instanceof IssuanceClientError &&
        error.code !== 'transaction_uncertain'
      )
        throw error;
      throw new IssuanceClientError('token_preflight_unavailable');
    }
    // Only failures after the wallet operation starts can mean an unknown broadcast.
    return send(submit);
  }
  async function waitTokenTransaction(
    value: Hex,
    expected?: TokenTransactionIntent,
  ): Promise<void> {
    const hash = nonzeroHash(value);
    const intent = expected === undefined ? undefined : bound(expected);
    const receipt = await canonicalReceipt(hash);
    if (!receipt.to || getAddress(receipt.to) !== policy.token)
      throw new IssuanceClientError(
        intent ? 'token_mismatch' : 'issuance_mismatch',
      );
    // Legacy hash-only calls establish generic token inclusion, never action success.
    if (!intent) {
      if (receipt.status !== 'success')
        throw new IssuanceClientError('transaction_reverted');
      return;
    }
    let transaction;
    let tokenCode;
    try {
      [transaction, tokenCode] = await Promise.all([
        reader.getTransaction({ hash }),
        ats
          ? reader.getCode({
              address: policy.token,
              blockNumber: receipt.blockNumber,
            })
          : undefined,
      ]);
      await assertCanonical({
        number: receipt.blockNumber,
        hash: receipt.blockHash,
      });
    } catch {
      throw new IssuanceClientError('transaction_uncertain');
    }
    const data =
      intent.kind === 'association'
        ? encodeFunctionData({ abi: HTS_TOKEN_ABI, functionName: 'associate' })
        : encodeFunctionData({
            abi: ERC20_TOKEN_ABI,
            functionName: 'transfer',
            args: [getAddress(intent.recipient), BigInt(intent.milligrams)],
          });
    if (
      transaction.hash !== hash ||
      transaction.blockHash !== receipt.blockHash ||
      transaction.blockNumber !== receipt.blockNumber ||
      transaction.value !== 0n ||
      !transaction.to ||
      getAddress(transaction.to) !== policy.token ||
      getAddress(transaction.from) !== intent.account ||
      getAddress(receipt.from) !== intent.account ||
      transaction.nonce !== Number(intent.nonce) ||
      transaction.input !== data
    )
      throw new IssuanceClientError('token_mismatch');
    if (
      ats &&
      (!tokenCode ||
        tokenCode === '0x' ||
        keccak256(tokenCode) !== ats.tokenCodeHash)
    )
      throw new IssuanceClientError('deployment_mismatch');
    if (receipt.status !== 'success')
      throw new IssuanceClientError('transaction_reverted');
    if (intent.kind === 'association') {
      let associated;
      try {
        associated = await reader.readContract({
          account: intent.account,
          address: policy.token,
          abi: HTS_TOKEN_ABI,
          functionName: 'isAssociated',
          blockNumber: receipt.blockNumber,
        });
        await assertCanonical({
          number: receipt.blockNumber,
          hash: receipt.blockHash,
        });
      } catch {
        throw new IssuanceClientError('transaction_uncertain');
      }
      if (!associated) throw new IssuanceClientError('association_failed');
      return;
    }
    const transfers = receipt.logs.filter((log) => {
      if (
        getAddress(log.address) !== policy.token ||
        log.removed ||
        log.transactionHash !== hash ||
        log.blockHash !== receipt.blockHash ||
        log.blockNumber !== receipt.blockNumber
      )
        return false;
      try {
        const { args } = decodeEventLog({
          abi: ERC20_TOKEN_ABI,
          eventName: 'Transfer',
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        return (
          getAddress(args.from) === intent.account &&
          getAddress(args.to) === getAddress(intent.recipient) &&
          args.value === BigInt(intent.milligrams)
        );
      } catch {
        return false;
      }
    });
    if (transfers.length !== 1) throw new IssuanceClientError('token_mismatch');
  }
  return {
    prepareTokenTransaction,
    sendTokenTransaction,
    waitTokenTransaction,
    async associate() {
      return sendTokenTransaction(
        await prepareTokenTransaction({ kind: 'association' }),
      );
    },
    async transfer(recipient: string, milligrams: string) {
      return sendTokenTransaction(
        await prepareTokenTransaction({
          kind: 'transfer',
          recipient,
          milligrams,
        }),
      );
    },
    async balance() {
      const account = await activeAccount();
      return reader.readContract({
        address: policy.token,
        abi: ERC20_TOKEN_ABI,
        functionName: 'balanceOf',
        args: [account],
      });
    },
  };
}
