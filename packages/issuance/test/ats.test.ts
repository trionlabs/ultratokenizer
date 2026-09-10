import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import {
  getClaimUsageId,
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  getIssuerPermitTypedData,
  parseIssuanceRequest,
} from '../../domain/src/index.js';
import { POLICY_FORMAT } from '../../audit/src/index.js';
import { createIssuanceClient } from '../src/client.js';
import { ERC20_TOKEN_ABI, ISSUANCE_GATE_ABI, toIssueArgs } from '../src/abi.js';
import {
  BUNDLE_FORMAT,
  DEPLOYMENT_V2_FORMAT,
  IssuanceClientError,
  parseIssuanceBundle,
} from '../src/schema.js';
import {
  ATS_FACET_PROFILE,
  ATS_LIBRARY_NAMES,
  ATS_PROFILE,
  ATS_RUNTIME_LINKS,
  ATS_UPSTREAM_COMMIT,
  ATS_VERIFICATION_ABI,
  AtsBackendError,
  MAX_ATS_BACKEND_BYTES,
  parseAtsBackend,
  verifyAtsBackend,
  type AtsFacetName,
  type AtsLibraryName,
} from '../src/ats.js';
import {
  atsFixtureAddress as addr,
  atsFixtureHash as word,
  createAtsBackendFixture,
} from './fixtures/ats.js';

const token = addr(500);
const gate = addr(501);
const snapshotNumber = 20n;
const snapshotHash = word(50);
const proxySlot =
  '0x688a1184cf65cae3790aef0eb6006209aa488bc22d1dd13eb263813b07a39300';
const issuerRole =
  '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f';
const context = { token, gate, blockNumber: snapshotNumber };
const errorCode = (code: AtsBackendError['code']) => (error: unknown) =>
  error instanceof AtsBackendError && error.code === code;

await test('ATS config is independent, exact, bounded, cloned and deeply frozen', () => {
  const fixture = createAtsBackendFixture();
  const parsed = parseAtsBackend(JSON.stringify(fixture));
  assert.deepEqual(parseAtsBackend(parsed), parsed);
  assert.notEqual(parsed, fixture);
  for (const value of [
    parsed,
    parsed.admission,
    parsed.configuration,
    parsed.facets,
    parsed.libraries,
    parsed.adapter,
    ...Object.values(parsed.facets),
    ...Object.values(parsed.libraries),
  ]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(
    () => Object.assign(parsed.adapter, { address: addr(999) }),
    TypeError,
  );
  assert.equal(parsed.adapter.address, fixture.adapter.address);
});

await test('ATS config rejects missing identity, ambiguous values, additions and oversized JSON', () => {
  const b = createAtsBackendFixture();
  for (const changed of [
    { ...b, proof: '0x01' },
    { ...b, profile: 'any-ats' },
    { ...b, upstreamCommit: 'main' },
    { ...b, tokenCodeHash: zeroHash },
    { ...b, adapter: { ...b.adapter, address: zeroAddress } },
    { ...b, resolver: b.adapter },
    { ...b, maxSupply: '01' },
    { ...b, maxSupply: '1.5' },
    { ...b, maxSupply: '9223372036854775808' },
    { ...b, maxSupply: 1000 },
    { ...b, configuration: { ...b.configuration, version: '0' } },
    { ...b, facets: { ...b.facets, BurnFacet: b.adapter } },
    { ...b, libraries: { ...b.libraries, ClearingReadOps: undefined } },
    { ...b, admission: { ...b.admission, reviewHash: zeroHash } },
    { ...b, admission: { ...b.admission, blockNumber: '0' } },
    {
      ...b,
      admission: { ...b.admission, blockNumber: '18446744073709551616' },
    },
    ' '.repeat(MAX_ATS_BACKEND_BYTES + 1),
  ])
    assert.throws(() => parseAtsBackend(changed), errorCode('invalid_config'));
  const accessor = { ...b };
  Object.defineProperty(accessor, 'profile', {
    get() {
      throw new Error('must not execute accessor');
    },
  });
  assert.throws(() => parseAtsBackend(accessor), errorCode('invalid_config'));
});

await test('exported verifier rules cannot be mutated by consumers', () => {
  const selector = ATS_FACET_PROFILE.MintFacet.selectors[0];
  assert.throws(
    () =>
      Object.assign(ATS_FACET_PROFILE.MintFacet.selectors, { 0: '0xffffffff' }),
    TypeError,
  );
  assert.throws(
    () => Object.assign(ATS_FACET_PROFILE.MintFacet, { key: zeroHash }),
    TypeError,
  );
  assert.throws(
    () => Object.assign(ATS_LIBRARY_NAMES, { 0: 'Unreviewed' }),
    TypeError,
  );
  assert.throws(
    () => Object.assign(ATS_RUNTIME_LINKS[0], { offset: 0 }),
    TypeError,
  );
  assert.throws(
    () => Object.assign(ATS_VERIFICATION_ABI[0], { name: 'unreviewed' }),
    TypeError,
  );
  assert.ok(Object.isFrozen(ATS_VERIFICATION_ABI[0].outputs));
  assert.equal(ATS_FACET_PROFILE.MintFacet.selectors[0], selector);
});

type RpcEdit = (
  method: string,
  params: readonly unknown[],
  result: unknown,
) => unknown;
type CallEdit = (
  address: Address,
  name: string,
  args: readonly unknown[],
  result: unknown,
) => unknown;

/** Deliberate JSON-RPC fixtures exercise viem decoding and failure classification.
 * Their bytecode is not executable ATS. Real EVM coverage is the optional test below.
 */
function transportFixture(
  options: { rpcEdit?: RpcEdit; callEdit?: CallEdit } = {},
) {
  const b = createAtsBackendFixture();
  const codes = new Map<Address, Hex>();
  const named = { ...b.facets, ...b.libraries };
  for (const pin of [
    b.adapter,
    b.resolver,
    b.initializer,
    ...Object.values(named),
  ])
    codes.set(pin.address, '0x6000');
  codes.set(token, '0x6000');
  for (const link of ATS_RUNTIME_LINKS) {
    const target = named[link.owner].address;
    const current = codes.get(target)!;
    const bytes = Buffer.alloc(
      Math.max((current.length - 2) / 2, link.offset + 20),
    );
    Buffer.from(current.slice(2), 'hex').copy(bytes);
    Buffer.from(b.libraries[link.library].address.slice(2), 'hex').copy(
      bytes,
      link.offset,
    );
    codes.set(target, toHex(bytes));
  }
  for (const pin of Object.values(named))
    Object.assign(pin, { codeHash: keccak256(codes.get(pin.address)!) });
  const pins = [
    ...Object.values(b.facets),
    ...Object.values(b.libraries),
    b.resolver,
  ];
  const reads: Array<{ method: string; params: readonly unknown[] }> = [];
  function resultFor(
    target: Address,
    name: string,
    args: readonly unknown[],
  ): unknown {
    const role = args[0];
    const members =
      role === zeroHash
        ? [b.initializer.address]
        : target === token && role === issuerRole
          ? [b.adapter.address]
          : [];
    switch (name) {
      case 'gate':
        return gate;
      case 'token':
        return token;
      case 'initializer':
        return b.initializer.address;
      case 'adapter':
        return b.adapter.address;
      case 'resolver':
        return b.resolver.address;
      case 'tokenCodeHash':
        return b.tokenCodeHash;
      case 'CONFIGURATION':
        return b.configuration.id;
      case 'getOwner':
        return b.initializer.address;
      case 'getPendingOwner':
        return zeroAddress;
      case 'getLatestVersionByConfiguration':
      case 'getOperationalStatus':
      case 'getFacetLastVersion':
      case 'getFacetVersionStatus':
      case 'getRoleCountFor':
        return 1n;
      case 'getFacetsLengthByConfigurationIdAndVersion':
      case 'getMaxInitializerFacetIndex':
        return 10n;
      case 'isResolverProxyConfigurationRegistered':
      case 'isIssuable':
        return true;
      case 'decimals':
        return 3;
      case 'isMultiPartition':
      case 'getControlListType':
        return false;
      case 'getControlListCount':
      case 'totalSupply':
        return 0n;
      case 'getMaxSupply':
        return BigInt(b.maxSupply);
      case 'getERC20Metadata':
        return {
          info: {
            name: 'RPC test only',
            symbol: 'TEST',
            isin: '',
            decimals: 3,
          },
          securityType: 5,
        };
      case 'getSelectorsBlacklist':
        return [];
      case 'getRuntimePins':
        return pins.map((pin) => ({
          target: pin.address,
          codeHash: pin.codeHash,
        }));
      case 'getRoleMemberCount':
        return BigInt(members.length);
      case 'getRoleMembers':
        return members;
      case 'getFacetsByConfigurationIdAndVersion':
        return Object.entries(ATS_FACET_PROFILE).map(([name, profile]) => ({
          id: profile.key,
          addr: b.facets[name as AtsFacetName].address,
          selectors: profile.selectors,
          interfaceIds: [],
        }));
      case 'getFacetConfigurationsByConfigurationIdAndVersion':
        return Object.values(ATS_FACET_PROFILE).map((profile) => ({
          id: profile.key,
          version: 1n,
        }));
      case 'resolveResolverProxyCall': {
        const name = Object.entries(ATS_FACET_PROFILE).find(([, profile]) =>
          (profile.selectors as readonly unknown[]).includes(args[2]),
        )?.[0];
        assert.ok(name);
        return b.facets[name as AtsFacetName].address;
      }
      case 'getStaticResolverKey':
      case 'getStaticFunctionSelectors': {
        const facetName = Object.entries(b.facets).find(
          ([, pin]) => pin.address === target,
        )?.[0];
        assert.ok(facetName);
        const profile = ATS_FACET_PROFILE[facetName as AtsFacetName];
        return name === 'getStaticResolverKey'
          ? profile.key
          : profile.selectors;
      }
      default:
        throw new Error(`Unexpected test read: ${name}`);
    }
  }
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method, params = [] }) {
          const values: readonly unknown[] = params;
          reads.push({ method, params: values });
          let result: unknown;
          switch (method) {
            case 'eth_getBlockByNumber': {
              const number = BigInt(String(values[0]));
              result = {
                number: toHex(number),
                hash:
                  number === snapshotNumber
                    ? snapshotHash
                    : b.admission.blockHash,
                timestamp: '0x1',
                parentHash: word(99),
                transactions: [],
              };
              break;
            }
            case 'eth_getCode': {
              const target = getAddress(String(values[0]));
              result =
                BigInt(String(values[1])) < BigInt(b.admission.blockNumber)
                  ? '0x'
                  : codes.get(target);
              break;
            }
            case 'eth_getStorageAt': {
              const target = getAddress(String(values[0]));
              const slot = BigInt(String(values[1]));
              result =
                target === token && slot === BigInt(proxySlot)
                  ? toHex(BigInt(b.resolver.address), { size: 32 })
                  : target === token && slot === BigInt(proxySlot) + 1n
                    ? b.configuration.id
                    : target === token && slot === BigInt(proxySlot) + 2n
                      ? word(1)
                      : zeroHash;
              break;
            }
            case 'eth_call': {
              const call = values[0] as { to: string; data: Hex };
              const target = getAddress(call.to);
              const { functionName, args = [] } = decodeFunctionData({
                abi: ATS_VERIFICATION_ABI as Abi,
                data: call.data,
              });
              const original = resultFor(target, functionName, args);
              const changed = options.callEdit
                ? options.callEdit(target, functionName, args, original)
                : original;
              result = encodeFunctionResult({
                abi: ATS_VERIFICATION_ABI as Abi,
                functionName,
                result: changed,
              });
              break;
            }
            case 'eth_getTransactionByHash':
              result = {
                hash: b.admission.transactionHash,
                input: '0x60016002',
                to: null,
                blockHash: b.admission.blockHash,
                blockNumber: toHex(BigInt(b.admission.blockNumber)),
                from: addr(900),
                gas: '0x1',
                gasPrice: '0x1',
                nonce: '0x1',
                value: '0x0',
                type: '0x0',
                transactionIndex: '0x0',
              };
              break;
            case 'eth_getTransactionReceipt':
              result = {
                transactionHash: b.admission.transactionHash,
                status: '0x1',
                blockHash: b.admission.blockHash,
                blockNumber: toHex(BigInt(b.admission.blockNumber)),
                contractAddress: b.initializer.address,
                from: addr(900),
                to: null,
                logs: [],
                logsBloom: '0x',
                cumulativeGasUsed: '0x1',
                gasUsed: '0x1',
                effectiveGasPrice: '0x1',
                transactionIndex: '0x0',
                type: '0x0',
              };
              break;
            default:
              throw new Error(`Unexpected test RPC: ${method}`);
          }
          return options.rpcEdit
            ? options.rpcEdit(method, values, result)
            : result;
        },
      },
      { retryCount: 0 },
    ),
  });
  return { backend: parseAtsBackend(b), client, reads };
}

await test('ATS checker uses viem ABI decoding and one fixed current state block', async () => {
  const { backend, client, reads } = transportFixture();
  await verifyAtsBackend(client, backend, context);
  assert.ok(reads.some((read) => read.method === 'eth_getTransactionReceipt'));
  for (const read of reads.filter((read) => read.method === 'eth_call'))
    assert.equal(read.params[1], toHex(snapshotNumber));
  for (const read of reads.filter((read) => read.method === 'eth_getStorageAt'))
    assert.equal(read.params[2], toHex(snapshotNumber));
});

await test('ATS checker rejects token/Gate aliasing an enrolled authority before RPC', async () => {
  const { backend, client, reads } = transportFixture();
  await assert.rejects(
    verifyAtsBackend(client, backend, {
      ...context,
      token: backend.adapter.address,
    }),
    errorCode('mismatch'),
  );
  await assert.rejects(
    verifyAtsBackend(client, backend, { ...context, gate: token }),
    errorCode('mismatch'),
  );
  assert.equal(reads.length, 0);
});

await test('runtime hashes and embedded library addresses are separate checks', async () => {
  const { backend, client } = transportFixture();
  await assert.rejects(
    verifyAtsBackend(client, { ...backend, tokenCodeHash: word(123) }, context),
    errorCode('mismatch'),
  );
  const wrongLink = transportFixture({
    rpcEdit(method, params, result) {
      if (
        method === 'eth_getCode' &&
        getAddress(String(params[0])) === backend.facets.CoreFacet.address
      ) {
        const bytes = Buffer.from(String(result).slice(2), 'hex');
        Buffer.from(addr(999).slice(2), 'hex').copy(
          bytes,
          ATS_RUNTIME_LINKS[0].offset,
        );
        return toHex(bytes);
      }
      return result;
    },
  });
  // Admit the altered runtime hash deliberately: the independent link check must still fail.
  const linked = Buffer.alloc(ATS_RUNTIME_LINKS[0].offset + 20);
  Buffer.from('6000', 'hex').copy(linked);
  Buffer.from(addr(999).slice(2), 'hex').copy(
    linked,
    ATS_RUNTIME_LINKS[0].offset,
  );
  const changed = {
    ...wrongLink.backend,
    facets: {
      ...wrongLink.backend.facets,
      CoreFacet: {
        ...wrongLink.backend.facets.CoreFacet,
        codeHash: keccak256(toHex(linked)),
      },
    },
  };
  await assert.rejects(
    verifyAtsBackend(wrongLink.client, changed, context),
    errorCode('mismatch'),
  );
});

await test('ATS graph, roles, fixed units and initialization failures are rejected', async (t) => {
  const variants: Array<[string, CallEdit]> = [
    [
      'foreign adapter Gate',
      (_target, name, _args, result) => (name === 'gate' ? addr(999) : result),
    ],
    [
      'non-inert configuration owner',
      (_target, name, _args, result) =>
        name === 'getOwner' ? addr(999) : result,
    ],
    [
      'pending owner',
      (_target, name, _args, result) =>
        name === 'getPendingOwner' ? addr(999) : result,
    ],
    [
      'additional issuer',
      (target, name, args, result) =>
        target === token &&
        name === 'getRoleMemberCount' &&
        args[0] === issuerRole
          ? 2n
          : result,
    ],
    [
      'agent role',
      (target, name, args, result) =>
        target === token &&
        name === 'getRoleMemberCount' &&
        args[0] !== issuerRole &&
        args[0] !== zeroHash
          ? 1n
          : result,
    ],
    [
      'wrong selector routing',
      (_target, name, _args, result) =>
        name === 'resolveResolverProxyCall' ? addr(999) : result,
    ],
    [
      'extra selector',
      (_target, name, _args, result) =>
        name === 'getStaticFunctionSelectors'
          ? [...(result as Hex[]), '0xffffffff']
          : result,
    ],
    [
      'uninitialized facet',
      (_target, name, _args, result) =>
        name === 'getFacetVersionStatus' ? 0n : result,
    ],
    [
      'changed decimals',
      (_target, name, _args, result) => (name === 'decimals' ? 4 : result),
    ],
    [
      'securities metadata claim',
      (_target, name, _args, result) =>
        name === 'getERC20Metadata'
          ? { ...(result as object), securityType: 1 }
          : result,
    ],
  ];
  for (const [name, callEdit] of variants)
    await t.test(name, async () => {
      const { backend, client } = transportFixture({ callEdit });
      await assert.rejects(
        verifyAtsBackend(client, backend, context),
        errorCode('mismatch'),
      );
    });
});

await test('raw configuration, active scheduling and role-admin changes cannot hide behind matching runtime', async (t) => {
  const scheduleCount =
    '0xe2e07c157b61a7bd819a93fb196f6ac3e8a94f8b21b80c29eef98c4d9b337100';
  const adminSlot = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [
        issuerRole,
        '0xff8881325a7cc80adb7ddfb5e52c7103d092b4d7833f49efafbcb1abd73a4900',
      ],
    ),
  );
  for (const [name, slot] of [
    ['configuration version', toHex(BigInt(proxySlot) + 2n, { size: 32 })],
    ['scheduled task count', scheduleCount],
    ['issuer role administrator', adminSlot],
  ])
    await t.test(name, async () => {
      const { backend, client } = transportFixture({
        rpcEdit(method, params, result) {
          return method === 'eth_getStorageAt' &&
            getAddress(String(params[0])) === token &&
            BigInt(String(params[1])) === BigInt(slot)
            ? word(2)
            : result;
        },
      });
      await assert.rejects(
        verifyAtsBackend(client, backend, context),
        errorCode('mismatch'),
      );
    });
});

await test('stale or non-atomic creation admission is rejected', async (t) => {
  const variants: Array<[string, RpcEdit]> = [
    [
      'stale creation block',
      (method, params, result) =>
        method === 'eth_getBlockByNumber' && params[0] === '0xa'
          ? { ...(result as object), hash: word(999) }
          : result,
    ],
    [
      'nested factory creation',
      (method, _params, result) =>
        method === 'eth_getTransactionByHash'
          ? { ...(result as object), to: addr(999) }
          : result,
    ],
    [
      'different creation input',
      (method, _params, result) =>
        method === 'eth_getTransactionByHash'
          ? { ...(result as object), input: '0x01' }
          : result,
    ],
    [
      'failed creation receipt',
      (method, _params, result) =>
        method === 'eth_getTransactionReceipt'
          ? { ...(result as object), status: '0x0' }
          : result,
    ],
    [
      'previously existing token',
      (method, params, result) =>
        method === 'eth_getCode' && params[1] === '0x9' ? '0x6000' : result,
    ],
    [
      'different initial runtime',
      (method, params, result) =>
        method === 'eth_getCode' && params[1] === '0xa' ? '0x6001' : result,
    ],
  ];
  for (const [name, rpcEdit] of variants)
    await t.test(name, async () => {
      const { backend, client } = transportFixture({ rpcEdit });
      await assert.rejects(
        verifyAtsBackend(client, backend, context),
        errorCode('mismatch'),
      );
    });
});

await test('RPC reverts, outages and moving canonical state remain unavailable', async (t) => {
  for (const message of [
    'connection reset',
    'execution reverted',
    'CONTRACT_EXECUTION_EXCEPTION',
  ])
    await t.test(message, async () => {
      const { backend, client } = transportFixture({
        rpcEdit(method, _params, result) {
          if (method === 'eth_getStorageAt') throw new Error(message);
          return result;
        },
      });
      await assert.rejects(
        verifyAtsBackend(client, backend, context),
        errorCode('unavailable'),
      );
    });
  let currentReads = 0;
  const { backend, client } = transportFixture({
    rpcEdit(method, params, result) {
      if (
        method === 'eth_getBlockByNumber' &&
        params[0] === toHex(snapshotNumber) &&
        ++currentReads > 1
      )
        return { ...(result as object), hash: word(999) };
      return result;
    },
  });
  await assert.rejects(
    verifyAtsBackend(client, backend, context),
    errorCode('unavailable'),
  );
});

// Explicit local-only acceptance. The mandatory check:ats lane builds this normal
// source package first; ordinary unit tests can omit a local EVM intentionally.
const artifactRoot = process.env.ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS;
await test(
  'actual pinned ATS contracts pass the reader through an ephemeral local Anvil',
  {
    skip: artifactRoot
      ? false
      : 'Set ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS to contracts/ats/build after its source build.',
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(artifactRoot);
    const root = resolve(artifactRoot);
    // Load the checked-in verifier, never executable code from an env-supplied artifact directory.
    const { verifyBuild } = await import(
      new URL(
        '../../../../contracts/ats/scripts/verify-build.mjs',
        import.meta.url,
      ).href
    );
    const { manifest, manifestSha256, artifacts, testArtifacts } =
      await verifyBuild({ buildRoot: root });
    assert.equal(manifest.upstreamCommit, ATS_UPSTREAM_COMMIT);

    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const socket = portProbe.address();
    assert.ok(socket && typeof socket !== 'string');
    const port = socket.port;
    await new Promise<void>((done, reject) =>
      portProbe.close((error) => (error ? reject(error) : done())),
    );
    const anvil = spawn(
      process.env.ANVIL_BIN ?? 'anvil',
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--hardfork',
        'cancun',
        '--gas-limit',
        '100000000',
        '--silent',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const endpoint = `http://127.0.0.1:${port}`;
    t.after(async () => {
      if (anvil.exitCode === null) {
        const exited = once(anvil, 'exit');
        anvil.kill('SIGTERM');
        await exited;
      }
    });
    const rpc = createPublicClient({
      transport: http(endpoint, { retryCount: 0, timeout: 3000 }),
      pollingInterval: 10,
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await rpc.getChainId();
        ready = true;
        break;
      } catch {
        await setTimeout(20);
      }
    }
    assert.ok(ready, 'Anvil did not start');
    const wallet = createWalletClient({
      transport: http(endpoint, { retryCount: 0 }),
      pollingInterval: 10,
    });
    const [account] = await wallet.getAddresses();
    assert.ok(account);
    async function deploy(data: Hex, name: string) {
      const hash = await wallet.sendTransaction({
        account,
        chain: null,
        data,
        gas: 90_000_000n,
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
      assert.ok(receipt.contractAddress);
      const code = await rpc.getCode({
        address: receipt.contractAddress,
        blockNumber: receipt.blockNumber,
      });
      assert.ok(code);
      t.diagnostic(
        `Local creation ${name}: init ${(data.length - 2) / 2} bytes, runtime ${(code.length - 2) / 2} bytes, gas ${receipt.gasUsed}.`,
      );
      return {
        address: getAddress(receipt.contractAddress),
        hash,
        receipt,
        data,
      };
    }
    const deployed = new Map<string, Address>();
    async function load(name: string): Promise<Hex> {
      const artifact = artifacts[name];
      assert.ok(artifact);
      let creation: string = artifact.bytecode.object;
      for (const libraries of Object.values(
        artifact.bytecode.linkReferences,
      ) as Array<Record<string, Array<{ start: number; length: number }>>>) {
        for (const [library, offsets] of Object.entries(libraries)) {
          const linkedAddress = await deployArtifact(library);
          for (const offset of offsets) {
            assert.equal(offset.length, 20);
            const start = 2 + offset.start * 2;
            creation = `${creation.slice(0, start)}${linkedAddress.slice(2)}${creation.slice(start + 40)}`;
          }
        }
      }
      assert.match(creation, /^0x[0-9a-fA-F]+$/);
      return creation as Hex;
    }
    async function deployArtifact(name: string): Promise<Address> {
      const existing = deployed.get(name);
      if (existing) return existing;
      const creation = await load(name);
      const result = await deploy(creation, name);
      deployed.set(name, result.address);
      return result.address;
    }
    async function pin(address: Address) {
      const code = await rpc.getCode({ address });
      assert.ok(code && code !== '0x');
      return { address, codeHash: keccak256(code) };
    }
    const facets = {} as Record<AtsFacetName, Awaited<ReturnType<typeof pin>>>;
    for (const name of Object.keys(ATS_FACET_PROFILE) as AtsFacetName[])
      facets[name] = await pin(await deployArtifact(name));
    const libraries = {} as Record<
      AtsLibraryName,
      Awaited<ReturnType<typeof pin>>
    >;
    for (const name of ATS_LIBRARY_NAMES)
      libraries[name] = await pin(await deployArtifact(name));
    const gateBytes = artifacts.IssuanceGate.bytecode.object as Hex;
    const actualGate = await deploy(
      concatHex([
        gateBytes,
        encodeAbiParameters([{ type: 'address' }], [account]),
      ]),
      'IssuanceGate',
    );
    const adapterBytes = artifacts.AtsGateMintAdapter.bytecode.object as Hex;
    const runtimePinType = {
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'codeHash', type: 'bytes32' },
      ],
    } as const;
    const owner = await deploy(
      concatHex([
        await load('AtsGateProfile'),
        encodeAbiParameters(
          [
            { type: 'address' },
            runtimePinType,
            runtimePinType,
            { type: 'bytes' },
          ],
          [
            actualGate.address,
            Object.values(facets).map((value) => ({
              target: value.address,
              codeHash: value.codeHash,
            })),
            Object.values(libraries).map((value) => ({
              target: value.address,
              codeHash: value.codeHash,
            })),
            adapterBytes,
          ],
        ),
      ]),
      'AtsGateProfile',
    );
    const actualToken = await rpc.readContract({
      address: owner.address,
      abi: ATS_VERIFICATION_ABI,
      functionName: 'token',
    });
    const actualAdapter = await rpc.readContract({
      address: owner.address,
      abi: ATS_VERIFICATION_ABI,
      functionName: 'adapter',
    });
    const actualResolver = await rpc.readContract({
      address: owner.address,
      abi: ATS_VERIFICATION_ABI,
      functionName: 'resolver',
    });
    const configuration = await rpc.readContract({
      address: owner.address,
      abi: ATS_VERIFICATION_ABI,
      functionName: 'CONFIGURATION',
    });
    const b = parseAtsBackend({
      kind: 'ats',
      profile: ATS_PROFILE,
      upstreamCommit: ATS_UPSTREAM_COMMIT,
      tokenCodeHash: (await pin(actualToken)).codeHash,
      maxSupply: '1000000',
      adapter: await pin(actualAdapter),
      resolver: await pin(actualResolver),
      initializer: await pin(owner.address),
      configuration: { id: configuration, version: '1' },
      facets,
      libraries,
      admission: {
        kind: 'reviewed-atomic-creation.v1',
        transactionHash: owner.hash,
        transactionInputHash: keccak256(owner.data),
        blockNumber: String(owner.receipt.blockNumber),
        blockHash: owner.receipt.blockHash,
        reviewHash: `0x${manifestSha256}`,
      },
    });
    const actualContext = {
      token: actualToken,
      gate: actualGate.address,
      blockNumber: await rpc.getBlockNumber({ cacheTime: 0 }),
    };
    await t.test(
      'direct creation, real role enumerators, config, units and raw slots pass',
      async () => {
        await verifyAtsBackend(rpc, b, actualContext);
        assert.equal(
          await rpc.readContract({
            address: actualToken,
            abi: ATS_VERIFICATION_ABI,
            functionName: 'totalSupply',
          }),
          0n,
        );
      },
    );
    await t.test(
      'real deployment rejects wrong independent adapter identity',
      async () => {
        await assert.rejects(
          verifyAtsBackend(
            rpc,
            { ...b, adapter: { ...b.adapter, codeHash: word(999) } },
            actualContext,
          ),
          errorCode('mismatch'),
        );
      },
    );
    await t.test(
      'real deployment rejects stale creation block pin',
      async () => {
        await assert.rejects(
          verifyAtsBackend(
            rpc,
            { ...b, admission: { ...b.admission, blockHash: word(999) } },
            actualContext,
          ),
          errorCode('mismatch'),
        );
      },
    );
    await t.test(
      'real token has no reachable grant or direct mint for its deployer',
      async () => {
        for (const [functionName, args] of [
          ['grantRole', [issuerRole, account]],
          ['mint', [account, 1n]],
        ] as const) {
          await assert.rejects(
            rpc.simulateContract({
              address: actualToken,
              account,
              abi: parseAbi([
                'function grantRole(bytes32,address)',
                'function mint(address,uint256)',
              ]),
              functionName,
              args,
            }),
          );
        }
      },
    );
    await t.test(
      'main client transfers existing exact issuance after Gate rights revocation',
      async () => {
        // This explicit test double validates Gate state binding, never SP1/source authenticity.
        const testVerifierArtifact = testArtifacts.GateStateOnlyVerifier;
        const testVerifier = await deploy(
          testVerifierArtifact.bytecode.object,
          'GateStateOnlyVerifier [TEST ONLY]',
        );
        const testVerifierPin = await pin(testVerifier.address);
        const programVKey = await rpc.readContract({
          address: testVerifier.address,
          abi: parseAbi(['function TEST_VKEY() view returns (bytes32)']),
          functionName: 'TEST_VKEY',
        });
        const gateAbi: Abi = artifacts.IssuanceGate.abi;
        const accounts = await wallet.getAddresses();
        const holder = accounts[1];
        const recipient = accounts[2];
        assert.ok(holder && recipient);
        const expiry = (await rpc.getBlock()).timestamp + 3600n;
        const issuerId = word(700);
        const sourceId = word(701);
        const fingerprint = word(702);
        const request = parseIssuanceRequest({
          schemaVersion: '1',
          action: 'ISSUE',
          requestId: word(703),
          chainId: String(await rpc.getChainId()),
          gate: actualGate.address,
          token: actualToken,
          recipient: holder,
          amount: '1000',
          unit: 'XAU_MILLIGRAM',
          issuerId,
          reservationId: word(704),
          claimCommitment: word(705),
          claimUsageId: word(706),
          policyVersion: '1',
          rightsVersion: '1',
          nonce: '1',
          validUntil: String(expiry),
        });
        async function gateWrite(
          functionName: string,
          args: readonly unknown[],
        ) {
          const hash = await wallet.writeContract({
            account,
            chain: null,
            address: actualGate.address,
            abi: gateAbi,
            functionName,
            args,
            gas: 10_000_000n,
          });
          const receipt = await rpc.waitForTransactionReceipt({ hash });
          assert.equal(receipt.status, 'success');
        }
        await gateWrite('registerIssuerKey', [issuerId, 1n, account, expiry]);
        await gateWrite('registerProgram', [
          1n,
          testVerifier.address,
          testVerifierPin.codeHash,
          programVKey,
          2,
        ]);
        await gateWrite('registerSourceKey', [sourceId, 1n, fingerprint]);
        await gateWrite('registerPolicy', [
          issuerId,
          1n,
          1n,
          sourceId,
          1n,
          word(707),
        ]);
        await gateWrite('registerRights', [
          issuerId,
          1n,
          actualAdapter,
          word(708),
        ]);
        await gateWrite('setBackingCap', [issuerId, actualToken, 1000n]);
        await gateWrite('setPaused', [false]);
        const digest = getIssuanceRequestDigest(request);
        await gateWrite('openReservation', [
          issuerId,
          1n,
          request.reservationId,
          holder,
          actualToken,
          1000n,
          expiry,
          digest,
          request.claimUsageId,
        ]);
        const publicValues = encodeAbiParameters(
          [
            { type: 'uint32' },
            ...Array.from({ length: 5 }, () => ({ type: 'bytes32' })),
            { type: 'uint64' },
          ],
          [
            2,
            digest,
            fingerprint,
            sourceId,
            request.claimUsageId,
            request.claimCommitment,
            expiry,
          ],
        );
        const configure = await wallet.writeContract({
          account,
          chain: null,
          address: testVerifier.address,
          abi: parseAbi(['function configure(bytes32,bool)']),
          functionName: 'configure',
          args: [keccak256(publicValues), false],
        });
        assert.equal(
          (await rpc.waitForTransactionReceipt({ hash: configure })).status,
          'success',
        );
        const permit = {
          requestDigest: digest,
          issuerId,
          keyVersion: '1',
          nonce: '1',
          validUntil: String(expiry - 100n),
        };
        const holderSignature = await wallet.signTypedData({
          account: holder,
          ...getIssuanceRequestTypedData(request),
        });
        const issuerSignature = await wallet.signTypedData({
          account,
          ...getIssuerPermitTypedData(request, permit),
        });
        const bundle = parseIssuanceBundle({
          format: BUNDLE_FORMAT,
          request,
          permit,
          issuerSignature,
          publicValues,
          proofBytes: '0xcafe',
          programVKey,
        });
        await gateWrite('issue', toIssueArgs(bundle, holderSignature));
        assert.equal(
          await rpc.readContract({
            address: actualToken,
            abi: ERC20_TOKEN_ABI,
            functionName: 'balanceOf',
            args: [holder],
          }),
          1000n,
        );
        // A distinct synthetic right stays unused across the revocation. Reusing
        // the first bundle would conflate rights rejection with consumed capacity.
        const freshRequest = parseIssuanceRequest({
          ...request,
          requestId: word(709),
          reservationId: word(710),
          claimCommitment: word(711),
          claimUsageId: getClaimUsageId({ sourceId, claimId: word(712) }),
          nonce: '2',
        });
        const freshDigest = getIssuanceRequestDigest(freshRequest);
        await gateWrite('setBackingCap', [issuerId, actualToken, 2000n]);
        await gateWrite('openReservation', [
          issuerId,
          1n,
          freshRequest.reservationId,
          holder,
          actualToken,
          1000n,
          expiry,
          freshDigest,
          freshRequest.claimUsageId,
        ]);
        const freshValues = encodeAbiParameters(
          [
            { type: 'uint32' },
            ...Array.from({ length: 5 }, () => ({ type: 'bytes32' })),
            { type: 'uint64' },
          ],
          [
            2,
            freshDigest,
            fingerprint,
            sourceId,
            freshRequest.claimUsageId,
            freshRequest.claimCommitment,
            expiry,
          ],
        );
        const freshConfigure = await wallet.writeContract({
          account,
          chain: null,
          address: testVerifier.address,
          abi: parseAbi(['function configure(bytes32,bool)']),
          functionName: 'configure',
          args: [keccak256(freshValues), false],
        });
        assert.equal(
          (await rpc.waitForTransactionReceipt({ hash: freshConfigure }))
            .status,
          'success',
        );
        const freshPermit = {
          ...permit,
          requestDigest: freshDigest,
          nonce: '2',
        };
        const freshBundle = parseIssuanceBundle({
          ...bundle,
          request: freshRequest,
          permit: freshPermit,
          publicValues: freshValues,
          issuerSignature: await wallet.signTypedData({
            account,
            ...getIssuerPermitTypedData(freshRequest, freshPermit),
          }),
        });
        async function assertFreshUnused() {
          for (const [functionName, args] of [
            ['usedRequests', [freshDigest]],
            ['usedRequestIds', [freshRequest.requestId]],
            ['usedClaims', [freshRequest.claimUsageId]],
            ['usedHolderNonces', [holder, 2n]],
            ['usedPermitNonces', [issuerId, 1n, 2n]],
          ] as const) {
            assert.equal(
              await rpc.readContract({
                address: actualGate.address,
                abi: ISSUANCE_GATE_ABI,
                functionName,
                args,
              }),
              false,
            );
          }
          const reservation = await rpc.readContract({
            address: actualGate.address,
            abi: ISSUANCE_GATE_ABI,
            functionName: 'reservations',
            args: [issuerId, freshRequest.reservationId],
          });
          assert.equal(reservation[2], 1000n);
          assert.equal(reservation[3], 0n);
          assert.equal(reservation[5], false);
          assert.equal(reservation[8], false);
        }
        const provider = {
          async request(args: { method: string; params?: readonly unknown[] }) {
            if (
              args.method === 'eth_accounts' ||
              args.method === 'eth_requestAccounts'
            )
              return [holder];
            return wallet.transport.request(args);
          },
          on() {},
          removeListener() {},
        } as EIP1193Provider;
        const client = createIssuanceClient({
          provider,
          deployment: {
            format: DEPLOYMENT_V2_FORMAT,
            purpose: 'test',
            rpcUrl: endpoint,
            gateCodeHash: (await pin(actualGate.address)).codeHash,
            confirmations: 1,
            backend: b,
            auditPolicy: {
              format: POLICY_FORMAT,
              chainId: request.chainId,
              gate: actualGate.address,
              token: actualToken,
              issuerId,
              issuerAddress: account,
              issuerKeyVersion: '1',
              policyVersion: '1',
              rightsVersion: '1',
              programVKey,
              profileVersion: '2',
              sourceId,
              sourceSignerFingerprint: fingerprint,
              proofSystem: 'sp1-groth16',
              outerVersion: 'v6.1.0',
              verifierAddress: testVerifier.address,
              verifierCodeHash: testVerifierPin.codeHash,
            },
          },
        });
        assert.equal(await client.balance(), 1000n);
        await assertFreshUnused();
        assert.equal(
          (await client.validate(freshBundle)).request.requestId,
          freshRequest.requestId,
        );
        await gateWrite('revokeRights', [issuerId, 1n]);
        assert.equal(
          (
            await rpc.readContract({
              address: actualGate.address,
              abi: ISSUANCE_GATE_ABI,
              functionName: 'rights',
              args: [issuerId, 1n],
            })
          )[4],
          true,
        );
        await assertFreshUnused();
        await assert.rejects(
          client.validate(freshBundle),
          (error) =>
            error instanceof IssuanceClientError &&
            error.code === 'deployment_mismatch',
        );
        const transferIntent = await client.prepareTokenTransaction(
          {
            kind: 'transfer',
            recipient,
            milligrams: '125',
          },
          holder,
        );
        const transferHash = await client.sendTokenTransaction(transferIntent);
        await client.waitTokenTransaction(transferHash, transferIntent);
        assert.equal(await client.balance(), 875n);
        assert.equal(
          await rpc.readContract({
            address: actualToken,
            abi: ERC20_TOKEN_ABI,
            functionName: 'balanceOf',
            args: [recipient],
          }),
          125n,
        );
        assert.equal(
          await rpc.readContract({
            address: actualToken,
            abi: ATS_VERIFICATION_ABI,
            functionName: 'totalSupply',
          }),
          1000n,
        );
      },
    );
    t.diagnostic(
      `Actual local EVM only: ${Object.keys(facets).length} ATS facets, ${Object.keys(libraries).length} linked libraries, direct inert initializer and actual Gate; no proof acceptance or Hedera transaction.`,
    );
  },
);
