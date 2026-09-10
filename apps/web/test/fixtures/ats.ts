import { keccak256, stringToHex } from 'viem';
import {
  ATS_FACET_PROFILE,
  ATS_LIBRARY_NAMES,
  ATS_PROFILE,
  ATS_UPSTREAM_COMMIT,
} from '../../../../packages/issuance/src/ats.js';
import { parseDeploymentConfig } from '../../../../packages/issuance/src/index.js';
import { createFixture } from './issuance';

/** Test-only parser inputs, never a deployed or independently verified ATS profile. */
export async function createAtsFixture() {
  const fixture = await createFixture();
  const hash = (label: string) => keccak256(stringToHex(`web-test:${label}`));
  let nextAddress = 100;
  const pin = (label: string) => ({
    address: `0x${(++nextAddress).toString(16).padStart(40, '0')}`,
    codeHash: hash(label),
  });
  const deployment = parseDeploymentConfig({
    ...fixture.deployment,
    format: 'ultratokenizer.deployment.v2',
    backend: {
      kind: 'ats',
      profile: ATS_PROFILE,
      upstreamCommit: ATS_UPSTREAM_COMMIT,
      tokenCodeHash: hash('token'),
      maxSupply: '1000000',
      adapter: pin('adapter'),
      resolver: pin('resolver'),
      initializer: pin('initializer'),
      configuration: { id: hash('configuration'), version: '1' },
      facets: Object.fromEntries(
        Object.keys(ATS_FACET_PROFILE).map((name) => [name, pin(name)]),
      ),
      libraries: Object.fromEntries(
        ATS_LIBRARY_NAMES.map((name) => [name, pin(name)]),
      ),
      admission: {
        kind: 'reviewed-atomic-creation.v1',
        transactionHash: hash('creation-transaction'),
        transactionInputHash: hash('creation-input'),
        blockNumber: '1',
        blockHash: hash('creation-block'),
        reviewHash: hash('independent-review'),
      },
    },
  });
  return { ...fixture, deployment };
}
