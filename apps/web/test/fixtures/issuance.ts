import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fixture from '../../../../packages/domain/fixtures/request.synthetic.json';
import {
  getIssuanceRequestDigest,
  getIssuanceRequestTypedData,
  getIssuerPermitTypedData,
  parseIssuanceRequest,
} from '../../../../packages/domain/src/index.js';

/** Test-only signed bindings. The four proof bytes are deliberately not a ZK proof. */
export async function createFixture() {
  const holder = privateKeyToAccount(generatePrivateKey());
  const issuer = privateKeyToAccount(generatePrivateKey());
  const hash = (pair: string) => `0x${pair.repeat(32)}` as Hex;
  const request = parseIssuanceRequest({
    ...fixture,
    recipient: holder.address,
    amount: '1000',
  });
  const digest = getIssuanceRequestDigest(request);
  const policy = {
    format: 'ultratokenizer.audit-policy.v1',
    chainId: '296',
    gate: request.gate,
    token: request.token,
    issuerId: request.issuerId,
    issuerAddress: issuer.address,
    issuerKeyVersion: '1',
    policyVersion: '1',
    rightsVersion: '1',
    programVKey: hash('66'),
    profileVersion: '2',
    sourceId: hash('77'),
    sourceSignerFingerprint: hash('88'),
    proofSystem: 'sp1-groth16',
    outerVersion: 'v6.1.0',
    verifierAddress: '0x4444444444444444444444444444444444444444',
    verifierCodeHash: keccak256('0x60016000'),
  };
  const permit = {
    requestDigest: digest,
    issuerId: request.issuerId,
    keyVersion: '1',
    nonce: '0',
    validUntil: request.validUntil,
  };
  const publicValues = encodeAbiParameters(
    [
      { type: 'uint32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint64' },
    ],
    [
      2,
      digest,
      policy.sourceSignerFingerprint,
      policy.sourceId,
      request.claimUsageId,
      request.claimCommitment,
      BigInt(request.validUntil),
    ],
  );
  const holderSignature = await holder.signTypedData(
    getIssuanceRequestTypedData(request),
  );
  const issuerSignature = await issuer.signTypedData(
    getIssuerPermitTypedData(request, permit),
  );
  const transactionHash = hash('aa');
  return {
    deployment: {
      format: 'ultratokenizer.deployment.v1',
      purpose: 'test',
      rpcUrl: 'https://rpc.example.invalid/',
      gateCodeHash: keccak256('0x60006000'),
      confirmations: 1,
      auditPolicy: policy,
    },
    bundle: {
      format: 'ultratokenizer.issuance-bundle.v1',
      request,
      permit,
      issuerSignature,
      publicValues,
      proofBytes: '0x01020304',
      programVKey: policy.programVKey,
    },
    receipt: {
      format: 'ultratokenizer.issuance-receipt.v1',
      request,
      requestDigest: digest,
      holderSignature,
      permit,
      issuerSignature,
      publicValues,
      proofBytes: '0x01020304',
      programVKey: policy.programVKey,
      transaction: { chainId: '296', hash: transactionHash },
    },
    policy,
    holderSignature,
    transactionHash,
  };
}
