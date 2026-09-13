import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toHex,
  toBytes,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { parseDuplicateFreeJson } from '../../domain/src/index.js';

/** Fixed source/selector/layout profile, not a certification of caller-supplied hashes.
 * Upstream: https://github.com/hashgraph/asset-tokenization-studio/tree/be4f860e408ec5b1a24d12feb6f872aabff69319
 * Artifacts: solc 0.8.28, Cancun, optimizer 100, no via-IR. No default deployment pins.
 */
export const ATS_PROFILE = 'ultratokenizer.ats-gold-right.v1';
export const ATS_UPSTREAM_COMMIT = 'be4f860e408ec5b1a24d12feb6f872aabff69319';
export const MAX_ATS_BACKEND_BYTES = 64 * 1024;
export type AtsFacetName = keyof typeof ATS_FACET_PROFILE;
export type AtsLibraryName = (typeof ATS_LIBRARY_NAMES)[number];
export type AtsRuntimePin = Readonly<{ address: Address; codeHash: Hex }>;
export type AtsBackend = Readonly<{
  kind: 'ats';
  profile: typeof ATS_PROFILE;
  upstreamCommit: typeof ATS_UPSTREAM_COMMIT;
  tokenCodeHash: Hex;
  maxSupply: string;
  adapter: AtsRuntimePin;
  resolver: AtsRuntimePin;
  initializer: AtsRuntimePin;
  configuration: Readonly<{ id: Hex; version: '1' }>;
  facets: Readonly<Record<AtsFacetName, AtsRuntimePin>>;
  libraries: Readonly<Record<AtsLibraryName, AtsRuntimePin>>;
  admission: Readonly<{
    kind: 'reviewed-atomic-creation.v1';
    transactionHash: Hex;
    transactionInputHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    reviewHash: Hex;
  }>;
}>;
export class AtsBackendError extends Error {
  constructor(readonly code: 'invalid_config' | 'mismatch' | 'unavailable') {
    super(
      code === 'invalid_config'
        ? 'Invalid independent ATS deployment configuration.'
        : code === 'mismatch'
          ? 'The ATS deployment does not match its admitted configuration.'
          : 'ATS deployment verification is unavailable or its chain view changed.',
    );
    this.name = 'AtsBackendError';
  }
}
export type AtsBackendReader = Pick<
  PublicClient,
  | 'getCode'
  | 'getStorageAt'
  | 'readContract'
  | 'getBlock'
  | 'getTransaction'
  | 'getTransactionReceipt'
>;

function configRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(input, key)!),
    )
  )
    throw new Error();
  return input as Record<string, unknown>;
}
function hash(input: unknown): Hex {
  if (
    typeof input !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(input) ||
    /^0x0+$/.test(input)
  )
    throw new Error();
  return input.toLowerCase() as Hex;
}
function address(input: unknown): Address {
  if (
    typeof input !== 'string' ||
    !isAddress(input, { strict: true }) ||
    getAddress(input) === zeroAddress
  )
    throw new Error();
  return getAddress(input);
}
function positive(input: unknown, maximum: bigint): string {
  if (
    typeof input !== 'string' ||
    input.length > 78 ||
    !/^[1-9][0-9]*$/.test(input) ||
    BigInt(input) > maximum
  )
    throw new Error();
  return input;
}
function runtimePin(input: unknown): AtsRuntimePin {
  const value = configRecord(input, ['address', 'codeHash']);
  return Object.freeze({
    address: address(value.address),
    codeHash: hash(value.codeHash),
  });
}

/** Trust configuration must be loaded independently of a claim/proof bundle.
 * reviewHash is an accepted external review commitment, not a self-validating certificate.
 */
export function parseAtsBackend(input: unknown): AtsBackend {
  try {
    if (typeof input === 'string')
      input = parseDuplicateFreeJson(input, MAX_ATS_BACKEND_BYTES);
    const v = configRecord(input, [
      'kind',
      'profile',
      'upstreamCommit',
      'tokenCodeHash',
      'maxSupply',
      'adapter',
      'resolver',
      'initializer',
      'configuration',
      'facets',
      'libraries',
      'admission',
    ]);
    if (
      v.kind !== 'ats' ||
      v.profile !== ATS_PROFILE ||
      v.upstreamCommit !== ATS_UPSTREAM_COMMIT
    )
      throw new Error();
    const config = configRecord(v.configuration, ['id', 'version']);
    if (config.version !== '1') throw new Error();
    const a = configRecord(v.admission, [
      'kind',
      'transactionHash',
      'transactionInputHash',
      'blockNumber',
      'blockHash',
      'reviewHash',
    ]);
    if (a.kind !== 'reviewed-atomic-creation.v1') throw new Error();
    const suppliedFacets = configRecord(
      v.facets,
      Object.keys(ATS_FACET_PROFILE),
    );
    const suppliedLibraries = configRecord(v.libraries, ATS_LIBRARY_NAMES);
    const facets = Object.freeze(
      Object.fromEntries(
        Object.keys(ATS_FACET_PROFILE).map((name) => [
          name,
          runtimePin(suppliedFacets[name]),
        ]),
      ),
    ) as AtsBackend['facets'];
    const libraries = Object.freeze(
      Object.fromEntries(
        ATS_LIBRARY_NAMES.map((name) => [
          name,
          runtimePin(suppliedLibraries[name]),
        ]),
      ),
    ) as AtsBackend['libraries'];
    const result: AtsBackend = Object.freeze({
      kind: 'ats',
      profile: ATS_PROFILE,
      upstreamCommit: ATS_UPSTREAM_COMMIT,
      tokenCodeHash: hash(v.tokenCodeHash),
      maxSupply: positive(v.maxSupply, 9223372036854775807n),
      adapter: runtimePin(v.adapter),
      resolver: runtimePin(v.resolver),
      initializer: runtimePin(v.initializer),
      configuration: Object.freeze({ id: hash(config.id), version: '1' }),
      facets,
      libraries,
      admission: Object.freeze({
        kind: 'reviewed-atomic-creation.v1',
        transactionHash: hash(a.transactionHash),
        transactionInputHash: hash(a.transactionInputHash),
        blockNumber: positive(a.blockNumber, (1n << 64n) - 1n),
        blockHash: hash(a.blockHash),
        reviewHash: hash(a.reviewHash),
      }),
    });
    const pins = [
      result.adapter,
      result.resolver,
      result.initializer,
      ...Object.values(facets),
      ...Object.values(libraries),
    ];
    if (
      new Set(pins.map((pin) => pin.address)).size !== pins.length ||
      new TextEncoder().encode(JSON.stringify(result)).length >
        MAX_ATS_BACKEND_BYTES
    )
      throw new Error();
    return result;
  } catch {
    throw new AtsBackendError('invalid_config');
  }
}
export const ATS_FACET_PROFILE = {
  AccessControlFacet: {
    key: '0xccc2e755f9225e65f6c822a258c866fc0d57a124ad12c8928adf3ff875ffcd70',
    selectors: [
      '0xfcfffeec',
      '0x8fa9b4fe',
      '0xca15c873',
      '0x2a861f57',
      '0xa28cf9a9',
      '0x2f2ff15d',
      '0x91d14854',
      '0xfea0c02e',
      '0x8bb9c5bf',
      '0xd547741f',
    ],
  },
  InitializerFacet: {
    key: '0xe7caa2e00c841ed2a64c4c95e3981f3bfc29108599fad6e89b04f9483df0bf09',
    selectors: [
      '0xccc02360',
      '0xab8365aa',
      '0xdbc12e97',
      '0x6da4c898',
      '0x14055c1c',
      '0x720ab28e',
      '0xdb5622a3',
    ],
  },
  CoreFacet: {
    key: '0xb54e0c9a42346a2760a44e59035a2b84a61d07bed66a2f24cffe3ca4bae1996f',
    selectors: [
      '0x313ce567',
      '0x8e649195',
      '0xb446569a',
      '0x06fdde03',
      '0xc47f0027',
      '0xb84c8246',
      '0x95d89b41',
      '0x54fd4d50',
    ],
  },
  CapFacet: {
    key: '0x88a28e7c45a3ce8d4ca60cd480c98e1b46feb84caec725cb0a6cf96b2c5143b5',
    selectors: ['0x4c0f38c2', '0x53c808ca', '0x6f8b44b0'],
  },
  PartitionsFacet: {
    key: '0x9caef059931effa6169ed564cfd0d8dac03be612be61f4fc934e8554cfe1c53f',
    selectors: ['0xd3594a37', '0xbd09cc54', '0x740ab8f4'],
  },
  MintFacet: {
    key: '0x394ec838636f78e91b7dbb3e4ea567e07bbb3886ab70a66652c40be856ab9b7a',
    selectors: ['0x3edc3665', '0x2f1cae85', '0xbb3acde9', '0x40c10f19'],
  },
  TransferFacet: {
    key: '0xdb0637d5ac2d3a8a460b63275e82a566d4b5ac4b9d2d2938f70c6612970a4b64',
    selectors: [
      '0x8691eaf1',
      '0xa9059cbb',
      '0x23b872dd',
      '0xee532f31',
      '0x2535f762',
    ],
  },
  BalanceTrackerFacet: {
    key: '0xefbff5dcb4e5bf43bf472fd0646991b8b4731876498b2a4248f9aa9aee1a127b',
    selectors: ['0x70a08231', '0xa8f9868e', '0x699d7be8', '0x18160ddd'],
  },
  AllowanceFacet: {
    key: '0x329473cfbe06c7719b3c986b04b90a16a859b86307aad33eea0c3dfe87160ab7',
    selectors: [
      '0xdd62ed3e',
      '0x095ea7b3',
      '0xa457c2d7',
      '0x39509351',
      '0x70a8e1d6',
    ],
  },
  ControlListFacet: {
    key: '0x7bbee58c68b6e19a08128d25f150956d20a69d1cc049afda563753771781ecc5',
    selectors: [
      '0xe8204966',
      '0x6b5d2ea5',
      '0xcad7e56b',
      '0x1d46c292',
      '0x24bf9186',
      '0xfd5b071b',
      '0x47b52d3b',
    ],
  },
} as const;
export const ATS_LIBRARY_NAMES = [
  'TokenCoreOps',
  'ClearingReadOps',
  'ScheduledTasksOps',
  'ScheduledTasksDispatchOps',
] as const;
export const ATS_RUNTIME_LINKS = [
  {
    owner: 'CoreFacet',
    library: 'ScheduledTasksOps',
    offset: 1907,
  },
  {
    owner: 'MintFacet',
    library: 'TokenCoreOps',
    offset: 616,
  },
  {
    owner: 'MintFacet',
    library: 'TokenCoreOps',
    offset: 1013,
  },
  {
    owner: 'TransferFacet',
    library: 'TokenCoreOps',
    offset: 345,
  },
  {
    owner: 'TransferFacet',
    library: 'TokenCoreOps',
    offset: 544,
  },
  {
    owner: 'TransferFacet',
    library: 'TokenCoreOps',
    offset: 942,
  },
  {
    owner: 'TransferFacet',
    library: 'TokenCoreOps',
    offset: 1241,
  },
  {
    owner: 'BalanceTrackerFacet',
    library: 'ClearingReadOps',
    offset: 874,
  },
  {
    owner: 'AllowanceFacet',
    library: 'TokenCoreOps',
    offset: 343,
  },
  {
    owner: 'AllowanceFacet',
    library: 'TokenCoreOps',
    offset: 549,
  },
  {
    owner: 'AllowanceFacet',
    library: 'TokenCoreOps',
    offset: 767,
  },
  {
    owner: 'TokenCoreOps',
    library: 'ClearingReadOps',
    offset: 11559,
  },
  {
    owner: 'TokenCoreOps',
    library: 'ScheduledTasksOps',
    offset: 2370,
  },
  {
    owner: 'ScheduledTasksOps',
    library: 'ScheduledTasksDispatchOps',
    offset: 416,
  },
  {
    owner: 'ScheduledTasksOps',
    library: 'ScheduledTasksDispatchOps',
    offset: 1493,
  },
] as const;

for (const definition of Object.values(ATS_FACET_PROFILE)) {
  Object.freeze(definition.selectors);
  Object.freeze(definition);
}
Object.freeze(ATS_FACET_PROFILE);
Object.freeze(ATS_LIBRARY_NAMES);
for (const link of ATS_RUNTIME_LINKS) Object.freeze(link);
Object.freeze(ATS_RUNTIME_LINKS);

// Signatures copied from pinned ATS interfaces. These are read-only calls, not
// a permissive token ABI and not a deployment identity by themselves.
export const ATS_VERIFICATION_ABI = parseAbi([
  'function gate() view returns (address)',
  'function token() view returns (address)',
  'function adapter() view returns (address)',
  'function resolver() view returns (address)',
  'function initializer() view returns (address)',
  'function CONFIGURATION() view returns (bytes32)',
  'function tokenCodeHash() view returns (bytes32)',
  'function getRuntimePins() view returns ((address target, bytes32 codeHash)[])',
  'function getStaticResolverKey() pure returns (bytes32)',
  'function getStaticFunctionSelectors() pure returns (bytes4[])',
  'function getLatestVersionByConfiguration(bytes32) view returns (uint256)',
  'function getFacetsLengthByConfigurationIdAndVersion(bytes32,uint256) view returns (uint256)',
  'function getFacetsByConfigurationIdAndVersion(bytes32,uint256,uint256,uint256) view returns ((bytes32 id,address addr,bytes4[] selectors,bytes4[] interfaceIds)[])',
  'function getFacetConfigurationsByConfigurationIdAndVersion(bytes32,uint256,uint256,uint256) view returns ((bytes32 id,uint256 version)[])',
  'function resolveResolverProxyCall(bytes32,uint256,bytes4) view returns (address)',
  'function isResolverProxyConfigurationRegistered(bytes32,uint256) view returns (bool)',
  'function getOwner(bytes32) view returns (address)',
  'function getPendingOwner(bytes32) view returns (address)',
  'function getSelectorsBlacklist(bytes32,uint256,uint256) view returns (bytes4[])',
  'function getRoleMemberCount(bytes32) view returns (uint256)',
  'function getRoleMembers(bytes32,uint256,uint256) view returns (address[])',
  'function getRoleCountFor(address) view returns (uint256)',
  'function getRolesFor(address,uint256,uint256) view returns (bytes32[])',
  'function getOperationalStatus(bytes32,uint256) view returns (uint256)',
  'function getFacetVersionStatus(bytes32,uint256) view returns (uint256)',
  'function getFacetLastVersion(bytes32) view returns (uint256)',
  'function getMaxInitializerFacetIndex() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function getMaxSupply() view returns (uint256)',
  'function isMultiPartition() view returns (bool)',
  'function isIssuable() view returns (bool)',
  'function getControlListCount() view returns (uint256)',
  'function getControlListType() view returns (bool)',
  'function getERC20Metadata() view returns (((string name,string symbol,string isin,uint8 decimals) info,uint8 securityType))',
]);
function freezeTree(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
}
freezeTree(ATS_VERIFICATION_ABI);

const PROXY_SLOT =
  '0x688a1184cf65cae3790aef0eb6006209aa488bc22d1dd13eb263813b07a39300' as Hex;
const ACCESS_CONTROL_SLOT =
  '0xff8881325a7cc80adb7ddfb5e52c7103d092b4d7833f49efafbcb1abd73a4900' as Hex;
const OVERRIDE_SLOTS = [
  '0x6dffada92f87e08031a64f3c82fa9d9b647a47b516130bdc52f646d498adc7f0',
  '0xda5cca5277b046f39c27835382b41a07ac714748d81f7c159fdbc36744ce094c',
  '0x507776cadb568c2dfe62bb4eca625ba1425f245e80c0326444bc9d318035af6c',
  '0x6dffada92f87e08031a64f3c82fa9d9b647a47b516130bdc52f646d498adc7ef',
  '0xda5cca5277b046f39c27835382b41b07ac714748d81f7c159fdbc36744ce094b',
] as const;
// Scalar and array-length slots only. Mapping headers cannot prove mapping emptiness.
const ZERO_TOKEN_SLOTS = [
  ...OVERRIDE_SLOTS,
  '0xe2e07c157b61a7bd819a93fb196f6ac3e8a94f8b21b80c29eef98c4d9b337100',
  '0xa0157ee35363346eb57cfbda57a41ce45f495ee1e325889bbdf25b28f39b3400',
  '0x2585709bc5ff555bc3cb151d59074172c414752354c927dc0f683157ac009500',
  '0xc0ba5b9a820688d8898770d2f45db1e829785cb69882e5bb2981fdd22d60f900',
  '0x155c219135942fbe253879a75d7b29fe22563c8a767fff8bfb3bf08229d5ac00',
  '0x88f619eb35d79dd51bdbedb0638479d77479fa6ca039bb2a23ffdf42c8e30900',
  '0x167d628abbc681171e3e4d784cf450a7f9bb9f4668795474376d3b21d0ade300',
  '0x167d628abbc681171e3e4d784cf450a7f9bb9f4668795474376d3b21d0ade301',
  '0x167d628abbc681171e3e4d784cf450a7f9bb9f4668795474376d3b21d0ade302',
  '0x8d3f81a63425a80ad14eecea6638e8ea6f5d633c24e2865dd2228e2b62dc9100',
  '0x44eb866201f22832539d72320900218d04c7d97cfb8ebacf9a6d65c395e5e700',
  '0x930ab19e093b9d470c1f7056ddf51dcaf1bdf62558a355b33b78972be23e2500',
  '0x3bf57dcdaf5f1e5afff95a10b7216bcff83f9e35b273e271675d9ef0c0621100',
] as const;
const ISSUER_ROLE =
  '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f' as Hex;
const ABSENT_ROLES = [
  'Agent',
  'Cap',
  'ControlList',
  'TrexOwner',
  'Pauser',
  'AdjustmentBalance',
  'Controller',
  'ProtectedPartitions',
  'Snapshot',
  'CorporateAction',
].map((name) => keccak256(toBytes(`asset.tokenization.standard.role.${name}`)));

function matches(condition: unknown): asserts condition {
  if (!condition) throw new AtsBackendError('mismatch');
}
function observedAddress(input: unknown): Address {
  matches(typeof input === 'string' && isAddress(input));
  return getAddress(input);
}
function observedRecord(input: unknown): Record<string, unknown> {
  matches(input !== null && typeof input === 'object' && !Array.isArray(input));
  return input as Record<string, unknown>;
}
function sameSet(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}
async function each<T>(
  values: readonly T[],
  work: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(6, values.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= values.length) return;
        try {
          await work(values[index]);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  // A rejected check stops the queue and drains already-started reads before
  // returning, so a retry cannot overlap an abandoned verification workload.
  if (failed) throw failure;
}

/** Verify current admitted topology at one block. Does not certify canonical
 * source from arbitrary hashes, mapping-wide emptiness, physical backing, or
 * historical transfer rules. The root client separately binds chain/Gate rights.
 */
export async function verifyAtsBackend(
  reader: AtsBackendReader,
  backend: AtsBackend,
  context: { token: Address; gate: Address; blockNumber: bigint },
): Promise<void> {
  const b = parseAtsBackend(backend);
  try {
    const token = address(context.token);
    const gate = address(context.gate);
    const blockNumber = context.blockNumber;
    const createdAt = BigInt(b.admission.blockNumber);
    matches(typeof blockNumber === 'bigint' && blockNumber >= createdAt);
    const allPins = [
      b.adapter,
      b.resolver,
      b.initializer,
      ...Object.values(b.facets),
      ...Object.values(b.libraries),
    ];
    matches(
      new Set([token, gate, ...allPins.map((pin) => pin.address)]).size ===
        allPins.length + 2,
    );
    const snapshot = await reader.getBlock({ blockNumber });
    if (!snapshot.hash || snapshot.number !== blockNumber)
      throw new AtsBackendError('unavailable');
    const read = (
      target: Address,
      functionName: string,
      args: readonly unknown[] = [],
    ) =>
      reader.readContract({
        address: target,
        abi: ATS_VERIFICATION_ABI as Abi,
        functionName,
        args,
        blockNumber,
      });
    const storage = async (target: Address, slot: Hex): Promise<Hex> => {
      const value = await reader.getStorageAt({
        address: target,
        slot,
        blockNumber,
      });
      if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
        throw new AtsBackendError('unavailable');
      return value.toLowerCase() as Hex;
    };
    const codes = new Map<Address, Hex>();
    await each(
      [{ address: token, codeHash: b.tokenCodeHash }, ...allPins],
      async (pin) => {
        const code = await reader.getCode({
          address: pin.address,
          blockNumber,
        });
        matches(code && code !== '0x' && keccak256(code) === pin.codeHash);
        codes.set(pin.address, code);
      },
    );
    const named = { ...b.facets, ...b.libraries };
    for (const link of ATS_RUNTIME_LINKS) {
      const code = codes.get(named[link.owner].address)!;
      const embedded = `0x${code.slice(2 + link.offset * 2, 2 + (link.offset + 20) * 2)}`;
      matches(
        embedded.length === 42 &&
          observedAddress(embedded) === b.libraries[link.library].address,
      );
    }
    // Every queued check performs one RPC read. Flatten independent reads into
    // one six-call queue; nested per-facet or per-role pools multiply traffic.
    const checks: Array<() => Promise<void>> = [];
    for (const [offset, expected] of [
      BigInt(b.resolver.address),
      BigInt(b.configuration.id),
      1n,
    ].entries())
      checks.push(async () =>
        matches(
          BigInt(
            await storage(
              token,
              toHex(BigInt(PROXY_SLOT) + BigInt(offset), { size: 32 }),
            ),
          ) === expected,
        ),
      );
    for (const slot of ZERO_TOKEN_SLOTS)
      checks.push(async () =>
        matches((await storage(token, slot)) === zeroHash),
      );
    for (const slot of [...OVERRIDE_SLOTS, ZERO_TOKEN_SLOTS[17]])
      checks.push(async () =>
        matches((await storage(b.resolver.address, slot)) === zeroHash),
      );

    const scalarChecks: Array<[Address, string, readonly unknown[], unknown]> =
      [
        [b.adapter.address, 'gate', [], gate],
        [b.adapter.address, 'token', [], token],
        [b.adapter.address, 'initializer', [], b.initializer.address],
        [b.adapter.address, 'tokenCodeHash', [], b.tokenCodeHash],
        [b.initializer.address, 'token', [], token],
        [b.initializer.address, 'adapter', [], b.adapter.address],
        [b.initializer.address, 'resolver', [], b.resolver.address],
        [b.initializer.address, 'CONFIGURATION', [], b.configuration.id],
        [
          b.resolver.address,
          'getOwner',
          [b.configuration.id],
          b.initializer.address,
        ],
        [
          b.resolver.address,
          'getPendingOwner',
          [b.configuration.id],
          zeroAddress,
        ],
        [
          b.resolver.address,
          'getLatestVersionByConfiguration',
          [b.configuration.id],
          1n,
        ],
        [
          b.resolver.address,
          'isResolverProxyConfigurationRegistered',
          [b.configuration.id, 1n],
          true,
        ],
        [
          b.resolver.address,
          'getFacetsLengthByConfigurationIdAndVersion',
          [b.configuration.id, 1n],
          10n,
        ],
        [token, 'getOperationalStatus', [b.configuration.id, 1n], 1n],
        [token, 'getMaxInitializerFacetIndex', [], 10n],
        [token, 'decimals', [], 3],
        [token, 'isMultiPartition', [], false],
        [token, 'isIssuable', [], true],
        [token, 'getMaxSupply', [], BigInt(b.maxSupply)],
        [token, 'getControlListType', [], false],
        [token, 'getControlListCount', [], 0n],
        [token, 'getRoleCountFor', [b.initializer.address], 1n],
        [token, 'getRoleCountFor', [b.adapter.address], 1n],
        [b.resolver.address, 'getRoleCountFor', [b.initializer.address], 1n],
      ];
    for (const [target, name, args, expected] of scalarChecks)
      checks.push(async () => {
        const actual = await read(target, name, args);
        matches(
          typeof expected === 'string' && isAddress(expected)
            ? observedAddress(actual) === getAddress(expected)
            : actual === expected,
        );
      });
    checks.push(
      async () => {
        const supply = await read(token, 'totalSupply');
        matches(
          typeof supply === 'bigint' &&
            supply >= 0n &&
            supply <= BigInt(b.maxSupply),
        );
      },
      async () => {
        const metadata = observedRecord(await read(token, 'getERC20Metadata'));
        const info = observedRecord(metadata.info);
        matches(
          metadata.securityType === 5 &&
            info.decimals === 3 &&
            info.isin === '',
        );
      },
      async () =>
        matches(
          sameSet(
            await read(b.resolver.address, 'getSelectorsBlacklist', [
              b.configuration.id,
              0n,
              1n,
            ]),
            [],
          ),
        ),
    );

    const expectedPins = [
      ...Object.values(b.facets),
      ...Object.values(b.libraries),
      b.resolver,
    ];
    checks.push(async () => {
      const enrolled = await read(b.adapter.address, 'getRuntimePins');
      matches(
        Array.isArray(enrolled) && enrolled.length === expectedPins.length,
      );
      enrolled.forEach((entry, index) => {
        const pin = observedRecord(entry);
        matches(
          observedAddress(pin.target) === expectedPins[index].address &&
            pin.codeHash === expectedPins[index].codeHash,
        );
      });
    });
    const members = (target: Address, role: Hex, expected: Address[]) => {
      checks.push(
        async () =>
          matches(
            (await read(target, 'getRoleMemberCount', [role])) ===
              BigInt(expected.length),
          ),
        async () => {
          // The bounded page derives from the admitted expectation, not the
          // observed count, so these two reads have no ordering dependency.
          const accounts = await read(target, 'getRoleMembers', [
            role,
            0n,
            BigInt(expected.length + 1),
          ]);
          matches(
            Array.isArray(accounts) &&
              sameSet(accounts.map(observedAddress), expected),
          );
        },
      );
    };
    members(token, zeroHash, [b.initializer.address]);
    members(token, ISSUER_ROLE, [b.adapter.address]);
    members(b.resolver.address, zeroHash, [b.initializer.address]);
    for (const role of ABSENT_ROLES) {
      members(token, role, []);
      members(b.resolver.address, role, []);
    }
    members(b.resolver.address, ISSUER_ROLE, []);
    // RoleData.roleAdmin is the first word of the role-keyed mapping value.
    // This checks a known scalar value, not emptiness of an arbitrary mapping.
    for (const role of [zeroHash, ISSUER_ROLE, ...ABSENT_ROLES]) {
      const slot = keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }],
          [role, ACCESS_CONTROL_SLOT],
        ),
      );
      for (const target of [token, b.resolver.address])
        checks.push(async () =>
          matches((await storage(target, slot)) === zeroHash),
        );
    }

    const [facets, versions] = await Promise.all([
      read(b.resolver.address, 'getFacetsByConfigurationIdAndVersion', [
        b.configuration.id,
        1n,
        0n,
        11n,
      ]),
      read(
        b.resolver.address,
        'getFacetConfigurationsByConfigurationIdAndVersion',
        [b.configuration.id, 1n, 0n, 11n],
      ),
    ]);
    matches(
      Array.isArray(facets) &&
        facets.length === 10 &&
        Array.isArray(versions) &&
        versions.length === 10,
    );
    const expectedNames = Object.keys(ATS_FACET_PROFILE) as AtsFacetName[];
    const seen = new Set<string>();
    for (const name of expectedNames) {
      const expected = ATS_FACET_PROFILE[name];
      const entry = facets
        .map(observedRecord)
        .find((facet) => facet.id === expected.key);
      const version = versions
        .map(observedRecord)
        .find((facet) => facet.id === expected.key);
      matches(entry && version && !seen.has(expected.key));
      seen.add(expected.key);
      matches(
        observedAddress(entry.addr) === b.facets[name].address &&
          sameSet(entry.selectors, expected.selectors) &&
          version.version === 1n,
      );
      checks.push(
        async () =>
          matches(
            (await read(b.facets[name].address, 'getStaticResolverKey')) ===
              expected.key,
          ),
        async () =>
          matches(
            sameSet(
              await read(b.facets[name].address, 'getStaticFunctionSelectors'),
              expected.selectors,
            ),
          ),
        async () =>
          matches(
            (await read(token, 'getFacetLastVersion', [expected.key])) === 1n,
          ),
        async () =>
          matches(
            (await read(token, 'getFacetVersionStatus', [expected.key, 1n])) ===
              1n,
          ),
      );
      for (const selector of expected.selectors)
        checks.push(async () =>
          matches(
            observedAddress(
              await read(b.resolver.address, 'resolveResolverProxyCall', [
                b.configuration.id,
                1n,
                selector,
              ]),
            ) === b.facets[name].address,
          ),
        );
    }
    await each(checks, (check) => check());

    // A matching current proxy hash cannot establish a clean creation history.
    // Bind an independently reviewed direct initializer-creation transaction, and
    // reject inherited/migrated addresses. Mapping-wide freshness remains an
    // external reviewed-constructor/source property, not an RPC scalar proof.
    const [creationBlock, transaction, receipt] = await Promise.all([
      reader.getBlock({ blockNumber: createdAt }),
      reader.getTransaction({ hash: b.admission.transactionHash }),
      reader.getTransactionReceipt({ hash: b.admission.transactionHash }),
    ]);
    matches(
      creationBlock.hash === b.admission.blockHash &&
        creationBlock.number === createdAt,
    );
    matches(
      transaction.hash === b.admission.transactionHash &&
        transaction.to === null &&
        transaction.blockHash === b.admission.blockHash &&
        transaction.blockNumber === createdAt &&
        keccak256(transaction.input) === b.admission.transactionInputHash,
    );
    matches(
      receipt.transactionHash === b.admission.transactionHash &&
        receipt.status === 'success' &&
        receipt.blockHash === b.admission.blockHash &&
        receipt.blockNumber === createdAt &&
        receipt.contractAddress !== null &&
        observedAddress(receipt.contractAddress) === b.initializer.address,
    );
    await each(
      [token, b.adapter.address, b.resolver.address, b.initializer.address],
      async (target) => {
        const before = await reader.getCode({
          address: target,
          blockNumber: createdAt - 1n,
        });
        matches(before === undefined || before === '0x');
        const initial = await reader.getCode({
          address: target,
          blockNumber: createdAt,
        });
        matches(initial && initial === codes.get(target));
      },
    );
    const [stillCurrent, stillCreated] = await Promise.all([
      reader.getBlock({ blockNumber }),
      reader.getBlock({ blockNumber: createdAt }),
    ]);
    if (
      stillCurrent.hash !== snapshot.hash ||
      stillCreated.hash !== creationBlock.hash
    )
      throw new AtsBackendError('unavailable');
  } catch (error) {
    if (error instanceof AtsBackendError) throw error;
    throw new AtsBackendError('unavailable');
  }
}
