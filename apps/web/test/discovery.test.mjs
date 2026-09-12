import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toHex,
} from 'viem';
import { loadModule } from './helpers.mjs';

const { parseDiscoveryIndex, decodeRegistration, readDiscovery, IDENTITY_ABI } =
  await loadModule('../src/lib/application/discovery.ts');
const { fetchHostedDiscovery } = await loadModule(
  '../src/lib/application/hosted-deployment.ts',
);
const { createFixture } = await loadModule('./fixtures/issuance.ts');

async function harness(t) {
  const fixture = await createFixture();
  const policy = fixture.policy;
  const registry = {
    address: '0x7777777777777777777777777777777777777777',
    proxyCodeHash: keccak256('0x60006000'),
    implementation: '0x8888888888888888888888888888888888888888',
    implementationCodeHash: keccak256('0x60016000'),
    owner: fixture.bundle.request.recipient,
  };
  const snapshot = {
    chainId: '296',
    gate: policy.gate,
    gateCodeHash: fixture.deployment.gateCodeHash,
    issuerId: policy.issuerId,
    policyVersion: '1',
    rightsVersion: '1',
    blockNumber: '100',
    blockHash: `0x${'aa'.repeat(32)}`,
    source: { id: policy.sourceId },
    issuer: { signer: policy.issuerAddress },
    program: {
      vkey: policy.programVKey,
      verifier: policy.verifierAddress,
      codeHash: policy.verifierCodeHash,
      profile: 2,
    },
  };
  const metadata = ['issuer', 'deployment', 'auditor'].map((role, offset) => ({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: `Synthetic ${role} service`,
    registrations: [
      { agentId: offset + 1, agentRegistry: `eip155:296:${registry.address}` },
    ],
    ultratokenizer: {
      format: 'ultratokenizer.discovery-dossier.v1',
      role,
      chainId: '296',
      gate: policy.gate,
      gateRuntimeHash: fixture.deployment.gateCodeHash,
      sourceId: policy.sourceId,
      issuerId: policy.issuerId,
      policyVersion: '1',
      rightsVersion: '1',
      gateIsSoleMintAuthority: true,
      registryAssertionsAuthorizeIssuance: false,
      ...(role === 'issuer'
        ? { proposedPermitSigner: policy.issuerAddress }
        : role === 'deployment'
          ? {
              candidateProgram: {
                programVKey: policy.programVKey,
                verifierAddress: policy.verifierAddress,
                verifierRuntimeHash: policy.verifierCodeHash,
                profileVersion: '2',
                outerCircuitVersion: 'v6.1.0',
              },
            }
          : {
              reviewerAddress: registry.owner,
              auditPolicyFormat: 'ultratokenizer.audit-policy.v1',
              auditReportFormat: 'ultratokenizer.audit-report.v2',
            }),
    },
  }));
  const index = {
    format: 'ultratokenizer.discovery.v1',
    chainId: '296',
    gate: policy.gate,
    issuerId: policy.issuerId,
    identityRegistry: registry,
    entries: metadata.map((item, offset) => ({
      role: item.ultratokenizer.role,
      agentId: String(offset + 1),
      owner: offset === 0 ? policy.issuerAddress : registry.owner,
      wallet: offset === 0 ? policy.issuerAddress : registry.owner,
      metadataHash: keccak256(toHex(JSON.stringify(item))),
    })),
  };
  const uris = metadata.map(
    (item) =>
      `data:application/json;base64,${Buffer.from(JSON.stringify(item)).toString('base64')}`,
  );
  const state = {
    registryOwner: registry.owner,
    implementation: registry.implementation,
    blockHash: snapshot.blockHash,
    wallets: index.entries.map((entry) => entry.wallet),
    owners: index.entries.map((entry) => entry.owner),
    metadataDelayMs: 0,
    metadataInFlight: 0,
    peakMetadataInFlight: 0,
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, fixture.deployment.rpcUrl);
    const call = JSON.parse(options.body);
    calls.push(call);
    let result;
    if (call.method === 'eth_chainId') result = '0x128';
    else if (call.method === 'eth_getCode')
      result =
        call.params[0].toLowerCase() === registry.address.toLowerCase()
          ? '0x60006000'
          : '0x60016000';
    else if (call.method === 'eth_getStorageAt')
      result = `0x${'0'.repeat(24)}${state.implementation.slice(2)}`;
    else if (call.method === 'eth_getBlockByNumber')
      result = {
        number: '0x64',
        hash: state.blockHash,
        timestamp: '0x713fb300',
        transactions: [],
      };
    else if (call.method === 'eth_call') {
      const decoded = decodeFunctionData({
        abi: IDENTITY_ABI,
        data: call.params[0].data,
      });
      const offset = decoded.args ? Number(decoded.args[0]) - 1 : 0;
      if (decoded.functionName === 'tokenURI') {
        state.metadataInFlight += 1;
        state.peakMetadataInFlight = Math.max(
          state.peakMetadataInFlight,
          state.metadataInFlight,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, state.metadataDelayMs),
        );
        state.metadataInFlight -= 1;
      }
      const value =
        decoded.functionName === 'owner'
          ? state.registryOwner
          : decoded.functionName === 'ownerOf'
            ? state.owners[offset]
            : decoded.functionName === 'getAgentWallet'
              ? state.wallets[offset]
              : uris[offset];
      result = encodeFunctionResult({
        abi: IDENTITY_ABI,
        functionName: decoded.functionName,
        result: value,
      });
    } else throw new Error(`Unexpected method ${call.method}`);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: call.id, result }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  return {
    fixture,
    index,
    snapshot,
    metadata,
    uris,
    state,
    calls,
    read: () =>
      readDiscovery(JSON.stringify(index), fixture.deployment, snapshot),
  };
}

test('discovery fetch is optional, same-origin, credential-free and bounded separately from deployment', async () => {
  const controller = new AbortController();
  assert.equal(
    await fetchHostedDiscovery(controller.signal, async (url, options) => {
      assert.equal(url, '/discovery.json');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return new Response('', { status: 404 });
    }),
    undefined,
  );
  await assert.rejects(
    fetchHostedDiscovery(
      controller.signal,
      async () =>
        new Response('x'.repeat(32 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    ),
    /too large/,
  );
});

test('discovery index cannot replace the deployment or alias roles and agent IDs', async (t) => {
  const { fixture, index } = await harness(t);
  assert.equal(
    parseDiscoveryIndex(JSON.stringify(index), fixture.deployment).entries
      .length,
    3,
  );
  const changed = structuredClone(index);
  changed.gate = '0x9999999999999999999999999999999999999999';
  assert.throws(
    () => parseDiscoveryIndex(JSON.stringify(changed), fixture.deployment),
    /another deployment/,
  );
  const duplicate = structuredClone(index);
  duplicate.entries[1].agentId = duplicate.entries[0].agentId;
  assert.throws(
    () => parseDiscoveryIndex(JSON.stringify(duplicate), fixture.deployment),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseDiscoveryIndex(
        JSON.stringify({
          ...index,
          rpcUrl: 'https://untrusted.example.invalid',
        }),
        fixture.deployment,
      ),
    /Unsupported/,
  );
});

test('metadata accepts exact hashed UTF-8 JSON bytes only, never a remote URI or duplicate fields', async (t) => {
  const { index, uris } = await harness(t);
  assert.match(
    decodeRegistration(uris[0], index.entries[0].metadataHash).name,
    /issuer/,
  );
  assert.throws(
    () =>
      decodeRegistration(
        'https://example.invalid/service.json',
        index.entries[0].metadataHash,
      ),
    /data URI/,
  );
  assert.throws(
    () => decodeRegistration(uris[0], `0x${'ff'.repeat(32)}`),
    /changed/,
  );
  const text = '{"type":"x","type":"y"}';
  assert.throws(() =>
    decodeRegistration(
      `data:application/json;base64,${Buffer.from(text).toString('base64')}`,
      keccak256(toHex(text)),
    ),
  );
});

test('identity attribution verifies proxy, implementation, owner, wallets and exact Gate declarations at one block', async (t) => {
  const { read, calls, metadata } = await harness(t);
  const observed = await read();
  assert.equal(observed.assurance, 'configured-rpc-current-attribution');
  assert.equal(observed.entries.length, 3);
  assert.equal(observed.entries[0].metadataText, JSON.stringify(metadata[0]));
  for (const call of calls.filter((item) =>
    ['eth_call', 'eth_getCode'].includes(item.method),
  ))
    assert.equal(call.params[1], '0x64');
  assert.equal(
    calls.find((item) => item.method === 'eth_getStorageAt').params[2],
    '0x64',
  );
});

test('registry upgrade or ownership change cannot silently change accepted discovery', async (t) => {
  const { read, state } = await harness(t);
  state.implementation = '0x9999999999999999999999999999999999999999';
  await assert.rejects(read(), /registry or its ownership changed/);
  state.implementation = '0x8888888888888888888888888888888888888888';
  state.registryOwner = '0x9999999999999999999999999999999999999999';
  await assert.rejects(read(), /registry or its ownership changed/);
});

test('slow metadata reads are bounded to one role at a time', async (t) => {
  const { read, state } = await harness(t);
  state.metadataDelayMs = 10;
  const observed = await read();
  assert.equal(observed.entries.length, 3);
  assert.equal(state.peakMetadataInFlight, 1);
});

test('unverifiable metadata stops attribution without retrying or querying later roles', async (t) => {
  const { read, uris, calls } = await harness(t);
  uris[0] = 'data:application/json;base64,e30=';
  await assert.rejects(read(), /changed/);
  const metadataCalls = calls.filter(
    (call) =>
      call.method === 'eth_call' &&
      decodeFunctionData({ abi: IDENTITY_ABI, data: call.params[0].data })
        .functionName === 'tokenURI',
  );
  assert.equal(metadataCalls.length, 1);
});

test('NFT transfer and wallet clearing fail attribution without any signing or mutation', async (t) => {
  const { read, state, calls } = await harness(t);
  state.wallets[0] = '0x0000000000000000000000000000000000000000';
  await assert.rejects(read(), /record was transferred or its wallet changed/);
  assert(
    calls.every(
      (call) => !call.method.includes('send') && !call.method.includes('sign'),
    ),
  );
});

test('a freshly rehashed but wrong program declaration still loses to Gate state', async (t) => {
  const { read, index, metadata, uris } = await harness(t);
  metadata[1].ultratokenizer.candidateProgram.programVKey = `0x${'ee'.repeat(32)}`;
  const text = JSON.stringify(metadata[1]);
  uris[1] = `data:application/json;base64,${Buffer.from(text).toString('base64')}`;
  index.entries[1].metadataHash = keccak256(toHex(text));
  await assert.rejects(read(), /declared program differs/);
});

test('an attribution snapshot is not returned after a canonical block changes', async (t) => {
  const { read, state } = await harness(t);
  state.blockHash = `0x${'bb'.repeat(32)}`;
  await assert.rejects(read(), /no longer canonical/);
});
