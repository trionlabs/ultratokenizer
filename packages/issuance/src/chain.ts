import {
  BaseError,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  getAddress,
  zeroAddress,
  keccak256,
  type EIP1193Provider,
  type Hex,
  type Address,
} from 'viem';
import { isExplicitRpcRevert } from '../../audit/src/rpc-proof-verifier.js';
import { ISSUANCE_GATE_ABI, SP1_VERIFIER_ABI } from './abi.js';
import { AtsBackendError, verifyAtsBackend } from './ats.js';
import {
  parseDeploymentConfig,
  assertProofDeployment,
  IssuanceClientError,
  nonzeroHash,
  DEPLOYMENT_V2_FORMAT,
  type ClaimProof,
} from './schema.js';

/** Shared wallet, pinned-chain and canonical-receipt boundary for holders and institutions. */
export function createChainContext(input: {
  provider: EIP1193Provider;
  deployment: unknown;
}) {
  const deployment = parseDeploymentConfig(input.deployment);
  const policy = deployment.auditPolicy;
  const ats =
    deployment.format === DEPLOYMENT_V2_FORMAT &&
    deployment.backend.kind === 'ats'
      ? deployment.backend
      : undefined;
  const chainId = Number(policy.chainId);
  if (!Number.isSafeInteger(chainId))
    throw new IssuanceClientError('invalid_deployment');
  const chain = defineChain({
    id: chainId,
    name: chainId === 296 ? 'Hedera Testnet' : 'Configured test chain',
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
    rpcUrls: { default: { http: [deployment.rpcUrl] } },
  });
  const reader = createPublicClient({
    chain,
    transport: http(deployment.rpcUrl, { timeout: 10_000, retryCount: 0 }),
  });
  const wallet = createWalletClient({
    chain,
    transport: custom(input.provider, { retryCount: 0 }),
  });

  async function deploymentMatches(blockNumber?: bigint) {
    const [rpcChain, walletChain] = await Promise.all([
      reader.getChainId(),
      wallet.getChainId(),
    ]);
    if (rpcChain !== chainId || walletChain !== chainId)
      throw new IssuanceClientError('wrong_chain');
    // ATS code, graph and state must share one canonical block. Legacy HTS
    // retains its original preflight behavior and has no ATS admission record.
    const block = ats ? await reader.getBlock({ blockNumber }) : undefined;
    if (block && (typeof block.number !== 'bigint' || !block.hash))
      throw new IssuanceClientError('transaction_uncertain');
    const at = block?.number ?? blockNumber;
    const [gateCode, verifierCode] = await Promise.all([
      reader.getCode({ address: policy.gate, blockNumber: at }),
      reader.getCode({ address: policy.verifierAddress, blockNumber: at }),
    ]);
    if (
      !gateCode ||
      !verifierCode ||
      gateCode === '0x' ||
      verifierCode === '0x' ||
      keccak256(gateCode) !== deployment.gateCodeHash ||
      keccak256(verifierCode) !== policy.verifierCodeHash
    )
      throw new IssuanceClientError('deployment_mismatch');
    if (ats && block) {
      try {
        const [rights] = await Promise.all([
          reader.readContract({
            address: policy.gate,
            abi: ISSUANCE_GATE_ABI,
            functionName: 'rights',
            args: [policy.issuerId, BigInt(policy.rightsVersion)],
            blockNumber: block.number,
          }),
          verifyAtsBackend(reader, ats, {
            token: policy.token,
            gate: policy.gate,
            blockNumber: block.number,
          }),
        ]);
        // Revocation stops new issuance in verifyEvidence and at the Gate. It
        // does not freeze already-issued tokens or change this immutable binding.
        if (
          getAddress(rights[0]) !== policy.token ||
          getAddress(rights[1]) !== ats.adapter.address ||
          rights[2] !== ats.adapter.codeHash
        )
          throw new IssuanceClientError('deployment_mismatch');
      } catch (error) {
        if (error instanceof IssuanceClientError) throw error;
        if (error instanceof AtsBackendError && error.code !== 'unavailable')
          throw new IssuanceClientError('deployment_mismatch');
        throw new IssuanceClientError('transaction_uncertain');
      }
      await assertCanonical(block);
    }
    return block;
  }
  async function activeAccount(expected?: Address) {
    await deploymentMatches();
    const addresses = await wallet.getAddresses();
    const account = addresses[0];
    if (!account || (expected && getAddress(account) !== getAddress(expected)))
      throw new IssuanceClientError('wrong_account');
    return account;
  }
  async function canonicalReceipt(transactionHash: Hex) {
    const hash = nonzeroHash(transactionHash);
    try {
      if ((await reader.getChainId()) !== chainId)
        throw new IssuanceClientError('wrong_chain');
      const observed = await reader.waitForTransactionReceipt({
        hash,
        confirmations: deployment.confirmations,
        timeout: 120_000,
      });
      // A repriced/replaced/cancelled transaction is not silently substituted for the supplied hash.
      if (observed.transactionHash !== hash)
        throw new IssuanceClientError('transaction_uncertain');
      const receipt = await reader.getTransactionReceipt({ hash });
      if (
        receipt.transactionHash !== hash ||
        receipt.blockHash !== observed.blockHash ||
        receipt.blockNumber !== observed.blockNumber
      )
        throw new IssuanceClientError('transaction_uncertain');
      const [block, head, rpcChain] = await Promise.all([
        reader.getBlock({ blockNumber: receipt.blockNumber }),
        reader.getBlockNumber({ cacheTime: 0 }),
        reader.getChainId(),
      ]);
      if (
        rpcChain !== chainId ||
        block.hash !== receipt.blockHash ||
        head < receipt.blockNumber + BigInt(deployment.confirmations) - 1n
      )
        throw new IssuanceClientError('transaction_uncertain');
      return receipt;
    } catch (error) {
      if (error instanceof IssuanceClientError) throw error;
      throw new IssuanceClientError('transaction_uncertain');
    }
  }

  async function send(operation: () => Promise<Hex>): Promise<Hex> {
    try {
      return nonzeroHash(await operation());
    } catch (error) {
      if (
        error instanceof BaseError &&
        error.walk(
          (cause) => cause instanceof UserRejectedRequestError,
        ) instanceof UserRejectedRequestError
      )
        throw error;
      // A transport error after prompting the wallet cannot establish that nothing was sent.
      throw new IssuanceClientError('transaction_uncertain');
    }
  }
  async function assertCanonical(block: { number: bigint; hash: Hex }) {
    const [canonical, rpcChain] = await Promise.all([
      reader.getBlock({ blockNumber: block.number }),
      reader.getChainId(),
    ]);
    if (canonical.hash !== block.hash || rpcChain !== chainId)
      throw new IssuanceClientError('transaction_uncertain');
  }
  async function verifyEvidence(proof: ClaimProof) {
    assertProofDeployment(proof, deployment);
    const checkedBlock = await deploymentMatches();
    const block = checkedBlock ?? (await reader.getBlock());
    if (
      typeof block.number !== 'bigint' ||
      typeof block.hash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
    )
      throw new IssuanceClientError('transaction_uncertain');
    const blockNumber = block.number;
    if (!checkedBlock) await deploymentMatches(blockNumber);
    const [issuer, selected, rights, paused, pool] = await Promise.all([
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'issuerKeys',
        args: [policy.issuerId, BigInt(policy.issuerKeyVersion)],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'policies',
        args: [policy.issuerId, BigInt(policy.policyVersion)],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'rights',
        args: [policy.issuerId, BigInt(policy.rightsVersion)],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'paused',
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'backingPools',
        args: [policy.issuerId, policy.token],
        blockNumber,
      }),
    ]);
    if (
      block.timestamp >= BigInt(proof.request.validUntil) ||
      block.timestamp >= issuer[1]
    )
      throw new IssuanceClientError('expired');
    if (
      paused ||
      issuer[2] ||
      getAddress(issuer[0]) !== policy.issuerAddress ||
      selected[4] ||
      selected[0] === 0n ||
      selected[1] !== policy.sourceId ||
      rights[4] ||
      getAddress(rights[0]) !== policy.token ||
      rights[1] === zeroAddress
    )
      throw new IssuanceClientError('deployment_mismatch');
    const [program, source, adapterCode] = await Promise.all([
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'programs',
        args: [selected[0]],
        blockNumber,
      }),
      reader.readContract({
        address: policy.gate,
        abi: ISSUANCE_GATE_ABI,
        functionName: 'sourceKeys',
        args: [selected[1], selected[2]],
        blockNumber,
      }),
      reader.getCode({ address: rights[1], blockNumber }),
    ]);
    if (
      program[4] ||
      getAddress(program[0]) !== policy.verifierAddress ||
      program[1] !== policy.verifierCodeHash ||
      program[2] !== policy.programVKey ||
      String(program[3]) !== policy.profileVersion ||
      source[1] ||
      source[0] !== policy.sourceSignerFingerprint ||
      !adapterCode ||
      adapterCode === '0x' ||
      keccak256(adapterCode) !== rights[2]
    )
      throw new IssuanceClientError('deployment_mismatch');
    let rejected = false;
    try {
      await reader.readContract({
        address: policy.verifierAddress,
        abi: SP1_VERIFIER_ABI,
        functionName: 'verifyProof',
        args: [proof.programVKey, proof.publicValues, proof.proofBytes],
        blockNumber,
      });
    } catch (error) {
      if (!isExplicitRpcRevert(error))
        throw new IssuanceClientError('transaction_uncertain');
      rejected = true;
    }
    await assertCanonical(block);
    if (rejected) throw new IssuanceClientError('invalid_proof');
    return { block, issuer, pool };
  }

  return {
    deployment,
    policy,
    chainId,
    reader,
    wallet,
    deploymentMatches,
    activeAccount,
    canonicalReceipt,
    send,
    verifyEvidence,
    assertCanonical,
  };
}
