import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { parseDuplicateFreeJson } from '../../../../../packages/domain/src/index.js';
import { parseDeploymentConfig } from '../../../../../packages/issuance/src/index.js';
import { parseBrowserRpcUrl } from '../browser-rpc';
import type { TrustSnapshot } from './institution-client';

export const IDENTITY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
]);
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MAX_METADATA_BYTES = 16 * 1024;
const REGISTRATION_TYPE =
  'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
class DiscoveryError extends Error {}

/** Only messages authored by this module are suitable for the public page. */
export function discoveryErrorMessage(cause: unknown): string {
  return cause instanceof DiscoveryError
    ? cause.message
    : 'Service records could not be checked. Refresh chain state to try again.';
}

type Role = 'issuer' | 'deployment' | 'auditor';
type Entry = Readonly<{
  role: Role;
  agentId: string;
  owner: Address;
  wallet: Address;
  metadataHash: Hex;
}>;
type Registry = Readonly<{
  address: Address;
  proxyCodeHash: Hex;
  implementation: Address;
  implementationCodeHash: Hex;
  owner: Address;
}>;
export type DiscoveryIndex = Readonly<{
  format: 'ultratokenizer.discovery.v1';
  chainId: string;
  gate: Address;
  issuerId: Hex;
  identityRegistry: Registry;
  entries: readonly Entry[];
}>;

function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new DiscoveryError('Invalid discovery record.');
  if (
    keys &&
    (Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key)))
  )
    throw new DiscoveryError('Unsupported discovery fields.');
  return value as Record<string, unknown>;
}
function address(value: unknown): Address {
  if (typeof value !== 'string')
    throw new DiscoveryError('Invalid discovery address.');
  const result = getAddress(value);
  if (result === zeroAddress)
    throw new DiscoveryError('Missing discovery address.');
  return result;
}
function hash(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    /^0x0+$/.test(value)
  )
    throw new DiscoveryError('Invalid discovery hash.');
  return value.toLowerCase() as Hex;
}
function integer(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n
  )
    throw new DiscoveryError('Invalid discovery identifier.');
  return value;
}

export function parseDiscoveryIndex(
  text: string,
  deploymentValue: unknown,
): DiscoveryIndex {
  const deployment = parseDeploymentConfig(deploymentValue);
  const value = record(parseDuplicateFreeJson(text, 32 * 1024), [
    'format',
    'chainId',
    'gate',
    'issuerId',
    'identityRegistry',
    'entries',
  ]);
  if (
    value.format !== 'ultratokenizer.discovery.v1' ||
    value.chainId !== deployment.auditPolicy.chainId ||
    address(value.gate) !== deployment.auditPolicy.gate ||
    hash(value.issuerId) !== deployment.auditPolicy.issuerId
  )
    throw new DiscoveryError('Discovery index belongs to another deployment.');
  const registry = record(value.identityRegistry, [
    'address',
    'proxyCodeHash',
    'implementation',
    'implementationCodeHash',
    'owner',
  ]);
  if (
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 3
  )
    throw new DiscoveryError('Discovery needs one to three role records.');
  const entries = value.entries.map((input) => {
    const item = record(input, [
      'role',
      'agentId',
      'owner',
      'wallet',
      'metadataHash',
    ]);
    if (!['issuer', 'deployment', 'auditor'].includes(String(item.role)))
      throw new DiscoveryError('Unsupported discovery role.');
    return Object.freeze({
      role: item.role as Role,
      agentId: integer(item.agentId),
      owner: address(item.owner),
      wallet: address(item.wallet),
      metadataHash: hash(item.metadataHash),
    });
  });
  if (
    new Set(entries.map((entry) => entry.role)).size !== entries.length ||
    new Set(entries.map((entry) => entry.agentId)).size !== entries.length
  )
    throw new DiscoveryError('Duplicate discovery role or agent ID.');
  return Object.freeze({
    format: value.format,
    chainId: deployment.auditPolicy.chainId,
    gate: deployment.auditPolicy.gate,
    issuerId: deployment.auditPolicy.issuerId,
    identityRegistry: Object.freeze({
      address: address(registry.address),
      proxyCodeHash: hash(registry.proxyCodeHash),
      implementation: address(registry.implementation),
      implementationCodeHash: hash(registry.implementationCodeHash),
      owner: address(registry.owner),
    }),
    entries: Object.freeze(entries),
  });
}

/** Read data only. Registry-provided HTTP, IPFS, SVG and service URLs are never fetched or rendered. */
export function decodeRegistration(uri: string, expectedHash: Hex) {
  const prefix = 'data:application/json;base64,';
  if (
    typeof uri !== 'string' ||
    !uri.startsWith(prefix) ||
    uri.length > prefix.length + 4 * Math.ceil(MAX_METADATA_BYTES / 3)
  )
    throw new DiscoveryError(
      'Discovery metadata must be a bounded JSON data URI.',
    );
  const encoded = uri.slice(prefix.length);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new DiscoveryError('Invalid metadata encoding.');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    !bytes.length ||
    bytes.length > MAX_METADATA_BYTES ||
    keccak256(toHex(bytes)) !== expectedHash
  )
    throw new DiscoveryError(
      'Discovery metadata changed from the reviewed artifact.',
    );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const metadata = record(parseDuplicateFreeJson(text, MAX_METADATA_BYTES));
  if (
    metadata.type !== REGISTRATION_TYPE ||
    typeof metadata.name !== 'string' ||
    !metadata.name.trim() ||
    metadata.name.length > 160
  )
    throw new DiscoveryError('Unsupported registration metadata.');
  return { text, metadata, name: metadata.name };
}

function compareDossier(
  metadata: Record<string, unknown>,
  entry: Entry,
  index: DiscoveryIndex,
  snapshot: TrustSnapshot,
) {
  const dossier = record(metadata.ultratokenizer);
  if (
    dossier.format !== 'ultratokenizer.discovery-dossier.v1' ||
    dossier.role !== entry.role ||
    dossier.chainId !== index.chainId ||
    address(dossier.gate) !== index.gate ||
    hash(dossier.issuerId) !== index.issuerId ||
    dossier.gateIsSoleMintAuthority !== true ||
    dossier.registryAssertionsAuthorizeIssuance !== false
  )
    throw new DiscoveryError(
      'The service declaration does not match this Gate and role.',
    );
  if (
    !Array.isArray(metadata.registrations) ||
    metadata.registrations.length > 20 ||
    !metadata.registrations.some((value) => {
      const registration = record(value);
      const id =
        typeof registration.agentId === 'number' &&
        Number.isSafeInteger(registration.agentId)
          ? String(registration.agentId)
          : registration.agentId;
      if (
        id !== entry.agentId ||
        typeof registration.agentRegistry !== 'string'
      )
        return false;
      const parts = registration.agentRegistry.split(':');
      return (
        parts.length === 3 &&
        parts[0] === 'eip155' &&
        parts[1] === index.chainId &&
        address(parts[2]) === index.identityRegistry.address
      );
    })
  )
    throw new DiscoveryError(
      'The declaration is missing its actual registry tuple.',
    );
  if (
    hash(dossier.gateRuntimeHash) !== snapshot.gateCodeHash ||
    hash(dossier.sourceId) !== snapshot.source.id
  )
    throw new DiscoveryError(
      'The declared Gate runtime or source differs from the current Gate.',
    );
  if (dossier.policyVersion !== snapshot.policyVersion)
    throw new DiscoveryError(
      'The declared policy version differs from this deployment.',
    );
  if (dossier.rightsVersion !== snapshot.rightsVersion)
    throw new DiscoveryError(
      'The declared rights version differs from this deployment.',
    );
  if (entry.role === 'issuer') {
    if (
      entry.wallet !== snapshot.issuer.signer ||
      address(dossier.proposedPermitSigner) !== snapshot.issuer.signer
    )
      throw new DiscoveryError(
        'The service wallet is not the current Gate permit signer.',
      );
  } else if (entry.role === 'deployment') {
    const program = record(dossier.candidateProgram);
    if (
      hash(program.programVKey) !== snapshot.program.vkey ||
      address(program.verifierAddress) !==
        getAddress(snapshot.program.verifier) ||
      hash(program.verifierRuntimeHash) !== snapshot.program.codeHash ||
      program.profileVersion !== String(snapshot.program.profile)
    )
      throw new DiscoveryError(
        'The declared program differs from the current Gate.',
      );
  } else if (
    address(dossier.reviewerAddress) !== entry.wallet ||
    dossier.auditPolicyFormat !== 'ultratokenizer.audit-policy.v1' ||
    dossier.auditReportFormat !== 'ultratokenizer.audit-report.v2'
  )
    throw new DiscoveryError(
      'The declared audit role differs from its wallet or supported formats.',
    );
}

export async function readDiscovery(
  text: string,
  deploymentValue: unknown,
  snapshot: TrustSnapshot,
) {
  const deployment = parseDeploymentConfig(deploymentValue);
  const index = parseDiscoveryIndex(text, deployment);
  if (
    snapshot.chainId !== index.chainId ||
    snapshot.gate !== index.gate ||
    snapshot.issuerId !== index.issuerId ||
    snapshot.gateCodeHash !== deployment.gateCodeHash
  )
    throw new DiscoveryError(
      'The Gate observation belongs to another deployment.',
    );
  const registry = index.identityRegistry;
  const reader = createPublicClient({
    transport: http(parseBrowserRpcUrl(deployment.rpcUrl), {
      timeout: 20_000,
      retryCount: 0,
    }),
  });
  const blockNumber = BigInt(snapshot.blockNumber);
  const at = { address: registry.address, abi: IDENTITY_ABI, blockNumber };
  const [chain, proxyCode, implementationCode, implementationSlot, owner] =
    await Promise.all([
      reader.getChainId(),
      reader.getCode({ address: registry.address, blockNumber }),
      reader.getCode({ address: registry.implementation, blockNumber }),
      reader.getStorageAt({
        address: registry.address,
        slot: IMPLEMENTATION_SLOT,
        blockNumber,
      }),
      reader.readContract({ ...at, functionName: 'owner' }),
    ]);
  if (
    String(chain) !== index.chainId ||
    !proxyCode ||
    proxyCode === '0x' ||
    !implementationCode ||
    implementationCode === '0x' ||
    !implementationSlot ||
    !/^0x0{24}[0-9a-fA-F]{40}$/.test(implementationSlot) ||
    keccak256(proxyCode) !== registry.proxyCodeHash ||
    keccak256(implementationCode) !== registry.implementationCodeHash ||
    getAddress(`0x${implementationSlot.slice(-40)}`) !==
      registry.implementation ||
    getAddress(owner) !== registry.owner
  )
    throw new DiscoveryError(
      'The discovery registry or its ownership changed from the reviewed pins.',
    );
  // Read one role at a time to avoid saturating public RPC metadata reads.
  // At most three roles require five bounded RPC stages in total.
  const entries = [];
  for (const entry of index.entries) {
    const [owner, wallet, uri] = await Promise.all([
      reader.readContract({
        ...at,
        functionName: 'ownerOf',
        args: [BigInt(entry.agentId)],
      }),
      reader.readContract({
        ...at,
        functionName: 'getAgentWallet',
        args: [BigInt(entry.agentId)],
      }),
      reader.readContract({
        ...at,
        functionName: 'tokenURI',
        args: [BigInt(entry.agentId)],
      }),
    ]);
    if (
      getAddress(owner) !== entry.owner ||
      getAddress(wallet) !== entry.wallet
    )
      throw new DiscoveryError(
        `The ${entry.role} record was transferred or its wallet changed.`,
      );
    const decoded = decodeRegistration(uri, entry.metadataHash);
    compareDossier(decoded.metadata, entry, index, snapshot);
    entries.push(
      Object.freeze({
        ...entry,
        name: decoded.name,
        metadataText: decoded.text,
      }),
    );
  }
  const [canonical, finalChain] = await Promise.all([
    reader.getBlock({ blockNumber }),
    reader.getChainId(),
  ]);
  if (
    canonical.hash !== snapshot.blockHash ||
    String(finalChain) !== index.chainId
  )
    throw new DiscoveryError(
      'The discovery observation is no longer canonical.',
    );
  return Object.freeze({
    format: 'ultratokenizer.discovery-observation.v1',
    assurance: 'configured-rpc-current-attribution',
    chainId: index.chainId,
    gate: index.gate,
    issuerId: index.issuerId,
    identityRegistry: registry,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    entries,
  });
}
export type DiscoveryObservation = Awaited<ReturnType<typeof readDiscovery>>;
