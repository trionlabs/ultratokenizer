# Synthetic gold claim profile V1

This profile authenticates a deliberately synthetic gold certificate, binds its claim to one exact issuance request, and commits seven static ABI words. It does not support Enpara statements, OCR, arbitrary PDF text, real reserves or production custody. The signature-only guest remains a separate program and cannot satisfy this profile's output format.

The source signer authenticates a fixed binary capsule immediately after `%PDF-1.7\n`:

```text
%ULTRATOKENIZER-SYNTHETIC-GOLD-V1 <392 lowercase hex characters>\n
```

Exactly one marker is permitted. The signature must pass the PDF module's complete-revision coverage, bounded CMS parsing and independently supplied signer fingerprint. The capsule cannot occur in the excluded signature gap, which only permits hexadecimal CMS content. Visible PDF text is never interpreted as an asset claim.

## Authenticated capsule

| Byte offset | Size | Encoding                                                               |
| ----------- | ---- | ---------------------------------------------------------------------- |
| 0           | 8    | ASCII `UTSG0001`, explicitly synthetic profile version 1               |
| 8           | 32   | Nonzero source institution ID                                          |
| 40          | 32   | Nonzero, stable, high-entropy source claim ID                          |
| 72          | 32   | Nonzero authorized mint issuer ID                                      |
| 104         | 20   | Nonzero holder wallet address                                          |
| 124         | 32   | Positive capacity in milligrams, unsigned big-endian integer           |
| 156         | 32   | Keccak-256 of ASCII `XAU_MILLIGRAM`                                    |
| 188         | 8    | Positive exclusive expiry in Unix seconds, unsigned big-endian integer |

The source's signing key attests this capsule. A document copier cannot substitute their own recipient: the request's wallet must match the signed holder wallet. The token gate must still enforce wallet consent, source signer authority, mint issuer authorization and reservation state. A cryptographic signature alone does not establish those institutional facts.

## Derivation and request binding

All hashes below use Keccak-256 and Solidity `abi.encode`, with one 32-byte word per parameter. String values are replaced by their Keccak-256 hashes.

```text
usageType = "UltratokenizerClaimUsageV1(bytes32 sourceId,bytes32 issuerId,bytes32 claimId)"
claimUsageId = keccak256(abi.encode(keccak256(usageType), sourceId, issuerId, claimId))

claimType = "UltratokenizerSyntheticGoldClaimV1(bytes32 sourceId,bytes32 claimId,bytes32 issuerId,address holder,uint256 capacityMilligrams,string unit,uint64 validUntil)"
claimCommitment = keccak256(abi.encode(
  keccak256(claimType), sourceId, claimId, issuerId, holder,
  capacityMilligrams, keccak256("XAU_MILLIGRAM"), validUntil
))
```

The guest recomputes the entire canonical EIP-712 request from `packages/domain`, including its chain/gate domain and every message field. It rejects unknown or duplicate JSON fields, noncanonical integers, invalid checksums, zero identifiers and unsupported literals. It checks:

- Request issuer and recipient match the signed capsule.
- Request commitment and usage ID equal the derived values.
- Requested positive integer milligrams do not exceed signed capacity.
- Request expiry does not exceed signed claim expiry.

The guest does not accept a caller-supplied current time as proof of freshness. The on-chain consumer checks its own block time against both expiries.

## Public values

Exactly 224 bytes, Solidity ABI encoding of:

```solidity
(
  uint32 profileVersion,       // 1
  bytes32 requestDigest,
  bytes32 signerFingerprint,   // SHA-256 of canonical SPKI DER
  bytes32 sourceId,
  bytes32 claimUsageId,
  bytes32 claimCommitment,
  uint64 claimValidUntil
)
```

Full capacity, claim ID, document bytes and extracted document text are absent from public values. The request separately exposes the minted quantity and wallet. Commitments and usage IDs are linkable; private claim IDs must have sufficient entropy. Public synthetic fixtures intentionally disclose all test fields for reproducibility.

V1 consumes a `claimUsageId` **once per gate**, independently of reservation capacity. Minting less than the source capacity still consumes the claim. Capacity cannot be privately split across multiple requests in this version. Wallet, signing key, policy and statement re-export changes do not reset the usage ID. A source can issue a different claim ID for a new snapshot of the same underlying funds; preventing duplicate backing still requires the issuer's exclusive reservation ledger and cross-gate policy.

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

The self-test compares native output and guest output to independently generated viem vectors. It also rejects source tampering, recipient and claim-ID substitution, excess capacity, incorrect units, excess expiry, wrong signers and oversized/malformed hints. Execution output always has `zkProof: false`.

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

## Measured local result

The synthetic fixture produced a real local CPU core proof on September 9, 2026. Generation and cryptographic verification took 522.70 seconds; the complete watchdog run took 559.44 seconds and peaked at 3,893.1 MiB aggregate process RSS. The serialized proof was 51,636,147 bytes. Independent `verify-local` verification succeeded in a separate process, taking 6.23 seconds and 769.2 MiB peak RSS. Request substitution, a wrong program key, a modified trace commitment and trailing proof bytes were all rejected. This result proves execution of the claim program, **not zero knowledge or on-chain acceptance**. The proof remains an ignored local artifact with file mode `0600`.

The tested guest identity was:

```text
programVkey: 0x00065479fe8adf1ba075fd45d47be8baf6443c393646a683aed78856a98aa112
elfSha256:   786a9128a8a1a76f6a6d84f524d0612653b771174027edcd33e6652208a6fd2c
outerCircuitVersion: v6.1.0
```

Regenerate and independently check the program identity after any guest or dependency change. No Groth16 proof or Hedera verifier integration has been validated yet. The matching public Groth16 artifact archive is approximately 5.79 GiB; the [SP1 project template](https://github.com/succinctlabs/sp1-project-template) specifies at least 16 GB RAM for Groth16/PLONK proving. The tested Docker engine had about 7.75 GiB allocated, so the core proof result does not establish that this machine can complete the ZK wrapper.
