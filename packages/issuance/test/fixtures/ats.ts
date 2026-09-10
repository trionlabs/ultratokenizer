import { getAddress, keccak256, type Address, type Hex } from 'viem';
import {
  ATS_FACET_PROFILE,
  ATS_LIBRARY_NAMES,
  ATS_PROFILE,
  ATS_UPSTREAM_COMMIT,
  type AtsBackend,
} from '../../src/ats.js';

/** Test data only. These addresses/hashes identify no deployment and prove no admission. */
export const atsFixtureAddress = (value: number): Address =>
  getAddress(`0x${value.toString(16).padStart(40, '0')}`);
export const atsFixtureHash = (value: number): Hex =>
  `0x${value.toString(16).padStart(64, '0')}`;
export function createAtsBackendFixture(): AtsBackend {
  const pin = (value: number) => ({
    address: atsFixtureAddress(value),
    codeHash: keccak256('0x6000'),
  });
  return {
    kind: 'ats',
    profile: ATS_PROFILE,
    upstreamCommit: ATS_UPSTREAM_COMMIT,
    tokenCodeHash: keccak256('0x6000'),
    maxSupply: '1000000',
    adapter: pin(11),
    resolver: pin(12),
    initializer: pin(13),
    configuration: { id: atsFixtureHash(1), version: '1' },
    facets: Object.fromEntries(
      Object.keys(ATS_FACET_PROFILE).map((name, index) => [
        name,
        pin(100 + index),
      ]),
    ) as AtsBackend['facets'],
    libraries: Object.fromEntries(
      ATS_LIBRARY_NAMES.map((name, index) => [name, pin(200 + index)]),
    ) as AtsBackend['libraries'],
    admission: {
      kind: 'reviewed-atomic-creation.v1',
      transactionHash: atsFixtureHash(2),
      transactionInputHash: keccak256('0x60016002'),
      blockNumber: '10',
      blockHash: atsFixtureHash(3),
      reviewHash: atsFixtureHash(4),
    },
  };
}
