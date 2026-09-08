import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiParameters,
} from 'viem';

export const gate = '0x1111111111111111111111111111111111111111';
export const hash = `0x${'ab'.repeat(32)}`;
export const blockHash = `0x${'cd'.repeat(32)}`;
export const bytecode = '0x60006000';
export const chainConfig = {
  rpcUrl: 'https://rpc.synthetic.invalid/',
  chainId: '296',
  gate,
  codeHash: keccak256(bytecode),
  confirmations: 2,
};
export const requestFixture = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/domain/fixtures/request.synthetic.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

export async function bundleModule(path) {
  const dir = await mkdtemp(join(tmpdir(), 'ultratokenizer-worker-test-'));
  const outfile = join(dir, 'module.mjs');
  await build({
    entryPoints: [new URL(path, import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  });
  return {
    module: await import(pathToFileURL(outfile).href),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function rpcFixture(request, digest, abi, mutate = () => {}) {
  const topics = encodeEventTopics({
    abi,
    eventName: 'Issued',
    args: {
      requestDigest: digest,
      requestId: request.requestId,
      claimUsageId: request.claimUsageId,
    },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      'bytes32, bytes32, address, address, uint256, uint64, uint64, bytes32, bytes32, bytes32',
    ),
    [
      request.issuerId,
      request.reservationId,
      request.token,
      request.recipient,
      BigInt(request.amount),
      BigInt(request.policyVersion),
      BigInt(request.rightsVersion),
      `0x${'71'.repeat(32)}`,
      `0x${'72'.repeat(32)}`,
      `0x${'73'.repeat(32)}`,
    ],
  );
  const log = {
    address: gate,
    topics,
    data,
    transactionHash: hash,
    blockHash,
    blockNumber: '0x10',
    logIndex: '0x0',
    removed: false,
  };
  const values = {
    eth_chainId: '0x128',
    eth_getTransactionReceipt: {
      transactionHash: hash,
      to: gate,
      blockHash,
      blockNumber: '0x10',
      status: '0x1',
      logs: [log],
    },
    eth_getTransactionByHash: { hash, to: gate, blockHash },
    eth_getBlockByNumber: { hash: blockHash, number: '0x10' },
    eth_blockNumber: '0x11',
    eth_getCode: bytecode,
  };
  mutate(values);
  const calls = [];
  const fetcher = async (url, init) => {
    if (url !== chainConfig.rpcUrl)
      throw new Error('External request blocked.');
    if (init.redirect !== 'manual')
      throw new Error('Redirects must not be followed.');
    const input = JSON.parse(init.body);
    calls.push(input);
    return Response.json({
      jsonrpc: '2.0',
      id: input.id,
      result: values[input.method],
    });
  };
  return { values, fetcher, calls };
}
