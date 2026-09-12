# Controlled issuance contracts

A non-upgradeable issuance gate with separate native HTS and ATS mint adapters. The gate combines a holder-approved canonical request, an issuer permit, request-bound SP1 evidence and an exact institutional reservation. It consumes the entire reservation and source claim in one reverting transaction. A 1,000 mg authenticated claim authorizes exactly 1,000 mg; successful issuance cannot consume a smaller amount or charge a fee by reducing delivery.

This implementation has local EVM tests, including rejection checks against the actual pinned SP1 Groth16 verifier. It has not been deployed, audited or exercised against Hedera testnet or a valid SP1 proof of this application's guest. The test verifiers and HTS model exist only under `test/`; neither establishes production integration. No addresses or program verification keys are configured by default. The deployed gate starts paused and rejects absent registry entries. The current profile-2 source guest is explicitly a synthetic capsule; enabling that guest does not establish acceptance of a bank PDF, email or physical backing.

## Run

Foundry and Solidity 0.8.30 are required. `foundry.toml` pins the compiler, Paris EVM target, optimizer and IR pipeline. The first build downloads the pinned compiler if it is unavailable locally. The direct SP1 verifier is vendored with an immutable upstream commit, source checksums and MIT notices; there are no Solidity submodules. See [verifier provenance](src/vendor/sp1/README.md).

```sh
forge build --root contracts
forge fmt --root contracts --check
forge test --root contracts
npm --prefix packages/domain test
```

The last command requires the root `npm ci`. Local tests cover signatures, shared request/evidence vectors, exact reservation binding, pending/outstanding exposure, expiry/revocation, replay, reentrancy, rejection of legacy profile policies, exact mint delivery and rollback. Real-verifier negative tests reject malformed envelopes and invalid pairings; they contain no successful application proof. HTS tests install an explicitly synthetic system-contract model at `0x167` in the local EVM. `test/HtsFork.t.sol` covers token creation, treasury/association, mint, transfer, fee/shortfall rollback and supply-key behavior against that model. Setting `ULTRATOKENIZER_HTS_FORK_URL` selects an optional native-HTS smoke test with a test verifier. A complete real-proof/native-network acceptance test remains separate.

## Explicit deployment configuration

`script/DeployIssuance.s.sol` provisions a paused Gate and its one-time HTS adapter/token. It requires an already-deployed **direct** SP1 v6.1.0 verifier whose runtime matches this repository's vendored build. It never creates or registers a stand-in, and it rejects a test verifier even when its code hash is explicitly supplied. Every value below is required; none defaults to a development placeholder:

| Environment                  | Meaning                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GOVERNOR`                   | Nonzero address with registration and pause authority                                                                                 |
| `INITIALIZER`                | Nonzero token initializer; must equal the actual broadcaster                                                                          |
| `SP1_VERIFIER`               | Existing direct verifier address with deployed code                                                                                   |
| `SP1_VERIFIER_CODE_HASH`     | Reviewed runtime Keccak-256; must match both the address and `expectedVerifierCodeHash()`                                             |
| `SP1_VKEY`                   | Nonzero guest program vkey from the final reviewed guest build                                                                        |
| `SP1_PROFILE`                | Exactly `2`; profile 1 is disabled                                                                                                    |
| `PROGRAM_VERSION`            | Positive immutable registry version, at most `uint64.max`                                                                             |
| `ISSUER_ID`                  | Nonzero institutional identifier                                                                                                      |
| `RIGHTS_VERSION`             | Positive immutable rights version, at most `uint64.max`                                                                               |
| `RIGHTS_TERMS_HASH`          | Nonzero hash of the reviewed terms, labeled synthetic where applicable                                                                |
| `TOKEN_NAME`, `TOKEN_SYMBOL` | Explicit nonempty UTF-8 names, at most 100 bytes each                                                                                 |
| `TOKEN_EXPIRY_SECOND`        | Future Unix timestamp fitting positive `int64`                                                                                        |
| `TOKEN_CREATE_VALUE`         | Positive integer forwarded as Solidity call value for token creation; independently quote and fund the target network's creation cost |

The script validates these values before any broadcast. The supplied runtime hash, outer `VERIFIER_HASH`, recursion `VK_ROOT` and guest vkey are different identities; the [provenance note](src/vendor/sp1/README.md) explains their pins. A nonzero vkey does not demonstrate the guest's correctness or its source authenticity.

The actual broadcaster must equal `INITIALIZER`. If it also equals `GOVERNOR`, the script registers the supplied program and new rights. Otherwise it leaves those records absent and exposes exact `programRegistrationCall` and `rightsRegistrationCall` calldata for the real governor. It never impersonates a separate governor. It leaves the Gate paused in both cases and does not register issuer/source keys, policies or backing caps. Activation requires those reviewed records and independent real-proof/native-HTS acceptance evidence.

No live deployment or transaction is part of the test commands. Script tests use the actual direct verifier with a local HTS model, so they demonstrate configuration and caller handling, not native fees or token creation. Real execution requires a correctly funded signer, target relay and network-valid token expiry/renewal settings.

## Modules

- `RequestHash.sol`: exact version-one EIP-712 request and issuer-permit digests.
- `SignatureCheck.sol`: low-s, 65-byte ECDSA signatures and live ERC-1271 wallet checks.
- `IssuanceGate.sol`: registry versions, reservation authority, proof/signature checks, accounting and issuance event.
- `HederaMintAdapter.sol`: one-time token creation, exclusive supply authority and atomic mint/transfer.
- `AtsGateMintAdapter.sol`: one-time binding to an independently admitted ATS token, enrolled runtime continuity and exact mint deltas. Provisioning and configuration admission remain separate.
- `vendor/sp1/`: exact pinned upstream direct Groth16 verifier and provenance.
- `script/DeployIssuance.s.sol`: explicitly configured, paused deployment with real verifier pins.
- `test/helpers/MockSp1Verifier.sol`: test-only pass/fail stand-in; never a runtime dependency.
- `interfaces/`: minimal HTS, SP1 and adapter ABIs.

The TypeScript permit helper is `packages/domain/src/issuer-permit.ts`. The product client uses an explicitly configured wallet and RPC; no live deployment is supplied by default.

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

The issuer's immutable policy version selects a source key version and a program version. `registerProgram(version, verifier, expectedCodeHash, vkey, profile)` requires an explicit matching runtime hash and profile exactly 2. Execution also rejects any other profile, including a legacy program selected through its own legacy policy. The selected source fingerprint and all request-bound evidence fields must match. Proof bytes must be nonempty and the selected verifier must accept them. A signature-only guest's 96-byte output cannot satisfy this gate. Profile equality is an ABI guard; the reviewed program vkey is what identifies the actual predicate.

The profile-2 predicate requires the request amount to equal the authenticated claim amount. The exact reservation quantity and recipient are public from reservation broadcast, including cancellations and failed issuance; other source fields remain private only to the extent enforced by the approved guest and local proving workflow. The issuer-independent `claimUsageId` is consumed once across all issuers, policies, reservations and recipients within this Gate. Request ABI and EIP-712 domain remain version 1. Replay protection is scoped to this deployed Gate: migration to another Gate or chain needs an explicit state/cutover design, and adding a gate or chain identifier to the claim hash would not solve that problem.

## Reservations and governance

Only a currently registered issuer key can call:

```solidity
openReservation(
  bytes32 issuerId, uint64 keyVersion, bytes32 reservationId,
  address recipient, address token, uint256 capacity, uint64 validUntil,
  bytes32 requestDigest, bytes32 claimUsageId
)
```

The reservation fixes all those values permanently. Issuance must match recipient, token, digest, claim identity and **exact capacity**, and must consume the reservation in one success. There is no cumulative use or remainder. Distinct pending reservations may refer to one claim and tie up capacity, but only one successful issuance of that claim is possible in this Gate. A consumed claim cannot open a new reservation.

`backingPools(issuerId, token)` exposes `(cap, pending, outstanding)`. Only governance may set a cap through `setBackingCap(issuerId, token, cap)`, and it cannot reduce the cap below pending plus outstanding. An unconfigured pool has zero capacity. Opening a reservation adds its full amount to pending; a successful issue moves the same amount from pending to outstanding. Mint or transfer failure reverts every change. Expired pending reservations remain counted until `expireReservation` or revocation releases them.

A live issuer key or the governor can permanently revoke a reservation. Anyone may call `expireReservation(issuerId, reservationId)` at or after its expiry. Either releases unused pending exposure at most once. Neither can release consumed exposure or clear a used claim. This package has no burn/redemption settlement path, so outstanding is cumulative and never decremented. Permit or reservation expiry cannot extinguish minted liability. Caps are separately governed per issuer/token; a shared physical pool across issuers or tokens requires separate exclusive allocation and reconciliation.

The governor address is immutable. A reviewed multisignature account can implement that authority; membership changes happen in that account. Governance can append issuer-key, source-key, program, policy and rights versions, permanently revoke them, set backing caps, and pause or resume issuance. Existing version contents cannot be rewritten or reactivated. Registration and revocation emit inspectable records. Source-key expiry is not modeled in the current source registry; source revocation and signed claim expiry are separate checks.

Governance is an explicit trust boundary. Only reviewed, non-upgradeable adapters and version-specific non-proxy SP1 verifiers may be registered. Runtime code-hash checks detect replaced code but do not prove correctness or detect changed state behind a proxy. Governance cannot call an administrative mint function because none exists; malicious approval of an unsound program, source or adapter could nevertheless invalidate the assurance of later issuance. Program binaries, terms documents and their hashes must be independently published and checked before approval.

An issuer reservation and cap are institutional assertions. A genuine signature or historical balance does not prove that physical gold exists or is exclusively reserved. The institutions must enforce backing exclusivity in their own records, including renewed statements, other tokens, other chains and applications. Source, issuer and governor are authority roles; the same operator can control multiple roles. The contracts do not establish independent institutions or prove physical custody. Synthetic institution reservations must remain labeled synthetic.

## HTS authority and units

The native HTS adapter targets the system address `0x167`. Its initializer can create a token exactly once. Creation fixes zero initial supply, treasury equal to the adapter, decimals equal to three, and a single non-delegatable contract-ID supply key equal to the adapter. It creates no admin key, external supply key, fee key, wipe key, freeze key, pause key or KYC key. No pre-existing token can be attached.

One displayed token represents one gram; one base unit therefore represents one milligram. No rounding or decimal conversion occurs. Each issue must be positive and at most the signed `int64` maximum. The adapter checks HTS return codes and verifies exact total-supply, treasury and recipient-balance changes. A failed transfer or inconsistent successful return reverts the mint and gate accounting in the same transaction. This initial full-amount rule does not restrict later fungible transfers or division into milligram units. Any future service fee needs a separate settlement rule that preserves full issuance and delivery.

Only the immutable gate can call `mint`. The adapter exposes no arbitrary call, delegatecall, approval, burn, administrative mint, token-update or withdrawal path. It cannot change its token or gate. The HTS adapter deliberately excludes redemption, emergency token recovery and transfer restrictions; ATS uses the separate adapter below. Do not describe it as a complete gold custody/redemption product or an ATS submission.

Omitted native keys cannot be added to this token later under [HIP-540](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-540.md), so its key set is a creation-time lifecycle decision. Native [burn](https://docs.hedera.com/native/tokens/burn) consumes treasury-held tokens; returning tokens to the treasury does not authorize a burn through this adapter. A future redemption design must establish both the necessary token authority and external settlement. Burning or wiping supply alone does not discharge the institution's delivery obligation or justify releasing outstanding backing. Native HTS key operations do not apply to the ATS Solidity token below.

Token initialization requires a correctly funded Hedera transaction and valid token expiry/renewal configuration. Recipients must satisfy native token association requirements. No provisioning or chain transaction is performed by the test commands.

## ATS adapter and provisioning limits

`AtsGateMintAdapter` implements the same `IMintAdapter` interface. Its immutable Gate is the only
mint caller. Its immutable initializer may bind one initially empty token with three decimals and
exactly fifteen distinct runtime pins: ten facets, four linked libraries and the direct resolver.
The token proxy runtime is separately pinned. Each mint checks those hashes before and after the
call, requires exact supply and recipient increases, preserves the adapter's prior balance and
rejects changed decimals. A failure reverts the complete Gate transaction.

These checks establish continuity of supplied code, not the safety or authenticity of an arbitrary
token. Reviewed provisioning must admit the actual linked artifact graph, selector/configuration
versions, sole adapter issuance role, inert initialization/admin authority, initial storage and
transfer policy. Matching proxy code alone does not freeze delegated state. A newly supplied hash
is not a self-validating approval. The supported narrow candidate omits maintenance, recovery,
burn/redemption and operational KYC/freeze authorities; a persistent asset needs its own lifecycle.

`test/AtsGateMintAdapter.t.sol` exercises the main adapter through the actual Gate with explicit
test verifier/token/pin models. It rejects unauthorized mint, incorrect or duplicate pins, repeated
binding, code substitution and four wrong mint deltas, including full Gate rollback. These are
fault-injection tests, not execution of upstream ATS or a successful SP1 proof. The separate pinned
real-ATS integration experiment does not by itself supply a deployed, independently admitted asset.

The current live deployment script still provisions only native HTS. [The ATS source package](ats/README.md)
now builds the actual pinned profile and current main Gate/adapter, with a separate test verifier
and mandatory local acceptance lane. Reviewed creation admission and HFS-backed live Hedera
provisioning remain separate work; the full profile creation input is 31,759 bytes. ATS token balances use EVM
contract storage; native HTS association does not apply. No alternate adapter creates a new
consumption namespace inside this Gate, and no new Gate is implicitly a migration.

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

It is emitted only after the adapter returns successfully. Reconciliation must check the configured gate, successful transaction receipt, canonical request digest, all event fields, public-values hash, permit digest and selected program. An application success flag is insufficient. Supply reconciliation must also inspect the actual selected token and complete issuance history.

## Primary references

- [EIP-712](https://eips.ethereum.org/EIPS/eip-712): typed-data domain and message hashing.
- [SP1 contracts](https://github.com/succinctlabs/sp1-contracts): `verifyProof(programVKey, publicValues, proofBytes)` and version-specific verifiers.
- [Hiero HTS interface](https://github.com/hiero-ledger/hiero-contracts/blob/main/contracts/token-service/IHederaTokenService.sol): token creation, contract-ID keys, mint/transfer ABIs and success code 22. `IHts.sol` contains a reduced Apache-2.0 ABI subset.
- [Hedera key management](https://hedera.com/blog/announcing-hip-540-enhanced-token-key-management-on-hedera/): token key update authority.

Source and tests were written with Codex assistance. Passing local tests is not an independent security audit or a real-proof/native-network acceptance test.
