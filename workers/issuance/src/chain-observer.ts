import { decodeEventLog, isAddress, keccak256, type Hex } from 'viem';
import type { IssuanceRequest } from '../../../packages/domain/src/index.js';
import {
  getIssuanceRequestDigest,
  ISSUED_EVENT_ABI,
} from '../../../packages/domain/src/index.js';
import { isRecord, readJson, WorkerError } from './errors.ts';
import type { Observation } from './model.ts';

export const issuanceEvent = ISSUED_EVENT_ABI;

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
      !Array.isArray(receipt.logs) ||
      receipt.logs.length > 256
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
    // Relayers and contract wallets may call the gate internally. Authority comes
    // from the pinned gate's exact event, not the top-level transaction recipient.
    if (
      !isRecord(transaction) ||
      transaction.hash !== hash ||
      transaction.blockHash !== receipt.blockHash ||
      typeof transaction.to !== 'string' ||
      typeof receipt.to !== 'string' ||
      transaction.to.toLowerCase() !== receipt.to.toLowerCase()
    )
      return { outcome: 'rejected', reason: 'gate_mismatch' };
    if (
      typeof code !== 'string' ||
      code.length > 100_002 ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
      keccak256(code as Hex).toLowerCase() !== config.codeHash.toLowerCase()
    )
      return { outcome: 'rejected', reason: 'gate_mismatch' };
    if (receipt.status === '0x0')
      return { outcome: 'rejected', reason: 'transaction_reverted' };
    if (receipt.status !== '0x1') throw new Error('Invalid receipt status.');

    const digest = getIssuanceRequestDigest(request);
    const matches: Extract<Observation, { outcome: 'confirmed' }>[] = [];
    for (const log of receipt.logs) {
      if (
        !isRecord(log) ||
        typeof log.address !== 'string' ||
        log.address.toLowerCase() !== config.gate.toLowerCase()
      )
        continue;
      if (log.removed === true)
        return { outcome: 'pending', reason: 'not_final' };
      if (
        !Array.isArray(log.topics) ||
        log.topics.length !== 4 ||
        !log.topics.every(isHash) ||
        typeof log.data !== 'string' ||
        log.data.length !== 642 ||
        !/^0x[0-9a-fA-F]+$/.test(log.data)
      )
        continue;
      let event;
      try {
        event = decodeEventLog({
          abi: issuanceEvent,
          data: log.data as Hex,
          topics: log.topics as [Hex, Hex, Hex, Hex],
          strict: true,
        });
      } catch {
        continue;
      }
      const fields = event.args;
      if (fields.requestDigest !== digest) continue;
      if (
        log.transactionHash !== hash ||
        log.blockHash !== receipt.blockHash ||
        quantity(log.blockNumber) !== blockNumber ||
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
        return { outcome: 'rejected', reason: 'issuance_mismatch' };
      matches.push({
        outcome: 'confirmed',
        blockNumber: blockNumber.toString(),
        blockHash: receipt.blockHash,
        logIndex: quantity(log.logIndex).toString(),
        permitDigest: fields.permitDigest,
        publicValuesHash: fields.publicValuesHash,
        programVKey: fields.programVKey,
      });
    }
    return matches.length === 1
      ? matches[0]!
      : { outcome: 'rejected', reason: 'issuance_mismatch' };
  } catch {
    return { outcome: 'pending', reason: 'rpc_unavailable' };
  }
}
