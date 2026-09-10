/** Generate public synthetic test inputs and independent viem ABI/hash vectors. */
import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { getIssuanceRequestDigest } from '../../dist/domain/src/request-digest.js';
import { getClaimUsageId } from '../../dist/domain/src/claim-identity.js';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const word = (value) => `0x${value.repeat(64 / value.length)}`;
const textHash = (value) => keccak256(stringToHex(value));
const claim = {
  sourceId: word('a1'),
  claimId: word('b2'),
  issuerId: word('c3'),
  holder: `0x${'33'.repeat(20)}`,
  capacityMilligrams: 10000n,
  unit: 'XAU_MILLIGRAM',
  validUntil: 2000000000n,
};
const usageType =
  'UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)';
const claimType =
  'UltratokenizerSyntheticGoldClaimV1(bytes32 sourceId,bytes32 claimId,bytes32 issuerId,address holder,uint256 capacityMilligrams,string unit,uint64 validUntil)';
const claimUsageId = keccak256(
  encodeAbiParameters(
    ['bytes32', 'bytes32', 'bytes32'].map((type) => ({ type })),
    [textHash(usageType), claim.sourceId, claim.claimId],
  ),
);
if (
  getClaimUsageId({ sourceId: claim.sourceId, claimId: claim.claimId }) !==
  claimUsageId
)
  throw new Error(
    'The canonical identity helper disagrees with the V2 ABI vector.',
  );
const claimCommitment = keccak256(
  encodeAbiParameters(
    [
      'bytes32',
      'bytes32',
      'bytes32',
      'bytes32',
      'address',
      'uint256',
      'bytes32',
      'uint64',
    ].map((type) => ({ type })),
    [
      textHash(claimType),
      claim.sourceId,
      claim.claimId,
      claim.issuerId,
      claim.holder,
      claim.capacityMilligrams,
      textHash(claim.unit),
      claim.validUntil,
    ],
  ),
);
const capsule = [
  Buffer.from('UTSG0001').toString('hex'),
  claim.sourceId.slice(2),
  claim.claimId.slice(2),
  claim.issuerId.slice(2),
  claim.holder.slice(2),
  claim.capacityMilligrams.toString(16).padStart(64, '0'),
  textHash(claim.unit).slice(2),
  claim.validUntil.toString(16).padStart(16, '0'),
].join('');
const signed = spawnSync(
  'python3',
  [new URL('./sign-claim-fixture.py', import.meta.url).pathname],
  {
    input: capsule,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  },
);
if (signed.status !== 0)
  throw new Error('Synthetic claim fixture signing failed.');
const evidence = JSON.parse(signed.stdout);
const request = {
  schemaVersion: '1',
  action: 'ISSUE',
  requestId: word('44'),
  chainId: '296',
  gate: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  recipient: claim.holder,
  amount: String(claim.capacityMilligrams),
  unit: claim.unit,
  issuerId: claim.issuerId,
  reservationId: word('55'),
  claimCommitment,
  claimUsageId,
  policyVersion: '1',
  rightsVersion: '1',
  nonce: '0',
  validUntil: '1999999000',
};
const requestDigest = getIssuanceRequestDigest(request);
const publicValues = encodeAbiParameters(
  [
    'uint32',
    'bytes32',
    'bytes32',
    'bytes32',
    'bytes32',
    'bytes32',
    'uint64',
  ].map((type) => ({ type })),
  [
    2,
    requestDigest,
    `0x${evidence.signerFingerprint}`,
    claim.sourceId,
    claimUsageId,
    claimCommitment,
    claim.validUntil,
  ],
);
const directory = new URL('../claim-evidence/fixtures/', import.meta.url);
writeFileSync(
  new URL('request.synthetic.json', directory),
  JSON.stringify(request, null, 2) + '\n',
);
writeFileSync(
  new URL('gold-certificate.synthetic.json', directory),
  JSON.stringify(
    {
      ...evidence,
      profile: 'ultratokenizer-synthetic-gold-v2',
      capsuleFormat: 'ultratokenizer-synthetic-gold-v1',
      authenticatedAmountPublicThroughRequest: true,
      claim: {
        ...claim,
        capacityMilligrams: String(claim.capacityMilligrams),
        validUntil: String(claim.validUntil),
      },
      requestDigest,
      claimCommitment,
      claimUsageId,
      publicValues,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Created a distinct synthetic signed gold certificate and independent viem test vectors.',
);
