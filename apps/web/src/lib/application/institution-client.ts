import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { createChainContext } from '../../../../../packages/issuance/src/chain.js';
import {
  ISSUANCE_GATE_ABI,
  IssuanceClientError,
  parseDeploymentConfig,
  DEPLOYMENT_V2_FORMAT,
  type DeploymentConfig,
} from '../../../../../packages/issuance/src/index.js';
import { parseBrowserRpcUrl } from '../browser-rpc';

export const GOVERNOR_ABI = parseAbi([
  'function governor() view returns (address)',
  'function setPaused(bool value)',
  'function setBackingCap(bytes32 issuerId,address token,uint256 cap)',
  'function registerIssuerKey(bytes32 issuerId,uint64 version,address signer,uint64 validUntil)',
]);

/** Current state under the configured RPC. This does not authenticate its own trust root. */
export async function readTrustSnapshot(value: unknown) {
  const deployment = parseDeploymentConfig(value);
  const policy = deployment.auditPolicy;
  const ats =
    deployment.format === DEPLOYMENT_V2_FORMAT &&
    deployment.backend.kind === 'ats'
      ? deployment.backend
      : undefined;
  const reader = createPublicClient({
    transport: http(parseBrowserRpcUrl(deployment.rpcUrl), {
      timeout: 10_000,
      retryCount: 0,
    }),
  });
  if (String(await reader.getChainId()) !== policy.chainId)
    throw new IssuanceClientError('wrong_chain');
  const block = await reader.getBlock();
  const at = {
    address: policy.gate,
    abi: ISSUANCE_GATE_ABI,
    blockNumber: block.number,
  };
  const [
    gateCode,
    verifierCode,
    governor,
    paused,
    issuer,
    selected,
    rights,
    pool,
  ] = await Promise.all([
    reader.getCode({ address: policy.gate, blockNumber: block.number }),
    reader.getCode({
      address: policy.verifierAddress,
      blockNumber: block.number,
    }),
    reader.readContract({ ...at, abi: GOVERNOR_ABI, functionName: 'governor' }),
    reader.readContract({ ...at, functionName: 'paused' }),
    reader.readContract({
      ...at,
      functionName: 'issuerKeys',
      args: [policy.issuerId, BigInt(policy.issuerKeyVersion)],
    }),
    reader.readContract({
      ...at,
      functionName: 'policies',
      args: [policy.issuerId, BigInt(policy.policyVersion)],
    }),
    reader.readContract({
      ...at,
      functionName: 'rights',
      args: [policy.issuerId, BigInt(policy.rightsVersion)],
    }),
    reader.readContract({
      ...at,
      functionName: 'backingPools',
      args: [policy.issuerId, policy.token],
    }),
  ]);
  if (
    !gateCode ||
    gateCode === '0x' ||
    !verifierCode ||
    verifierCode === '0x' ||
    keccak256(gateCode) !== deployment.gateCodeHash ||
    keccak256(verifierCode) !== policy.verifierCodeHash
  )
    throw new IssuanceClientError('deployment_mismatch');
  const [program, source, adapterCode] = await Promise.all([
    reader.readContract({
      ...at,
      functionName: 'programs',
      args: [selected[0]],
    }),
    reader.readContract({
      ...at,
      functionName: 'sourceKeys',
      args: [selected[1], selected[2]],
    }),
    reader.getCode({ address: rights[1], blockNumber: block.number }),
  ]);
  const matches = {
    issuer: getAddress(issuer[0]) === policy.issuerAddress,
    program:
      getAddress(program[0]) === policy.verifierAddress &&
      program[1] === policy.verifierCodeHash &&
      program[2] === policy.programVKey &&
      String(program[3]) === policy.profileVersion,
    source:
      selected[1] === policy.sourceId &&
      source[0] === policy.sourceSignerFingerprint,
    rights:
      getAddress(rights[0]) === policy.token &&
      rights[1] !== zeroAddress &&
      !!adapterCode &&
      adapterCode !== '0x' &&
      keccak256(adapterCode) === rights[2] &&
      (!ats ||
        (getAddress(rights[1]) === ats.adapter.address &&
          rights[2] === ats.adapter.codeHash)),
  };
  const [canonical, chainId] = await Promise.all([
    reader.getBlock({ blockNumber: block.number }),
    reader.getChainId(),
  ]);
  if (
    !block.hash ||
    canonical.hash !== block.hash ||
    String(chainId) !== policy.chainId
  )
    throw new IssuanceClientError('transaction_uncertain');
  return Object.freeze({
    chainId: policy.chainId,
    gate: policy.gate,
    gateCodeHash: deployment.gateCodeHash,
    issuerId: policy.issuerId,
    policyVersion: policy.policyVersion,
    rightsVersion: policy.rightsVersion,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    timestamp: block.timestamp.toString(),
    governor: getAddress(governor),
    paused,
    issuer: {
      signer: getAddress(issuer[0]),
      validUntil: issuer[1].toString(),
      revoked: issuer[2],
    },
    program: {
      version: selected[0].toString(),
      verifier: program[0],
      codeHash: program[1],
      vkey: program[2],
      profile: program[3],
      revoked: program[4],
    },
    source: {
      id: selected[1],
      version: selected[2].toString(),
      fingerprint: source[0],
      revoked: source[1],
    },
    policy: { termsHash: selected[3], revoked: selected[4] },
    rights: {
      token: rights[0],
      adapter: rights[1],
      adapterCodeHash: rights[2],
      termsHash: rights[3],
      revoked: rights[4],
    },
    pool: {
      cap: pool[0].toString(),
      pending: pool[1].toString(),
      outstanding: pool[2].toString(),
    },
    matches,
    active:
      Object.values(matches).every(Boolean) &&
      !paused &&
      !issuer[2] &&
      issuer[1] > block.timestamp &&
      !program[4] &&
      !source[1] &&
      !selected[4] &&
      !rights[4],
  });
}
export type TrustSnapshot = Awaited<ReturnType<typeof readTrustSnapshot>>;

export function formatUtcTime(seconds: string) {
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : `${seconds} Unix seconds`;
}

export type AuthorityAction =
  | Readonly<{ kind: 'pause'; paused: boolean }>
  | Readonly<{ kind: 'cap'; milligrams: string }>
  | Readonly<{ kind: 'admit-issuer'; validUntil: string }>;
export type AuthorityIntent = Readonly<{
  action: AuthorityAction;
  account: Address;
  nonce: number;
}>;

export function authorityCall(
  deployment: DeploymentConfig,
  action: AuthorityAction,
) {
  const policy = deployment.auditPolicy;
  if (action.kind === 'pause' && typeof action.paused === 'boolean')
    return { functionName: 'setPaused', args: [action.paused] } as const;
  if (
    action.kind === 'cap' &&
    /^(0|[1-9][0-9]{0,18})$/.test(action.milligrams) &&
    BigInt(action.milligrams) <= 9223372036854775807n
  )
    return {
      functionName: 'setBackingCap',
      args: [policy.issuerId, policy.token, BigInt(action.milligrams)],
    } as const;
  if (
    action.kind === 'admit-issuer' &&
    /^[1-9][0-9]{0,19}$/.test(action.validUntil) &&
    BigInt(action.validUntil) < 1n << 64n
  )
    return {
      functionName: 'registerIssuerKey',
      args: [
        policy.issuerId,
        BigInt(policy.issuerKeyVersion),
        policy.issuerAddress,
        BigInt(action.validUntil),
      ],
    } as const;
  throw new Error(
    'Invalid authority action. Use an exact amount or future expiry.',
  );
}

/** Deliberately limited to the configured issuer. New source/program/rights onboarding uses deployment tooling. */
export function createAuthorityClient(input: {
  provider: EIP1193Provider;
  deployment: unknown;
}) {
  const context = createChainContext(input);
  const { deployment, policy, reader } = context;
  const call = (action: AuthorityAction) => ({
    address: policy.gate,
    abi: GOVERNOR_ABI,
    ...authorityCall(deployment, action),
  });
  async function simulate(action: AuthorityAction, account: Address) {
    const operation = call(action);
    if (operation.functionName === 'setPaused')
      return reader.simulateContract({ ...operation, account });
    if (operation.functionName === 'setBackingCap')
      return reader.simulateContract({ ...operation, account });
    return reader.simulateContract({ ...operation, account });
  }
  async function authority() {
    const governor = await reader.readContract({
      address: policy.gate,
      abi: GOVERNOR_ABI,
      functionName: 'governor',
    });
    return context.activeAccount(getAddress(governor));
  }
  return {
    async prepare(action: AuthorityAction): Promise<AuthorityIntent> {
      return context.preflight(async () => {
        call(action);
        const account = await authority();
        const nonce = await reader.getTransactionCount({
          address: account,
          blockTag: 'pending',
        });
        await simulate(action, account);
        return Object.freeze({
          action: Object.freeze({ ...action }),
          account,
          nonce,
        });
      });
    },
    async send(intent: AuthorityIntent) {
      const simulated = await context.preflight(async () => {
        const account = await authority();
        if (
          getAddress(intent.account) !== getAddress(account) ||
          (await reader.getTransactionCount({
            address: account,
            blockTag: 'pending',
          })) !== intent.nonce
        )
          throw new IssuanceClientError('stale_token_intent');
        const result = await simulate(intent.action, account);
        await authority();
        return result;
      });
      return context.send((wallet) =>
        wallet.sendTransaction({
          account: intent.account,
          to: policy.gate,
          data: encodeFunctionData(call(intent.action)),
          nonce: intent.nonce,
          gas: simulated.request.gas,
        }),
      );
    },
    async wait(intent: AuthorityIntent, hash: Hex) {
      const receipt = await context.canonicalReceipt(hash);
      const transaction = await reader.getTransaction({ hash });
      const code = await reader.getCode({
        address: policy.gate,
        blockNumber: receipt.blockNumber,
      });
      if (
        !code ||
        keccak256(code) !== deployment.gateCodeHash ||
        transaction.blockHash !== receipt.blockHash ||
        transaction.blockNumber !== receipt.blockNumber ||
        transaction.hash !== hash ||
        !transaction.to ||
        !receipt.to ||
        getAddress(receipt.to) !== policy.gate ||
        getAddress(receipt.from) !== getAddress(intent.account) ||
        getAddress(transaction.to) !== policy.gate ||
        getAddress(transaction.from) !== getAddress(intent.account) ||
        transaction.nonce !== intent.nonce ||
        transaction.value !== 0n ||
        transaction.input !== encodeFunctionData(call(intent.action))
      )
        throw new IssuanceClientError('issuance_mismatch');
      await context.assertCanonical({
        number: receipt.blockNumber,
        hash: receipt.blockHash,
      });
      return {
        transactionHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        status: receipt.status,
      };
    },
  };
}
