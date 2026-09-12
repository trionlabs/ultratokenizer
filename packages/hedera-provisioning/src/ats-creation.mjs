import assert from 'node:assert/strict';
import { encodeDeployData } from 'viem';

function linkCreation(artifact, deployed) {
  let data = artifact.bytecode.object;
  for (const libraries of Object.values(artifact.bytecode.linkReferences)) {
    for (const [name, offsets] of Object.entries(libraries)) {
      const target = deployed[name]?.address;
      assert.ok(
        target,
        `Library ${name} was not prepared before its consumer.`,
      );
      for (const offset of offsets) {
        assert.equal(offset.length, 20);
        assert.ok(
          offset.start >= 0 && 2 + (offset.start + 20) * 2 <= data.length,
        );
        const start = 2 + offset.start * 2;
        data = data.slice(0, start) + target.slice(2) + data.slice(start + 40);
      }
    }
  }
  assert.match(data, /^0x[0-9a-fA-F]+$/);
  return data;
}

/** The same constructor encoding measures offline transport and prepares the actual creation. */
export function graphCreationData({
  name,
  artifacts,
  deployed,
  governor,
  facetOrder,
  libraryOrder,
}) {
  const pin = (name) => ({
    target: deployed[name].address,
    codeHash: deployed[name].runtimeHash,
  });
  if (name === 'AtsGateProfile') {
    const adapter = artifacts.AtsGateMintAdapter;
    for (const code of [adapter.bytecode, adapter.deployedBytecode])
      assert.ok(
        Object.values(code.linkReferences).every(
          (links) => Object.keys(links).length === 0,
        ),
        'The profile child adapter must not require external library linking.',
      );
    assert.match(adapter.bytecode.object, /^0x[0-9a-fA-F]+$/);
  }
  const args =
    name === 'IssuanceGate'
      ? [governor]
      : name === 'AtsGateProfile'
        ? [
            deployed.IssuanceGate.address,
            facetOrder.map(pin),
            libraryOrder.map(pin),
            artifacts.AtsGateMintAdapter.bytecode.object,
          ]
        : [];
  return encodeDeployData({
    abi: artifacts[name].abi,
    bytecode: linkCreation(artifacts[name], deployed),
    args,
  });
}
