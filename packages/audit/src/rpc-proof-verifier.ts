import {
  BaseError,
  RpcRequestError,
  createPublicClient,
  http,
  keccak256,
  parseAbi,
} from 'viem';
import { parseAuditPolicy } from './schema.js';
import type { ProofVerificationAdapter } from './audit.js';

const abi = parseAbi([
  'function verifyProof(bytes32 programVKey,bytes publicValues,bytes proofBytes) view',
]);

/** Viem also wraps generic -32603 server faults as contract reverts. Inspect the RPC cause. */
export function isExplicitRpcRevert(error: unknown): boolean {
  const cause =
    error instanceof BaseError
      ? error.walk((item) => item instanceof RpcRequestError)
      : undefined;
  return (
    cause instanceof RpcRequestError &&
    (cause.code === 3 ||
      ([-32000, -32603].includes(cause.code) &&
        /^execution reverted(?:$|[\s:])/i.test(cause.details ?? '')))
  );
}

/** Explicit online check against the caller-pinned verifier, not an offline cryptographic verifier. */
export function createRpcProofVerifier(options: {
  policy: unknown;
  rpcUrl: string;
}): ProofVerificationAdapter {
  const policy = parseAuditPolicy(options.policy);
  const url = new URL(options.rpcUrl);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('Unsupported verifier RPC configuration.');
  const client = createPublicClient({
    transport: http(url.toString(), { timeout: 10_000, retryCount: 0 }),
  });
  return Object.freeze({
    identity: Object.freeze({
      proofSystem: policy.proofSystem,
      outerVersion: policy.outerVersion,
      verifierAddress: policy.verifierAddress,
      verifierCodeHash: policy.verifierCodeHash,
    }),
    async verify(input: Parameters<ProofVerificationAdapter['verify']>[0]) {
      if (
        input.programVKey !== policy.programVKey ||
        Object.keys(policy).some(
          (key) =>
            input.policy[key as keyof typeof policy] !==
            policy[key as keyof typeof policy],
        )
      )
        throw new Error('Verifier trust configuration differs.');
      if (BigInt(await client.getChainId()) !== BigInt(policy.chainId))
        throw new Error('Verifier RPC chain differs.');
      const block = await client.getBlock();
      const blockNumber = block.number;
      if (
        typeof blockNumber !== 'bigint' ||
        typeof block.hash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
      )
        throw new Error('Verifier block is unresolved.');
      const code = await client.getCode({
        address: policy.verifierAddress,
        blockNumber,
      });
      if (!code || code === '0x' || keccak256(code) !== policy.verifierCodeHash)
        throw new Error('Verifier runtime differs from the approved code.');
      let valid = true;
      try {
        await client.readContract({
          address: policy.verifierAddress,
          abi,
          functionName: 'verifyProof',
          args: [input.programVKey, input.publicValues, input.proofBytes],
          blockNumber,
        });
      } catch (error) {
        if (!isExplicitRpcRevert(error))
          throw new Error('Verifier RPC check could not complete.');
        valid = false;
      }
      const [canonical, chainId] = await Promise.all([
        client.getBlock({ blockNumber }),
        client.getChainId(),
      ]);
      if (
        canonical.hash !== block.hash ||
        BigInt(chainId) !== BigInt(policy.chainId)
      )
        throw new Error('Verifier chain view changed during the check.');
      return valid;
    },
  });
}
