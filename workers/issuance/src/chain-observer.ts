import {
  decodeEventLog,
  isAddress,
  keccak256,
  toEventSelector,
  type Hex,
} from 'viem';
import type { IssuanceRequest } from '../../../packages/domain/src/index.js';
import {
  getIssuanceRequestDigest,
  ISSUED_EVENT_ABI,
} from '../../../packages/domain/src/index.js';
import { isRecord, readJson, WorkerError } from './errors.ts';
import type { Observation } from './model.ts';

export const issuanceEvent = ISSUED_EVENT_ABI;
const issuanceTopic = toEventSelector(issuanceEvent[0]);

export type ChainConfiguration = Readonly<{
  rpcUrl: string;
  chainId: string;
  gate: string;
  codeHash: string;
  confirmations: number;
}>;

export function isHash(value: unknown): value is Hex {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(value) &&
    !/^0x0{64}$/.test(value)
  );
}

function quantity(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
  )
    throw new Error('Invalid quantity.');
  return BigInt(value);
}

export function validateChainConfiguration(config: ChainConfiguration): void {
  let url: URL;
  try {
    url = new URL(config.rpcUrl);
  } catch {
    throw new WorkerError('not_configured');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[1-9][0-9]{0,9}$/.test(config.chainId) ||
    !isAddress(config.gate, { strict: true }) ||
    /^0x0{40}$/i.test(config.gate) ||
    !isHash(config.codeHash) ||
    !Number.isSafeInteger(config.confirmations) ||
    config.confirmations < 1 ||
    config.confirmations > 32
  )
    throw new WorkerError('not_configured');
}

/** Read-only observer: validates the pinned deployment and canonical receipt, never sends funds. */
export async function observeIssuance(
  request: IssuanceRequest,
  hash: Hex,
  config: ChainConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<Observation> {
  validateChainConfiguration(config);
  if (
    request.chainId !== config.chainId ||
    request.gate.toLowerCase() !== config.gate.toLowerCase() ||
    !isHash(hash)
  )
    return { outcome: 'rejected', reason: 'gate_mismatch' };

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetcher(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
      redirect: 'manual',
    });
    if (!response.ok) throw new Error('RPC unavailable.');
    const result = await readJson(response, 512 * 1024);
    if (
      !isRecord(result) ||
      result.jsonrpc !== '2.0' ||
      result.id !== 1 ||
      Object.hasOwn(result, 'error') ||
      !Object.hasOwn(result, 'result')
    )
      throw new Error('RPC unavailable.');
    return result.result;
  }

  try {
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(config.chainId))
      return { outcome: 'pending', reason: 'rpc_unavailable' };
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt === null) return { outcome: 'pending', reason: 'not_indexed' };
    if (
      !isRecord(receipt) ||
      receipt.transactionHash !== hash ||
      !isHash(receipt.blockHash) ||
      !Array.isArray(receipt.logs)
    )
      throw new Error('Invalid receipt.');
    const blockNumber = quantity(receipt.blockNumber);
    const [block, latest, transaction, code] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
      rpc('eth_blockNumber', []),
      rpc('eth_getTransactionByHash', [hash]),
      rpc('eth_getCode', [config.gate, receipt.blockNumber]),
    ]);
    if (
      !isRecord(block) ||
      block.hash !== receipt.blockHash ||
      quantity(block.number) !== blockNumber ||
      quantity(latest) < blockNumber + BigInt(config.confirmations - 1)
    )
      return { outcome: 'pending', reason: 'not_final' };
    const anchorHash = receipt.blockHash;
    const anchorNumber = receipt.blockNumber;
    async function terminal(
      observation: Exclude<Observation, { outcome: 'pending' }>,
    ): Promise<Observation> {
      // The concurrent evidence reads may have crossed a reorganization or an
      // endpoint chain change. Neither success nor rejection is terminal until
      // the receipt's anchor is checked again after those reads have finished.
      const [canonical, chain, head] = await Promise.all([
        rpc('eth_getBlockByNumber', [anchorNumber, false]),
        rpc('eth_chainId', []),
        rpc('eth_blockNumber', []),
      ]);
      if (quantity(chain) !== BigInt(config.chainId))
        return { outcome: 'pending', reason: 'rpc_unavailable' };
      if (
        !isRecord(canonical) ||
        canonical.hash !== anchorHash ||
        quantity(canonical.number) !== blockNumber ||
        quantity(head) < blockNumber + BigInt(config.confirmations - 1)
      )
        return { outcome: 'pending', reason: 'not_final' };
      return observation;
    }
    // Relayers and contract wallets may call the gate internally. Authority comes
    // from the pinned gate's exact event, not the top-level transaction recipient.
    if (transaction === null)
      return { outcome: 'pending', reason: 'not_indexed' };
    if (
      !isRecord(transaction) ||
      !isHash(transaction.hash) ||
      !isHash(transaction.blockHash) ||
      transaction.hash !== hash ||
      typeof transaction.to !== 'string' ||
      typeof receipt.to !== 'string' ||
      !isAddress(transaction.to, { strict: true }) ||
      !isAddress(receipt.to, { strict: true })
    )
      throw new Error('Invalid transaction.');
    if (
      transaction.blockHash !== receipt.blockHash ||
      quantity(transaction.blockNumber) !== blockNumber
    )
      return { outcome: 'pending', reason: 'not_final' };
    if (transaction.to.toLowerCase() !== receipt.to.toLowerCase())
      return await terminal({ outcome: 'rejected', reason: 'gate_mismatch' });
    if (
      typeof code !== 'string' ||
      code.length > 100_002 ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)
    )
      throw new Error('Invalid runtime code.');
    if (keccak256(code as Hex).toLowerCase() !== config.codeHash.toLowerCase())
      return await terminal({ outcome: 'rejected', reason: 'gate_mismatch' });
    if (receipt.status === '0x0')
      return await terminal({
        outcome: 'rejected',
        reason: 'transaction_reverted',
      });
    if (receipt.status !== '0x1') throw new Error('Invalid receipt status.');

    const digest = getIssuanceRequestDigest(request);
    const matches: Extract<Observation, { outcome: 'confirmed' }>[] = [];
    // The RPC response byte limit bounds this scan. A relayer may emit many
    // unrelated logs, so only Gate-address candidates need ABI validation.
    for (const log of receipt.logs) {
      if (
        !isRecord(log) ||
        typeof log.address !== 'string' ||
        !isAddress(log.address, { strict: true })
      )
        throw new Error('Incomplete receipt log.');
      if (log.address.toLowerCase() !== config.gate.toLowerCase()) continue;
      if (
        !Array.isArray(log.topics) ||
        log.topics.length === 0 ||
        log.topics.length > 4 ||
        !log.topics.every(
          (topic) =>
            typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic),
        ) ||
        typeof log.data !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
      )
        throw new Error('Incomplete gate log.');
      // Other valid Gate events may have different ABI shapes. A malformed
      // Issued candidate cannot establish that this transaction did not issue.
      if (log.topics[0]?.toLowerCase() !== issuanceTopic) continue;
      if (
        log.topics.length !== 4 ||
        log.data.length !== 642 ||
        !isHash(log.transactionHash) ||
        !isHash(log.blockHash) ||
        typeof log.removed !== 'boolean'
      )
        throw new Error('Incomplete issuance log.');
      const logBlockNumber = quantity(log.blockNumber);
      const logIndex = quantity(log.logIndex);
      if (log.removed) return { outcome: 'pending', reason: 'not_final' };
      const event = decodeEventLog({
        abi: issuanceEvent,
        data: log.data as Hex,
        topics: log.topics as [Hex, Hex, Hex, Hex],
        strict: true,
      });
      const fields = event.args;
      if (fields.requestDigest !== digest) continue;
      if (
        log.transactionHash !== hash ||
        log.blockHash !== receipt.blockHash ||
        logBlockNumber !== blockNumber ||
        fields.requestId !== request.requestId ||
        fields.claimUsageId !== request.claimUsageId ||
        fields.issuerId !== request.issuerId ||
        fields.reservationId !== request.reservationId ||
        fields.token.toLowerCase() !== request.token.toLowerCase() ||
        fields.recipient.toLowerCase() !== request.recipient.toLowerCase() ||
        fields.milligrams !== BigInt(request.amount) ||
        fields.policyVersion !== BigInt(request.policyVersion) ||
        fields.rightsVersion !== BigInt(request.rightsVersion) ||
        !isHash(fields.permitDigest) ||
        !isHash(fields.publicValuesHash) ||
        !isHash(fields.programVKey)
      )
        return await terminal({
          outcome: 'rejected',
          reason: 'issuance_mismatch',
        });
      matches.push({
        outcome: 'confirmed',
        blockNumber: blockNumber.toString(),
        blockHash: receipt.blockHash,
        logIndex: logIndex.toString(),
        permitDigest: fields.permitDigest,
        publicValuesHash: fields.publicValuesHash,
        programVKey: fields.programVKey,
      });
    }
    return await terminal(
      matches.length === 1
        ? matches[0]!
        : { outcome: 'rejected', reason: 'issuance_mismatch' },
    );
  } catch {
    return { outcome: 'pending', reason: 'rpc_unavailable' };
  }
}
