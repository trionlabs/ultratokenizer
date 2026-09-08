# Controlled issuance contracts

A non-upgradeable issuance gate and a Hedera Token Service adapter. The gate combines a holder-approved canonical request, a distinct issuer permit, request-bound SP1 evidence and a live institutional reservation. It consumes the authorization and mints in one reverting transaction.

This implementation has local EVM tests. It has not been deployed, audited or exercised against Hedera testnet or a real SP1 cryptographic proof. The test verifier and HTS model exist only under `test/`; neither is evidence of production integration. No addresses or program verification keys are configured by default. The deployed gate starts paused and rejects absent registry entries.

## Run

Foundry and Solidity 0.8.30 are required. `foundry.toml` pins the compiler, Paris EVM target, optimizer and IR pipeline. The first build downloads the pinned compiler if it is unavailable locally. There are no Solidity library dependencies or submodules.

```sh
forge build --root contracts
forge fmt --root contracts --check
forge test --root contracts
npm --prefix packages/domain test
```

The last command requires the root `npm ci`. Local tests cover signatures, request/permit digest parity with TypeScript, live expiry/revocation, immutable records, capacity, replay, reentrancy, exact mint delivery and rollback after mint/transfer failure. HTS tests install an explicitly synthetic system-contract model at `0x167` in the local EVM. Native HTS behavior, account associations, fees and real verifier compatibility still require a Hedera integration test.

## Modules

- `RequestHash.sol`: exact version-one EIP-712 request and issuer-permit digests.
- `SignatureCheck.sol`: low-s, 65-byte ECDSA signatures and live ERC-1271 wallet checks.
- `IssuanceGate.sol`: registry versions, reservation authority, proof/signature checks, accounting and issuance event.
- `HederaMintAdapter.sol`: one-time token creation, exclusive supply authority and atomic mint/transfer.
- `interfaces/`: minimal HTS, SP1 and adapter ABIs.

The TypeScript permit helper is `packages/domain/src/issuer-permit.ts`. The simulation UI does not invoke these contracts.

## Authorization and proof contracts

`issue(request, holderSignature, permit, issuerSignature, publicValues, proofBytes)` can be relayed by anyone. A relayer acquires no issuance authority. The holder signs the exact canonical `IssuanceRequest` from the domain package. Request chain ID and gate must match the executing chain and contract. Quantities use integer milligrams; request expiry is exclusive.

The issuer signs a different EIP-712 primary type in the same `Ultratokenizer`, version `1`, chain/gate domain:

```solidity
IssuerPermit(bytes32 requestDigest,bytes32 issuerId,uint64 keyVersion,uint256 nonce,uint64 validUntil)
```

Permit expiry cannot exceed request or issuer-key expiry. The registered issuer key must still be live at execution. The permit nonce is consumed by issuer ID and key version. The holder nonce is consumed by recipient across all requests at this gate. Request digests and request IDs are also consumed independently.

Evidence is exactly 224 bytes, Solidity ABI-encoded in this order:

```solidity
(
  uint32 profileVersion,
  bytes32 requestDigest,
  bytes32 signerFingerprint,
  bytes32 sourceId,
  bytes32 claimUsageId,
  bytes32 claimCommitment,
  uint64 claimValidUntil
)
```

The issuer's immutable policy version selects a source key version and a program version. The program pins a verifier address, its runtime code hash, the SP1 program verification key and the evidence profile. The selected source fingerprint and all request-bound evidence fields must match. Proof bytes must be nonempty and the actual verifier must accept them. A signature-only guest's 96-byte output cannot satisfy this gate.

Source capacity remains private to the guest. Version one consumes each authenticated `claimUsageId` once, across all issuers, policies, reservations and recipients within this gate. A partially used source claim cannot fund a second request. Reservations separately support cumulative requested quantities from distinct claims. No cross-gate or cross-chain claim-consumption guarantee is provided.

## Reservations and governance

Only a currently registered issuer key can open a reservation. It fixes issuer ID, reservation ID, recipient, token, capacity and expiry. Its identity and capacity cannot be overwritten, extended or reset. A live issuer key or the governor can permanently revoke it. Reservation capacity is public and represents the amount deliberately reserved for this workflow, not the source document's private total balance.

The governor address is immutable. Use an operationally controlled multisignature account; membership changes happen in that account. Governance can append issuer-key, source-key, program, policy and rights versions; permanently revoke existing versions; and pause or resume issuance. Existing version contents cannot be rewritten or reactivated. Registration and revocation emit inspectable records.

Governance is an explicit trust boundary. Only reviewed, non-upgradeable adapters and version-specific non-proxy SP1 verifiers may be registered. Runtime code-hash checks detect replaced code but do not prove correctness or detect changed state behind a proxy. Governance cannot call an administrative mint function because none exists; malicious approval of an unsound program, source or adapter could nevertheless invalidate the assurance of later issuance. Program binaries, terms documents and their hashes must be independently published and checked before approval.

An issuer reservation is a custody assertion. A genuine signature or historical balance does not prove that physical gold currently exists or is exclusively reserved. The institutions must enforce reservation exclusivity in their own records, including across other chains and applications.

## HTS authority and units

The production adapter targets the native HTS system address `0x167`. Its initializer can create a token exactly once. Creation fixes zero initial supply, treasury equal to the adapter, decimals equal to three, and a single non-delegatable contract-ID supply key equal to the adapter. It creates no admin key, external supply key, fee key, wipe key, pause key or KYC key. No pre-existing token can be attached.

One displayed token represents one gram; one base unit therefore represents one milligram. No rounding or decimal conversion occurs. Each issue must be positive and at most the signed `int64` maximum. The adapter checks HTS return codes and verifies exact total-supply, treasury and recipient-balance changes. A failed transfer or inconsistent successful return reverts the mint and gate accounting in the same transaction.

Only the immutable gate can call `mint`. The adapter exposes no arbitrary call, delegatecall, approval, burn, administrative mint, token-update or withdrawal path. It cannot change its token or gate. These choices deliberately exclude redemption, emergency token recovery, transfer restrictions and ATS integration from this issuance module. Do not describe it as a complete gold custody/redemption product or an ATS submission.

Token initialization requires a correctly funded Hedera transaction and valid token expiry/renewal configuration. Recipients must satisfy native token association requirements. No provisioning or chain transaction is performed by the test commands.

## Audit event

```solidity
event Issued(
  bytes32 indexed requestDigest,
  bytes32 indexed requestId,
  bytes32 indexed claimUsageId,
  bytes32 issuerId,
  bytes32 reservationId,
  address token,
  address recipient,
  uint256 milligrams,
  uint64 policyVersion,
  uint64 rightsVersion,
  bytes32 permitDigest,
  bytes32 publicValuesHash,
  bytes32 programVKey
);
```

It is emitted only after the adapter returns successfully. Reconciliation must check the configured gate, successful transaction receipt, canonical request digest, all event fields, public-values hash, permit digest and selected program. An application success flag is insufficient. Supply reconciliation must also inspect the actual native token and complete issuance history.

## Primary references

- [EIP-712](https://eips.ethereum.org/EIPS/eip-712): typed-data domain and message hashing.
- [SP1 contracts](https://github.com/succinctlabs/sp1-contracts): `verifyProof(programVKey, publicValues, proofBytes)` and version-specific verifiers.
- [Hiero HTS interface](https://github.com/hiero-ledger/hiero-contracts/blob/main/contracts/token-service/IHederaTokenService.sol): token creation, contract-ID keys, mint/transfer ABIs and success code 22. `IHts.sol` contains a reduced Apache-2.0 ABI subset.
- [Hedera key management](https://hedera.com/blog/announcing-hip-540-enhanced-token-key-management-on-hedera/): token key update authority.

Source and tests were written with Codex assistance. Passing local tests is not an independent security audit or a real-proof/native-network acceptance test.
