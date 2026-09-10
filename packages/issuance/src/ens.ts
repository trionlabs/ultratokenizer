import {
  createPublicClient,
  getAddress,
  http,
  toCoinType,
  zeroAddress,
} from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { rpcUrl } from './schema.js';

/** Resolve once, show the resulting EVM address, then bind that address into intent. */
export async function resolveEnsRecipient(input: {
  name: string;
  chainId: string;
  ethereumRpcUrl: string;
}) {
  if (
    !/^[1-9][0-9]{0,9}$/.test(input.chainId) ||
    BigInt(input.chainId) >= 2147483648n ||
    typeof input.name !== 'string' ||
    input.name.length > 255
  )
    throw new Error('Unsupported ENS recipient or chain.');
  const normalizedName = normalize(input.name);
  const coinType = BigInt(toCoinType(Number(input.chainId)));
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl(input.ethereumRpcUrl), {
      timeout: 10_000,
      retryCount: 0,
    }),
  });
  if ((await client.getChainId()) !== 1)
    throw new Error(
      'ENS resolution requires the configured Ethereum mainnet RPC.',
    );
  const blockNumber = await client.getBlockNumber();
  const address = await client.getEnsAddress({
    name: normalizedName,
    coinType,
    blockNumber,
    strict: true,
  });
  if (!address || getAddress(address) === zeroAddress)
    throw new Error('No compatible EVM recipient address was resolved.');
  return Object.freeze({
    normalizedName,
    address: getAddress(address),
    chainId: input.chainId,
    coinType: coinType.toString(),
    blockNumber: blockNumber.toString(),
    recordPolicy: 'chain-query-with-resolver-default-evm-fallback' as const,
  });
}
