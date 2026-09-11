import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuerPermitDigest,
  ISSUED_EVENT_ABI,
  parseIssuanceRequest,
  type IssuanceRequest,
} from '../../domain/src/index.js';
import { ISSUANCE_GATE_ABI, toIssueArgs } from '../../issuance/src/abi.js';
import {
  BUNDLE_FORMAT,
  parseIssuanceBundle,
} from '../../issuance/src/schema.js';
import type { Allocation, InstitutionLedger } from './types.js';

export type InstitutionChainPins = Readonly<{
  format: 'ultratokenizer.institution-chain.v1';
  purpose: 'test';
  chainId: '296' | '31337';
  rpcUrl: string;
  gate: Address;
  gateCodeHash: Hex;
  programVKey: Hex;
  deploymentBlockNumber: string;
  deploymentBlockHash: Hex;
  confirmations: number;
}>;

export class InstitutionChainError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unresolved'
      | 'mismatch'
      | 'terminal_conflict',
  ) {
    super(
      'The institution chain outcome could not be established; retain the allocation.',
    );
    this.name = 'InstitutionChainError';
  }
}

function requireMatch(value: unknown): asserts value {
  if (!value) throw new InstitutionChainError('mismatch');
}
function word(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    /^0x0+$/.test(value)
  )
    throw new InstitutionChainError('invalid_input');
  return value.toLowerCase() as Hex;
}
function pinsFor(value: InstitutionChainPins): InstitutionChainPins {
  try {
    const fields = [
      'format',
      'purpose',
      'chainId',
      'rpcUrl',
      'gate',
      'gateCodeHash',
      'programVKey',
      'deploymentBlockNumber',
      'deploymentBlockHash',
      'confirmations',
    ];
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      fields.some(
        (field) =>
          !('value' in (Object.getOwnPropertyDescriptor(value, field) ?? {})),
      )
    )
      throw new Error();
    const pins = { ...value };
    const url = new URL(pins.rpcUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      pins.format !== 'ultratokenizer.institution-chain.v1' ||
      pins.purpose !== 'test' ||
      !['296', '31337'].includes(pins.chainId) ||
      (url.protocol !== 'https:' &&
        !(pins.chainId === '31337' && local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.hash ||
      !/^(?:0|[1-9][0-9]{0,18})$/.test(pins.deploymentBlockNumber) ||
      !Number.isInteger(pins.confirmations) ||
      pins.confirmations < 1 ||
      pins.confirmations > 100 ||
      getAddress(pins.gate) === zeroAddress
    )
      throw new Error();
    return Object.freeze({
      ...pins,
      gate: getAddress(pins.gate),
      gateCodeHash: word(pins.gateCodeHash),
      programVKey: word(pins.programVKey),
      deploymentBlockHash: word(pins.deploymentBlockHash),
    });
  } catch {
    throw new InstitutionChainError('invalid_input');
  }
}

/**
 * Node-only accounting bridge over an independently trusted RPC endpoint.
 * Numeric block/hash checks detect inconsistent observations, not a dishonest provider.
 * No wallet, credentials, signing, transaction submission or automatic reservation release.
 */
export function createInstitutionChainBridge(input: {
  ledger: InstitutionLedger;
  pins: InstitutionChainPins;
}) {
  const pins = pinsFor(input.pins);
  const ledger = input.ledger;
  const reader = createPublicClient({
    transport: http(pins.rpcUrl, {
      timeout: 10_000,
      retryCount: 0,
      batch: false,
      maxResponseBodySize: 512 * 1024,
      fetchOptions: { redirect: 'error', credentials: 'omit' },
    }),
    cacheTime: 0,
  });
  function allocation(digest: Hex) {
    const found = ledger.getAllocation(word(digest));
    if (!found) throw new InstitutionChainError('invalid_input');
    const request = parseIssuanceRequest(found.request);
    requireMatch(
      request.chainId === pins.chainId &&
        request.gate === pins.gate &&
        getIssuanceRequestDigest(request) === found.requestDigest,
    );
    return found;
  }
  async function anchored(blockNumber: bigint, expectedHash?: Hex) {
    const [chain, head, block, deployment, code] = await Promise.all([
      reader.getChainId(),
      reader.getBlockNumber({ cacheTime: 0 }),
      reader.getBlock({ blockNumber }),
      reader.getBlock({ blockNumber: BigInt(pins.deploymentBlockNumber) }),
      reader.getCode({ address: pins.gate, blockNumber }),
    ]);
    requireMatch(
      chain === Number(pins.chainId) &&
        block.number === blockNumber &&
        blockNumber >= BigInt(pins.deploymentBlockNumber) &&
        head >= blockNumber + BigInt(pins.confirmations) - 1n &&
        deployment.number === BigInt(pins.deploymentBlockNumber) &&
        deployment.hash === pins.deploymentBlockHash &&
        code &&
        code !== '0x' &&
        keccak256(code) === pins.gateCodeHash,
    );
    const hash = word(block.hash);
    requireMatch(expectedHash === undefined || expectedHash === hash);
    return { number: blockNumber, hash, timestamp: block.timestamp };
  }
  async function state(request: IssuanceRequest, blockNumber: bigint) {
    const [reservation, requestUsed, claimUsed] = await Promise.all([
      reader.readContract({
        address: pins.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'reservations',
        args: [request.issuerId, request.reservationId],
        blockNumber,
      }),
      reader.readContract({
        address: pins.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'usedRequests',
        args: [getIssuanceRequestDigest(request)],
        blockNumber,
      }),
      reader.readContract({
        address: pins.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'usedClaims',
        args: [request.claimUsageId],
        blockNumber,
      }),
    ]);
    requireMatch(
      getAddress(reservation[0]) === request.recipient &&
        getAddress(reservation[1]) === request.token &&
        reservation[2] === BigInt(request.amount) &&
        reservation[4] >= BigInt(request.validUntil) &&
        reservation[6] === getIssuanceRequestDigest(request) &&
        reservation[7] === request.claimUsageId,
    );
    return { reservation, requestUsed, claimUsed };
  }
  async function guarded(
    run: (withinDeadline: () => void) => Promise<Allocation>,
  ) {
    const deadline = performance.now() + 120_000;
    const withinDeadline = () => {
      if (performance.now() > deadline)
        throw new InstitutionChainError('unresolved');
    };
    try {
      return await run(withinDeadline);
    } catch (error) {
      if (error instanceof InstitutionChainError) throw error;
      // Never return provider exception details, credentials, private references or source data.
      throw new InstitutionChainError('unresolved');
    }
  }
  return Object.freeze({
    settleIssued(digest: Hex, transactionHash: Hex): Promise<Allocation> {
      return guarded(async (withinDeadline) => {
        const hash = word(transactionHash);
        const current = allocation(digest);
        if (current.state !== 'pending') {
          if (
            current.observation?.kind === 'issued' &&
            current.observation.transactionHash === hash
          )
            return current;
          throw new InstitutionChainError('terminal_conflict');
        }
        const request = current.request;
        const [receipt, transaction] = await Promise.all([
          reader.getTransactionReceipt({ hash }),
          reader.getTransaction({ hash }),
        ]);
        requireMatch(
          receipt.status === 'success' &&
            receipt.transactionHash === hash &&
            transaction.hash === hash &&
            transaction.to &&
            receipt.to &&
            getAddress(transaction.to) === pins.gate &&
            getAddress(receipt.to) === pins.gate &&
            getAddress(transaction.from) === getAddress(receipt.from) &&
            transaction.value === 0n &&
            Number.isSafeInteger(transaction.nonce) &&
            transaction.nonce >= 0 &&
            Number.isSafeInteger(receipt.transactionIndex) &&
            receipt.transactionIndex >= 0 &&
            typeof receipt.blockNumber === 'bigint' &&
            receipt.blockNumber >= 0n &&
            transaction.blockHash === receipt.blockHash &&
            transaction.blockNumber === receipt.blockNumber &&
            transaction.transactionIndex === receipt.transactionIndex &&
            transaction.input.length <= 320 * 1024,
        );
        const block = await anchored(receipt.blockNumber, receipt.blockHash);
        const call = decodeFunctionData({
          abi: ISSUANCE_GATE_ABI,
          data: transaction.input,
        });
        requireMatch(call.functionName === 'issue');
        const [
          rawRequest,
          holderSignature,
          rawPermit,
          issuerSignature,
          publicValues,
          proofBytes,
        ] = call.args;
        const callRequest = parseIssuanceRequest(
          Object.fromEntries(
            Object.entries(rawRequest).map(([key, value]) => [
              key,
              typeof value === 'bigint' || typeof value === 'number'
                ? String(value)
                : value,
            ]),
          ),
        );
        requireMatch(
          getIssuanceRequestDigest(callRequest) === current.requestDigest,
        );
        const matches = receipt.logs.flatMap((log) => {
          if (
            getAddress(log.address) !== pins.gate ||
            log.removed ||
            log.transactionHash !== hash ||
            log.blockHash !== block.hash ||
            log.blockNumber !== block.number ||
            log.transactionIndex !== receipt.transactionIndex ||
            !Number.isSafeInteger(log.logIndex) ||
            log.logIndex === null ||
            log.logIndex < 0
          )
            return [];
          try {
            const decoded = decodeEventLog({
              abi: ISSUED_EVENT_ABI,
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            return decoded.args.requestDigest === current.requestDigest
              ? [decoded.args]
              : [];
          } catch {
            return [];
          }
        });
        requireMatch(matches.length === 1);
        const event = matches[0];
        requireMatch(event.programVKey === pins.programVKey);
        const bundle = parseIssuanceBundle({
          format: BUNDLE_FORMAT,
          request: callRequest,
          permit: Object.fromEntries(
            Object.entries(rawPermit).map(([key, value]) => [
              key,
              typeof value === 'bigint' ? String(value) : value,
            ]),
          ),
          issuerSignature,
          publicValues,
          proofBytes,
          programVKey: event.programVKey,
        });
        requireMatch(
          transaction.input ===
            encodeFunctionData({
              abi: ISSUANCE_GATE_ABI,
              functionName: 'issue',
              args: toIssueArgs(bundle, holderSignature),
            }) &&
            event.requestId === request.requestId &&
            event.claimUsageId === request.claimUsageId &&
            event.issuerId === request.issuerId &&
            event.reservationId === request.reservationId &&
            getAddress(event.token) === request.token &&
            getAddress(event.recipient) === request.recipient &&
            event.milligrams === BigInt(request.amount) &&
            event.policyVersion === BigInt(request.policyVersion) &&
            event.rightsVersion === BigInt(request.rightsVersion) &&
            event.permitDigest ===
              getIssuerPermitDigest(request, bundle.permit) &&
            event.publicValuesHash === keccak256(bundle.publicValues),
        );
        const [observed, requestIdUsed, holderNonceUsed, permitNonceUsed] =
          await Promise.all([
            state(request, block.number),
            reader.readContract({
              address: pins.gate,
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedRequestIds',
              args: [request.requestId],
              blockNumber: block.number,
            }),
            reader.readContract({
              address: pins.gate,
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedHolderNonces',
              args: [request.recipient, BigInt(request.nonce)],
              blockNumber: block.number,
            }),
            reader.readContract({
              address: pins.gate,
              abi: ISSUANCE_GATE_ABI,
              functionName: 'usedPermitNonces',
              args: [
                request.issuerId,
                BigInt(bundle.permit.keyVersion),
                BigInt(bundle.permit.nonce),
              ],
              blockNumber: block.number,
            }),
          ]);
        requireMatch(
          observed.reservation[3] === BigInt(request.amount) &&
            !observed.reservation[8] &&
            observed.requestUsed &&
            observed.claimUsed &&
            requestIdUsed &&
            holderNonceUsed &&
            permitNonceUsed,
        );
        await anchored(block.number, block.hash);
        withinDeadline();
        return ledger.markIssued({
          kind: 'issued',
          requestDigest: current.requestDigest,
          chainId: request.chainId,
          gate: request.gate,
          reservationId: request.reservationId,
          claimUsageId: request.claimUsageId,
          blockHash: block.hash,
          blockNumber: String(block.number),
          transactionHash: hash,
        });
      });
    },
    settleUnused(digest: Hex): Promise<Allocation> {
      return guarded(async (withinDeadline) => {
        const current = allocation(digest);
        if (current.state !== 'pending') {
          if (current.observation?.kind === 'unused') return current;
          throw new InstitutionChainError('terminal_conflict');
        }
        const request = current.request;
        const head = await reader.getBlockNumber({ cacheTime: 0 });
        const number = head - BigInt(pins.confirmations) + 1n;
        requireMatch(number >= BigInt(pins.deploymentBlockNumber));
        const block = await anchored(number);
        const observed = await state(request, number);
        requireMatch(
          observed.reservation[8] &&
            observed.reservation[3] === 0n &&
            !observed.requestUsed &&
            !observed.claimUsed &&
            (observed.reservation[5] ||
              block.timestamp >= observed.reservation[4]),
        );
        await anchored(number, block.hash);
        withinDeadline();
        return ledger.releaseUnused({
          kind: 'unused',
          requestDigest: current.requestDigest,
          chainId: request.chainId,
          gate: request.gate,
          reservationId: request.reservationId,
          claimUsageId: request.claimUsageId,
          blockHash: block.hash,
          blockNumber: String(block.number),
          reason: observed.reservation[5] ? 'revoked-unused' : 'expired-unused',
          reservationReleased: true,
          reservationUsed: '0',
          requestUsed: false,
          claimUsed: false,
        });
      });
    },
  });
}
