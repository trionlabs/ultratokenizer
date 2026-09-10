# Synthetic gold claim profile V2

This profile authenticates a deliberately synthetic gold certificate, requires the requested amount to equal its complete authenticated quantity, binds the claim to one exact issuance request, and commits seven static ABI words. It does not support Enpara statements, OCR, arbitrary PDF text, real reserves or production custody. The signature-only guest remains a separate program and cannot satisfy this profile's output format.

The proved predicate and claim usage identity are version 2. The synthetic capsule's version-1 wire encoding and commitment remain unchanged: the field named `capacityMilligrams` now determines the exact issuance amount. Request ABI/schema version 1 is also unchanged. A new guest identity is required; a proof for the old partial-issuance program does not establish this predicate.

The source signer authenticates a fixed binary capsule immediately after `%PDF-1.7\n`:

```text
%ULTRATOKENIZER-SYNTHETIC-GOLD-V1 <392 lowercase hex characters>\n
```

Exactly one marker is permitted. The signature must pass the PDF module's complete-revision coverage, bounded CMS parsing and independently supplied signer fingerprint. The capsule cannot occur in the excluded signature gap, which only permits hexadecimal CMS content. Visible PDF text is never interpreted as an asset claim.

## Authenticated capsule

| Byte offset | Size | Encoding                                                               |
| ----------- | ---- | ---------------------------------------------------------------------- |
| 0           | 8    | ASCII `UTSG0001`, explicitly synthetic capsule format version 1        |
| 8           | 32   | Nonzero source institution ID                                          |
| 40          | 32   | Nonzero, stable, high-entropy source claim ID                          |
| 72          | 32   | Nonzero authorized mint issuer ID                                      |
| 104         | 20   | Nonzero holder wallet address                                          |
| 124         | 32   | Positive full claim amount in milligrams, unsigned big-endian integer  |
| 156         | 32   | Keccak-256 of ASCII `XAU_MILLIGRAM`                                    |
| 188         | 8    | Positive exclusive expiry in Unix seconds, unsigned big-endian integer |

The source's signing key attests this capsule. A document copier cannot substitute their own recipient: the request's wallet must match the signed holder wallet. The token gate must still enforce wallet consent, source signer authority, mint issuer authorization and reservation state. A cryptographic signature alone does not establish those institutional facts.

## Derivation and request binding

All hashes below use Keccak-256 and Solidity `abi.encode`, with one 32-byte word per parameter. String values are replaced by their Keccak-256 hashes.

```text
usageType = "UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)"
claimUsageId = keccak256(abi.encode(keccak256(usageType), sourceId, claimId))

claimType = "UltratokenizerSyntheticGoldClaimV1(bytes32 sourceId,bytes32 claimId,bytes32 issuerId,address holder,uint256 capacityMilligrams,string unit,uint64 validUntil)"
claimCommitment = keccak256(abi.encode(
  keccak256(claimType), sourceId, claimId, issuerId, holder,
  capacityMilligrams, keccak256("XAU_MILLIGRAM"), validUntil
))
```

The usage derivation lives in `claim_identity.rs` and is identical to `packages/domain/claim-identity.ts`; `check-request-parity.mjs` compares both against each other.

The guest recomputes the entire canonical EIP-712 request from `packages/domain`, including its chain/gate domain and every message field. It rejects unknown or duplicate JSON fields, noncanonical integers, invalid checksums, zero identifiers and unsupported literals. It checks:

- Request issuer and recipient match the signed capsule.
- Request commitment and usage ID equal the derived values.
- Requested positive integer milligrams equal the complete signed amount. Both smaller and larger requests fail.
- Request expiry does not exceed signed claim expiry.

The guest does not accept a caller-supplied current time as proof of freshness. The on-chain consumer checks its own block time against both expiries.

## Public values

Exactly 224 bytes, Solidity ABI encoding of:

```solidity
(
  uint32 profileVersion,       // 2
  bytes32 requestDigest,
  bytes32 signerFingerprint,   // SHA-256 of canonical SPKI DER
  bytes32 sourceId,
  bytes32 claimUsageId,
  bytes32 claimCommitment,
  uint64 claimValidUntil
)
```

Claim ID, document bytes and extracted document text are absent from public values. The request exposes the minted quantity and wallet. Because the quantity must equal the signed amount, the full authenticated amount is public even though it has no separate public-values word. Commitments and usage IDs are linkable; private claim IDs must have sufficient entropy. Public synthetic fixtures intentionally disclose all test fields for reproducibility.

The gate consumes a `claimUsageId` **once per gate**, independently of reservation capacity. Partial issuance is rejected. Issuer, wallet, signing key, policy and statement re-export changes do not reset the V2 usage ID. A source can issue a different claim ID for a new snapshot of the same underlying funds; preventing duplicate backing still requires the issuer's exclusive reservation ledger and cross-gate policy.

V1 and V2 derive different usage IDs. Existing consumed V1 claims must not be reopened by enabling V2 without a migration that preserves their consumption. This development profile does not implement migration of a deployed V1 gate.

## Input and execution bounds

The guest input is a single raw hint with a 48-byte header: magic `UTCL0001`, 32-byte approved signer, 4-byte big-endian request JSON length and 4-byte big-endian PDF length. Canonical request JSON follows, then the PDF. Trailing bytes are rejected.

The guest checks the next SP1 hint length **before** asking the SDK to allocate its buffer. Request JSON is limited to 4 KiB, PDF input to 256 KiB, and the complete witness to their sum plus 48 bytes. The decoder borrows bounded slices and never trusts a serialized vector allocation length. The local execution/proving command enforces a 100-million-cycle limit. Error messages contain no document fields or parser diagnostics.

## Reproduce and verify

From the repository root:

```sh
cargo test --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-claim-evidence --all-targets
cargo clippy --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-claim-evidence -p ultratokenizer-claim-runner --all-targets -- -D warnings
cd proofs
cargo prove build --locked --packages ultratokenizer-claim-guest --output-directory elf
cargo run --locked -p ultratokenizer-claim-runner -- self-test elf/ultratokenizer-claim-guest
```

The self-test compares native output and guest output to independently generated viem vectors for full-quantity issuance. It also rejects source tampering, recipient and claim-ID substitution, smaller and larger amounts, incorrect units, excess expiry, wrong signers and oversized/malformed hints. Execution output always has `zkProof: false`.

After building the TypeScript domain package and Rust runner, `node proofs/tools/check-request-parity.mjs` compares 43 adversarial request cases between TypeScript/viem and Rust, including strict EIP-55 checks for uppercase addresses. Valid inputs must yield identical request digests and invalid inputs must be rejected by both implementations.

To regenerate the distinct synthetic fixture, build the TypeScript domain package first, then run `node proofs/tools/generate-claim-fixture.mjs` from the repository root. The generator uses viem for independent ABI/EIP-712 vectors and Python/OpenSSL for CMS signing. Its temporary private key is deleted after signing. The original signature-only PDF fixture is preserved.

## Explicit local proving

The runner never selects a prover from environment variables. `prove-local` constructs the SDK CPU prover directly, with its network-proving feature disabled. `verify-local` uses the SDK light client, whose verification path performs actual cryptographic verification. It does not need the original PDF or the application API.

```sh
cd proofs
cargo build --release --locked -p ultratokenizer-claim-runner -j 2
target/release/ultratokenizer-claim-runner identity elf/ultratokenizer-claim-guest

# Supply the independently checked programVkey from the previous command.
# Supply the independently approved source fingerprint from source policy.
python3 tools/watch-local-prover.py --seconds 900 --max-rss-mib 4096 -- \
  target/release/ultratokenizer-claim-runner prove-local core \
  elf/ultratokenizer-claim-guest claim-evidence/fixtures/gold-certificate.synthetic.pdf \
  claim-evidence/fixtures/request.synthetic.json APPROVED_SPKI_HEX EXPECTED_PROGRAM_VKEY \
  target/claim.core.proof

target/release/ultratokenizer-claim-runner verify-local \
  elf/ultratokenizer-claim-guest claim-evidence/fixtures/request.synthetic.json \
  target/claim.core.proof EXPECTED_PROGRAM_VKEY
```

Core proofs are cryptographic execution proofs **without zero knowledge**. Keep them private; they are not exportable ZK audit receipts. Use explicit `groth16` mode for the ZK wrapper. The pinned outer circuit version is `v6.1.0` for the tested SDK/lockfile. Groth16 wrapping requires the matching public circuit artifacts and a local Docker engine; the SDK may download those public build artifacts. No document or witness is sent to a network prover. The runtime rejects debug witness dumps, alternate Gnark images and development circuit overrides.

Proof files are limited to 64 MiB, created exclusively with restrictive permissions, and cryptographically verified before reporting success. Empty/mock proofs, unexpected versions, wrong program identities and request mismatches fail closed. A core/compressed proof must never be labeled a ZK proof or accepted by a Groth16-only token gate. Issuer authority, reservation state and chain inclusion remain separate audit checks.

## Historical profile V1 local result

The following measurement predates the exact-issuance predicate and V2 usage identity. It is evidence for the old profile only. It does not validate the current guest, and its program key must not be registered for profile V2.

The synthetic fixture produced a real local CPU core proof on September 9, 2026. Generation and cryptographic verification took 522.70 seconds; the complete watchdog run took 559.44 seconds and peaked at 3,893.1 MiB aggregate process RSS. The serialized proof was 51,636,147 bytes. Independent `verify-local` verification succeeded in a separate process, taking 6.23 seconds and 769.2 MiB peak RSS. Request substitution, a wrong program key, a modified trace commitment and trailing proof bytes were all rejected. This result proves execution of the claim program, **not zero knowledge or on-chain acceptance**. The proof remains an ignored local artifact with file mode `0600`.

The tested guest identity was:

```text
programVkey: 0x00065479fe8adf1ba075fd45d47be8baf6443c393646a683aed78856a98aa112
elfSha256:   786a9128a8a1a76f6a6d84f524d0612653b771174027edcd33e6652208a6fd2c
outerCircuitVersion: v6.1.0
```

Regenerate and independently check the program identity after any guest or dependency change. No Groth16 proof or Hedera verifier integration has been validated yet. The matching public Groth16 artifact archive is approximately 5.79 GiB; the [SP1 project template](https://github.com/succinctlabs/sp1-project-template) specifies at least 16 GB RAM for Groth16/PLONK proving. The tested Docker engine had about 7.75 GiB allocated, so the core proof result does not establish that this machine can complete the ZK wrapper.

After a genuine Groth16 proof exists, export only its public issuance material:

```sh
target/release/ultratokenizer-claim-runner export-groth16 \
  elf/ultratokenizer-claim-guest claim-evidence/fixtures/request.synthetic.json \
  <stored-groth16-proof-file> <expected-program-vkey>
```

This command bounds and deserializes the stored SP1 proof, checks profile 2 and the complete request binding, derives the verification key from the supplied ELF, compares it to the required pin, and independently verifies the proof cryptographically. It accepts only Groth16 with the pinned v6.1.0 verifier identity and a canonical 356-byte EVM envelope. Output contains `proofBytes`, the 224-byte `publicValues`, `programVKey`, and the validated canonical-field `request`. It never exports a core proof, witness, source PDF or private metadata. `issuerAuthorityChecked:false` is explicit: an independently obtained permit/signature and Gate authorization are still required. Empty, malformed and mocked proofs have no success path. Export has negative format tests; a successful genuine Groth16 export remains unverified until a real local proof completes.

The tracked [claim V2 program manifest](../programs/claim-v2.json) records the measured ELF/program key, profile and type strings, request schema, dependency lock hash, compiler identities and build platform. It explicitly identifies a synthetic test program with no production approval. CI must record its own Linux build identity and compare it with this measurement or report the reproducibility gap. An observed build difference never authorizes silently replacing a reviewed production key.
