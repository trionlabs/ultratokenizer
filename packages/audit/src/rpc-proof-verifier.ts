import {
  BaseError,
  RpcRequestError,
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { parseAuditPolicy } from './schema.js';
import type { ProofVerificationAdapter } from './audit.js';

const abi = parseAbi([
  'function verifyProof(bytes32 programVKey,bytes publicValues,bytes proofBytes) view',
  'function VERSION() pure returns (string)',
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
  block?: Readonly<{ number: string; hash: Hex }>;
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
  let selectedBlock: Readonly<{ number: string; hash: Hex }> | undefined;
  if (options.block !== undefined) {
    const input = options.block;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== 2
    )
      throw new Error('Unsupported verifier block reference.');
    const fields = Object.getOwnPropertyDescriptors(input);
    const number: unknown = fields.number?.value;
    const hash: unknown = fields.hash?.value;
    if (
      typeof number !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,77})$/.test(number) ||
      BigInt(number) >= 1n << 256n ||
      typeof hash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
      /^0x0+$/.test(hash)
    )
      throw new Error('Unsupported verifier block reference.');
    selectedBlock = Object.freeze({ number, hash: hash as Hex });
  }
  const client = createPublicClient({
    transport: http(url.toString(), {
      timeout: 10_000,
      retryCount: 0,
      maxResponseBodySize: 256 * 1024,
      fetchOptions: { redirect: 'error', credentials: 'omit' },
    }),
    cacheTime: 0,
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
      const block = await client.getBlock(
        selectedBlock ? { blockNumber: BigInt(selectedBlock.number) } : {},
      );
      const blockNumber = block.number;
      if (
        typeof blockNumber !== 'bigint' ||
        blockNumber < 0n ||
        typeof block.hash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
        /^0x0+$/.test(block.hash) ||
        (selectedBlock &&
          (blockNumber !== BigInt(selectedBlock.number) ||
            block.hash.toLowerCase() !== selectedBlock.hash.toLowerCase()))
      )
        throw new Error('Verifier block is unresolved.');
      const code = await client.getCode({
        address: policy.verifierAddress,
        blockNumber,
      });
      if (!code || code === '0x' || keccak256(code) !== policy.verifierCodeHash)
        throw new Error('Verifier runtime differs from the approved code.');
      const version = await client.readContract({
        address: policy.verifierAddress,
        abi,
        functionName: 'VERSION',
        blockNumber,
      });
      if (version !== policy.outerVersion)
        throw new Error('Verifier version differs from the approved metadata.');
      let valid = true;
      try {
        const result = await client.request({
          method: 'eth_call',
          params: [
            {
              to: policy.verifierAddress,
              data: encodeFunctionData({
                abi,
                functionName: 'verifyProof',
                args: [input.programVKey, input.publicValues, input.proofBytes],
              }),
            },
            toHex(blockNumber),
          ],
        });
        // A void-return decoder accepts absent data too. Require the actual EVM
        // empty return value before exporting a completed verification result.
        if (result !== '0x') throw new Error('Malformed verifier RPC result.');
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
        canonical.number !== blockNumber ||
        canonical.hash !== block.hash ||
        BigInt(chainId) !== BigInt(policy.chainId)
      )
        throw new Error('Verifier chain view changed during the check.');
      return Object.freeze({
        format: 'ultratokenizer.rpc-proof-observation.v1' as const,
        chainId: policy.chainId,
        blockNumber: String(blockNumber),
        blockHash: block.hash,
        verifierAddress: policy.verifierAddress,
        verifierCodeHash: keccak256(code),
        outerVersion: version,
        programVKey: input.programVKey,
        publicValuesHash: keccak256(input.publicValues),
        proofBytesHash: keccak256(input.proofBytes),
        method: 'verifyProof(bytes32,bytes,bytes)' as const,
        result: valid ? ('returned' as const) : ('reverted' as const),
        assurance: 'trusted-rpc' as const,
        rpcOrigin: url.origin,
      });
    },
  });
}
