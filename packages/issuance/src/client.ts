import {
  getAddress,
  keccak256,
  decodeEventLog,
  encodeFunctionData,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import {
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  getIssuerPermitDigest,
  ISSUED_EVENT_ABI,
} from '../../domain/src/index.js';
import { createChainContext } from './chain.js';
import { createTokenOperations } from './token.js';
import {
  RECEIPT_FORMAT,
  parseIssuanceReceipt,
  type IssuanceReceipt,
} from '../../audit/src/index.js';
import { ISSUANCE_GATE_ABI, toIssueArgs } from './abi.js';
import {
  parseIssuanceBundle,
  assertBundleDeployment,
  IssuanceClientError,
  bytes,
  parseTransactionHash,
  type IssuanceBundle,
} from './schema.js';

/** Real wallet/RPC orchestration. No default accounts, contract pins, proofs or successful states. */
export function createIssuanceClient(input: {
  provider: EIP1193Provider;
  deployment: unknown;
}) {
  const context = createChainContext(input);
  const {
    deployment,
    policy,
    chainId,
    reader,
    wallet,
    deploymentMatches,
    activeAccount,
    canonicalReceipt,
    send,
    walletPrompt,
    verifyEvidence,
    assertCanonical,
  } = context;
  function bundleForDeployment(value: unknown) {
    const bundle = parseIssuanceBundle(value);
    assertBundleDeployment(bundle, deployment);
    return bundle;
  }
  async function validateBundle(value: unknown): Promise<IssuanceBundle> {
    const bundle = bundleForDeployment(value);
    const { block, issuer, pool } = await verifyEvidence(bundle);
    const blockNumber = block.number;
    const reservation = await reader.readContract({
      address: policy.gate,
      abi: ISSUANCE_GATE_ABI,
      functionName: 'reservations',
      args: [policy.issuerId, bundle.request.reservationId],
      blockNumber,
    });
    if (
      block.timestamp >= BigInt(bundle.permit.validUntil) ||
      BigInt(bundle.permit.validUntil) > issuer[1] ||
      block.timestamp >= reservation[4] ||
      BigInt(bundle.request.validUntil) > reservation[4]
    )
      throw new IssuanceClientError('expired');
    if (
      getAddress(reservation[0]) !== bundle.request.recipient ||
      getAddress(reservation[1]) !== policy.token ||
      reservation[2] !== BigInt(bundle.request.amount) ||
      reservation[3] !== 0n ||
      reservation[5] ||
      reservation[6] !== getIssuanceRequestDigest(bundle.request) ||
      reservation[7] !== bundle.request.claimUsageId ||
      reservation[8] ||
      pool[1] < reservation[2] ||
      pool[1] + pool[2] > pool[0]
    )
      throw new IssuanceClientError('deployment_mismatch');
    if (
      !(await reader.verifyHash({
        address: policy.issuerAddress,
        hash: getIssuerPermitDigest(bundle.request, bundle.permit),
        signature: bundle.issuerSignature,
        blockNumber,
      }))
    )
      throw new IssuanceClientError('invalid_signature');
    await assertCanonical(block);
    return bundle;
  }
  async function checkedSignature(
    bundle: IssuanceBundle,
    value: Hex,
  ): Promise<Hex> {
    const signature = bytes(value, 65, 65);
    if (
      !(await reader.verifyHash({
        address: bundle.request.recipient,
        hash: getIssuanceRequestDigest(bundle.request),
        signature,
      }))
    )
      throw new IssuanceClientError('invalid_signature');
    return signature;
  }
  async function simulation(value: unknown, holderSignature: Hex) {
    const bundle = await validateBundle(value);
    const account = await activeAccount(bundle.request.recipient);
    const signature = await checkedSignature(bundle, holderSignature);
    const simulated = await reader.simulateContract({
      account,
      address: policy.gate,
      abi: ISSUANCE_GATE_ABI,
      functionName: 'issue',
      args: toIssueArgs(bundle, signature),
    });
    if (simulated.result !== getIssuanceRequestDigest(bundle.request))
      throw new IssuanceClientError('issuance_mismatch');
    return simulated;
  }

  return Object.freeze({
    deployment,
    async connect() {
      const [address] = await walletPrompt(() => wallet.requestAddresses());
      if (!address) throw new IssuanceClientError('wrong_account');
      await deploymentMatches();
      return Object.freeze({
        address: getAddress(address),
        chainId: policy.chainId,
      });
    },
    validate: validateBundle,
    async sign(value: unknown): Promise<Hex> {
      const bundle = await validateBundle(value);
      const account = await activeAccount(bundle.request.recipient);
      const signature = await walletPrompt(() =>
        wallet.signTypedData({
          account,
          ...getIssuanceRequestTypedData(bundle.request),
        }),
      );
      const checked = await checkedSignature(bundle, signature);
      await activeAccount(bundle.request.recipient);
      return checked;
    },
    async simulate(value: unknown, holderSignature: Hex): Promise<void> {
      await simulation(value, holderSignature);
    },
    async submit(value: unknown, holderSignature: Hex): Promise<Hex> {
      let simulated;
      try {
        simulated = await simulation(value, holderSignature);
        // Recheck immediately before sending; preflight never requests a transaction.
        await activeAccount(bundleForDeployment(value).request.recipient);
      } catch (error) {
        if (
          error instanceof IssuanceClientError &&
          error.code !== 'transaction_uncertain'
        )
          throw error;
        throw new IssuanceClientError('issuance_preflight_unavailable');
      }
      return send((sender) => sender.writeContract(simulated.request));
    },
    async wait(
      value: unknown,
      holderSignature: Hex,
      transactionHash: Hex,
    ): Promise<IssuanceReceipt> {
      const bundle = bundleForDeployment(value);
      const hash = parseTransactionHash(transactionHash);
      // Historical reconciliation does not require a live permit or the currently selected wallet.
      const receipt = await canonicalReceipt(hash);
      let transaction;
      let code;
      try {
        [transaction, code] = await Promise.all([
          reader.getTransaction({ hash }),
          reader.getCode({
            address: policy.gate,
            blockNumber: receipt.blockNumber,
          }),
        ]);
        const [canonical, rpcChain] = await Promise.all([
          reader.getBlock({ blockNumber: receipt.blockNumber }),
          reader.getChainId(),
        ]);
        if (canonical.hash !== receipt.blockHash || rpcChain !== chainId)
          throw new IssuanceClientError('transaction_uncertain');
      } catch {
        throw new IssuanceClientError('transaction_uncertain');
      }
      if (!code || code === '0x' || keccak256(code) !== deployment.gateCodeHash)
        throw new IssuanceClientError('deployment_mismatch');
      if (
        transaction.hash !== hash ||
        transaction.blockHash !== receipt.blockHash ||
        transaction.blockNumber !== receipt.blockNumber ||
        !transaction.to ||
        getAddress(transaction.to) !== policy.gate ||
        !receipt.to ||
        getAddress(receipt.to) !== policy.gate ||
        transaction.value !== 0n ||
        transaction.input !==
          encodeFunctionData({
            abi: ISSUANCE_GATE_ABI,
            functionName: 'issue',
            args: toIssueArgs(bundle, holderSignature),
          })
      )
        throw new IssuanceClientError('issuance_mismatch');
      if (receipt.status !== 'success')
        throw new IssuanceClientError('transaction_reverted');
      const digest = getIssuanceRequestDigest(bundle.request);
      const expectedPermit = getIssuerPermitDigest(
        bundle.request,
        bundle.permit,
      );
      const matches = receipt.logs.filter((log) => {
        if (
          getAddress(log.address) !== policy.gate ||
          log.removed ||
          log.transactionHash !== hash ||
          log.blockHash !== receipt.blockHash ||
          log.blockNumber !== receipt.blockNumber
        )
          return false;
        try {
          const { args } = decodeEventLog({
            abi: ISSUED_EVENT_ABI,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
          return (
            args.requestDigest === digest &&
            args.requestId === bundle.request.requestId &&
            args.claimUsageId === bundle.request.claimUsageId &&
            args.issuerId === bundle.request.issuerId &&
            args.reservationId === bundle.request.reservationId &&
            getAddress(args.token) === bundle.request.token &&
            getAddress(args.recipient) === bundle.request.recipient &&
            args.milligrams === BigInt(bundle.request.amount) &&
            args.policyVersion === BigInt(bundle.request.policyVersion) &&
            args.rightsVersion === BigInt(bundle.request.rightsVersion) &&
            args.permitDigest === expectedPermit &&
            args.publicValuesHash === keccak256(bundle.publicValues) &&
            args.programVKey === bundle.programVKey
          );
        } catch {
          return false;
        }
      });
      if (matches.length !== 1)
        throw new IssuanceClientError('issuance_mismatch');
      return parseIssuanceReceipt(
        JSON.stringify({
          format: RECEIPT_FORMAT,
          request: bundle.request,
          requestDigest: digest,
          holderSignature,
          permit: bundle.permit,
          issuerSignature: bundle.issuerSignature,
          publicValues: bundle.publicValues,
          proofBytes: bundle.proofBytes,
          programVKey: bundle.programVKey,
          transaction: { chainId: policy.chainId, hash },
        }),
      );
    },
    ...createTokenOperations(context),
  });
}
export type IssuanceClient = ReturnType<typeof createIssuanceClient>;
