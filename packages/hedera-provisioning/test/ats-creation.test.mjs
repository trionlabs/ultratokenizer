import assert from 'node:assert/strict';
import test from 'node:test';
import { graphCreationData } from '../src/ats-creation.mjs';
const address = `0x${'11'.repeat(20)}`;
function input(bytes = 24576) {
  const pin = {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'codeHash', type: 'bytes32' },
    ],
  };
  return {
    name: 'AtsGateProfile',
    governor: address,
    deployed: { IssuanceGate: { address } },
    facetOrder: [],
    libraryOrder: [],
    artifacts: {
      AtsGateProfile: {
        abi: [
          {
            type: 'constructor',
            inputs: [{ type: 'address' }, pin, pin, { type: 'bytes' }],
          },
        ],
        bytecode: { object: '0x6000', linkReferences: {} },
      },
      AtsGateMintAdapter: {
        bytecode: { object: `0x${'00'.repeat(bytes)}`, linkReferences: {} },
        deployedBytecode: { linkReferences: {} },
      },
    },
  };
}
await test('constructor arguments can require HFS despite a tiny profile template', () => {
  assert.ok((graphCreationData(input()).length - 2) / 2 > 24 * 1024);
  assert.ok((graphCreationData(input(16)).length - 2) / 2 < 24 * 1024);
});
await test('profile child adapter with external links or placeholders fails before preparation', () => {
  for (const field of ['bytecode', 'deployedBytecode']) {
    const value = input();
    value.artifacts.AtsGateMintAdapter[field].linkReferences = {
      'library.sol': { Library: [{ start: 0, length: 20 }] },
    };
    assert.throws(() => graphCreationData(value), /must not require external/);
  }
  const value = input();
  value.artifacts.AtsGateMintAdapter.bytecode.object = '0x__$unlinked$__';
  assert.throws(() => graphCreationData(value));
});
