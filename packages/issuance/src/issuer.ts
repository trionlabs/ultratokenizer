import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  zeroAddress,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuerPermitTypedData,
  parseIssuerPermit,
} from '../../domain/src/index.js';
import { ISSUANCE_GATE_ABI } from './abi.js';
import { createChainContext } from './chain.js';
import {
  BUNDLE_FORMAT,
  assertProofDeployment,
  IssuanceClientError,
  bytes,
  parseClaimProofExport,
  parseIssuanceBundle,
  type ClaimProof,
  type IssuanceBundle,
} from './schema.js';

/** Institution wallet operations. The trusted caller must first reserve the stable right in its durable ledger. */
export function createIssuerClient(input: {
  provider: EIP1193Provider;
  deployment: unknown;
}) {
  const context = createChainContext(input);
  const {
    deployment,
    policy,
    reader,
    wallet,
    activeAccount,
    verifyEvidence,
    assertCanonical,
    walletPrompt,
    preflight,
  } = context;

  function reservationArgs(proof: ClaimProof) {
    const r = proof.request;
    return [
      r.issuerId,
      BigInt(policy.issuerKeyVersion),
      r.reservationId,
      r.recipient,
      r.token,
      BigInt(r.amount),
      BigInt(r.validUntil),
      getIssuanceRequestDigest(r),
      r.claimUsageId,
    ] as const;
  }
  async function stateAt(proof: ClaimProof, blockNumber: bigint) {
    const r = proof.request;
    const [
      reservation,
      requestUsed,
      claimUsed,
      requestIdUsed,
      holderNonceUsed,
    ] = await Promise.all([
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'reservations',
        args: [r.issuerId, r.reservationId],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'usedRequests',
        args: [getIssuanceRequestDigest(r)],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'usedClaims',
        args: [r.claimUsageId],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'usedRequestIds',
        args: [r.requestId],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'usedHolderNonces',
        args: [r.recipient, BigInt(r.nonce)],
        blockNumber,
      }),
    ]);
    return {
      reservation,
      consumed: requestUsed || claimUsed || requestIdUsed || holderNonceUsed,
    };
  }
  function exactReservation(
    proof: ClaimProof,
    reservation: Awaited<ReturnType<typeof stateAt>>['reservation'],
  ) {
    const r = proof.request;
    if (
      getAddress(reservation[0]) !== r.recipient ||
      getAddress(reservation[1]) !== r.token ||
      reservation[2] !== BigInt(r.amount) ||
      reservation[4] !== BigInt(r.validUntil) ||
      reservation[6] !== getIssuanceRequestDigest(r) ||
      reservation[7] !== r.claimUsageId
    )
      throw new IssuanceClientError('reservation_mismatch');
  }
  async function liveReservation(proof: ClaimProof) {
    const snapshot = await verifyEvidence(proof);
    const state = await stateAt(proof, snapshot.block.number);
    exactReservation(proof, state.reservation);
    if (state.consumed || state.reservation[3] !== 0n)
      throw new IssuanceClientError('already_used');
    if (state.reservation[5] || state.reservation[8])
      throw new IssuanceClientError('reservation_mismatch');
    if (
      snapshot.pool[1] < BigInt(proof.request.amount) ||
      snapshot.pool[1] + snapshot.pool[2] > snapshot.pool[0]
    )
      throw new IssuanceClientError('capacity_exceeded');
    await assertCanonical(snapshot.block);
    return snapshot;
  }

  async function waitReservation(value: unknown, transactionHash: Hex) {
    const proof = parseClaimProofExport(value);
    // Reconciliation works after expiry and without a currently connected institution wallet.
    assertProofDeployment(proof, deployment);
    const receipt = await context.canonicalReceipt(transactionHash);
    const [transaction, code, state] = await Promise.all([
      reader.getTransaction({ hash: receipt.transactionHash }),
      reader.getCode({
        address: policy.gate,
        blockNumber: receipt.blockNumber,
      }),
      stateAt(proof, receipt.blockNumber),
    ]);
    await assertCanonical({
      number: receipt.blockNumber,
      hash: receipt.blockHash,
    });
    if (!code || code === '0x' || keccak256(code) !== deployment.gateCodeHash)
      throw new IssuanceClientError('deployment_mismatch');
    if (
      transaction.hash !== receipt.transactionHash ||
      transaction.blockHash !== receipt.blockHash ||
      transaction.blockNumber !== receipt.blockNumber ||
      !transaction.to ||
      !receipt.to ||
      getAddress(transaction.to) !== policy.gate ||
      getAddress(receipt.to) !== policy.gate ||
      getAddress(transaction.from) !== policy.issuerAddress ||
      getAddress(receipt.from) !== policy.issuerAddress ||
      transaction.value !== 0n ||
      transaction.input !==
        encodeFunctionData({
          abi: ISSUANCE_GATE_ABI,
          functionName: 'openReservation',
          args: reservationArgs(proof),
        })
    )
      throw new IssuanceClientError('reservation_mismatch');
    if (receipt.status !== 'success')
      throw new IssuanceClientError('transaction_reverted');
    exactReservation(proof, state.reservation);
    const r = proof.request;
    const matches = receipt.logs.filter((log) => {
      if (
        getAddress(log.address) !== policy.gate ||
        log.removed ||
        log.transactionHash !== receipt.transactionHash ||
        log.blockHash !== receipt.blockHash ||
        log.blockNumber !== receipt.blockNumber
      )
        return false;
      try {
        const { args } = decodeEventLog({
          abi: ISSUANCE_GATE_ABI,
          eventName: 'ReservationOpened',
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        return (
          args.issuerId === r.issuerId &&
          args.reservationId === r.reservationId &&
          getAddress(args.recipient) === r.recipient &&
          getAddress(args.token) === r.token &&
          args.capacity === BigInt(r.amount) &&
          args.validUntil === BigInt(r.validUntil) &&
          args.keyVersion === BigInt(policy.issuerKeyVersion) &&
          args.requestDigest === getIssuanceRequestDigest(r) &&
          args.claimUsageId === r.claimUsageId
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new IssuanceClientError('reservation_mismatch');
    return Object.freeze({
      kind: 'reservation-opened' as const,
      requestDigest: getIssuanceRequestDigest(r),
      chainId: r.chainId,
      gate: r.gate,
      reservationId: r.reservationId,
      claimUsageId: r.claimUsageId,
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: String(receipt.blockNumber),
    });
  }

  return Object.freeze({
    deployment,
    connect() {
      return preflight(async () => {
        await walletPrompt(() => wallet.requestAddresses());
        return {
          address: getAddress(await activeAccount(policy.issuerAddress)),
          chainId: policy.chainId,
        };
      });
    },
    async openReservation(value: unknown): Promise<Hex> {
      const simulated = await preflight(async () => {
        const proof = parseClaimProofExport(value);
        const { block, issuer, pool } = await verifyEvidence(proof);
        const state = await stateAt(proof, block.number);
        if (state.consumed) throw new IssuanceClientError('already_used');
        if (state.reservation[0] !== zeroAddress)
          throw new IssuanceClientError('reservation_mismatch');
        if (BigInt(proof.request.validUntil) > issuer[1])
          throw new IssuanceClientError('expired');
        if (pool[1] + pool[2] + BigInt(proof.request.amount) > pool[0])
          throw new IssuanceClientError('capacity_exceeded');
        await assertCanonical(block);
        const account = await activeAccount(policy.issuerAddress);
        const simulated = await reader.simulateContract({
          account,
          address: policy.gate,
          abi: ISSUANCE_GATE_ABI,
          functionName: 'openReservation',
          args: reservationArgs(proof),
        });
        await activeAccount(policy.issuerAddress);
        return simulated;
      });
      return context.send((sender) => sender.writeContract(simulated.request));
    },
    waitReservation,
    async signPermit(
      value: unknown,
      reservationTransactionHash: Hex,
      options: { nonce: string; validForSeconds: number },
    ): Promise<IssuanceBundle> {
      return preflight(async () => {
        if (
          !Number.isSafeInteger(options.validForSeconds) ||
          options.validForSeconds < 1 ||
          options.validForSeconds > 600
        )
          throw new IssuanceClientError('invalid_bundle');
        const proof = parseClaimProofExport(value);
        await waitReservation(value, reservationTransactionHash);
        const { block, issuer } = await liveReservation(proof);
        const expiry = [
          block.timestamp + BigInt(options.validForSeconds),
          issuer[1],
          BigInt(proof.request.validUntil),
        ].reduce((a, b) => (a < b ? a : b));
        const permit = parseIssuerPermit({
          requestDigest: getIssuanceRequestDigest(proof.request),
          issuerId: policy.issuerId,
          keyVersion: policy.issuerKeyVersion,
          nonce: options.nonce,
          validUntil: String(expiry),
        });
        const used = () =>
          reader.readContract({
            address: policy.gate,
            abi: ISSUANCE_GATE_ABI,
            functionName: 'usedPermitNonces',
            args: [
              policy.issuerId,
              BigInt(permit.keyVersion),
              BigInt(permit.nonce),
            ],
          });
        if (await used()) throw new IssuanceClientError('already_used');
        const account = await activeAccount(policy.issuerAddress);
        const typedData = getIssuerPermitTypedData(proof.request, permit);
        const signature = bytes(
          await walletPrompt(() =>
            wallet.signTypedData({ account, ...typedData }),
          ),
          65,
          65,
        );
        if (
          getAddress(
            await recoverTypedDataAddress({ ...typedData, signature }),
          ) !== policy.issuerAddress
        )
          throw new IssuanceClientError('invalid_signature');
        await activeAccount(policy.issuerAddress);
        const refreshed = await liveReservation(proof);
        if (refreshed.block.timestamp >= expiry)
          throw new IssuanceClientError('expired');
        if (await used()) throw new IssuanceClientError('already_used');
        return parseIssuanceBundle({
          format: BUNDLE_FORMAT,
          ...proof,
          permit,
          issuerSignature: signature,
        });
      }, true);
    },
  });
}
export type IssuerClient = ReturnType<typeof createIssuerClient>;
