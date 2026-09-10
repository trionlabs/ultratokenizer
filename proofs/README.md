# PDF evidence verification

This workspace implements the first evidence boundary for Ultratokenizer: authenticate a PDF's signed bytes against an explicitly supplied signer fingerprint. It contains a native Rust library, an SP1 guest and a local execution runner.

The signature-only modules do not interpret balances or bind an issuance request. The separate [synthetic gold claim profile](claim-evidence/README.md) authenticates a fixed versioned capsule, enforces the complete authenticated amount, derives issuer-independent V2 claim identity and binds the full EIP-712 request. It does not support real bank statements or establish asset backing. Execution success is labeled `zkProof: false`; local proving is an explicit separate command.

## Modules

| Module           | Responsibility                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `pdf-evidence`   | Strict signature coverage, RSA-SHA256 verification, approved-signer matching and minimal public output.      |
| `pdf-guest`      | Execute the same evidence check inside SP1 and commit its output only on success.                            |
| `pdf-runner`     | Run the compiled guest locally, compare its output with native verification and exercise rejection cases.    |
| `claim-evidence` | Authenticate the synthetic capsule, derive claim identifiers and recompute the full issuance request digest. |
| `claim-guest`    | Execute the bounded request-bound claim program, with a distinct 224-byte output.                            |
| `claim-runner`   | Execute, generate local CPU proofs and independently verify them with pinned program identity.               |

The TypeScript request module remains in `packages/domain`. The claim profile independently recomputes its EIP-712 digest; the signature-only output does not bind requests.

## Supported profile

Version 1 accepts one RSA-2048 signature using SHA-256 and exponent 65537. The signature must cover the entire supplied PDF revision except for exactly one hexadecimal `/Contents` value. Multiple signature markers, appended revisions, malformed ranges, extra excluded content and ambiguous signature selection are rejected.

The CMS boundary accepts definite-length DER with one signer, one RSA/SHA-256 X.509 v3 certificate, detached `data` content and unique signed attributes containing `contentType` and a 32-byte `messageDigest`. Issuer name and serial number must match that certificate. Only zero bytes may follow the CMS value inside the signature gap. BER encoding, certificate bundles, unsigned attributes and other profiles require separate review and are rejected. Signature containers are limited to 64 KiB including padding, 16 levels of constructed nesting and 2,048 ASN.1 elements.

### Separate native CAdES revision primitive

`pdf-evidence::reviewed_revision::verify_reviewed_revision` verifies a specifically selected signed prefix while checking the complete file against an `ApprovedRevision` input. That input must ultimately be authenticated by an institutional signature or approved policy. A caller computing its own file hash does **not** establish institutional approval. The native diagnostic command below does not authenticate that approval and always reports `institutionalApprovalVerified:false` and `zkProof:false`.

```sh
proofs/target/debug/ultratokenizer-pdf-runner reviewed-native \
  <complete-pdf> <approved-spki-sha256-hex> \
  <approved-complete-file-sha256-hex> <approved-signed-revision-length>
```

The separate CAdES envelope retains one RSA-2048/SHA-256 document signer, exact signed byte coverage, matching issuer/serial, unique signed attributes, content-type/message-digest checks and the independent leaf-key pin. It also accepts an ECDSA-SHA384 issuer signature on that RSA leaf certificate: a certificate issuer's algorithm is distinct from the leaf's document-signing algorithm. It permits one bounded, untrusted `signatureTimeStampToken` unsigned attribute. No certificate chain, timestamp validity, qualified-seal status or revocation/freshness claim is made. CAdES DER depth is limited to 24 for the nested token, with the same 2,048-node/64-KiB envelope limits and an 8-KiB unsigned-attribute limit. The original strict profile retains depth 16 and rejects unsigned attributes.

The returned `VerifiedReviewedRevision` exposes only the authenticated prefix for downstream extraction. Any change to later bytes invalidates the supplied full-file approval. Accepting an earlier revision does not authenticate a changed financial statement in a later revision. The two explicitly supplied Enpara portfolio reports and the previously inspected report passed this native signature primitive locally; none was copied into fixtures or uploaded. These private probes establish compatibility with those samples, not general PDF rendering or parser correctness.

This primitive is **not wired into claim profile 2**. The separate [native Enpara extractor candidate](enpara-evidence/README.md) now resolves the selected revision's table/font/content graph and selects the full available-XAU column under the explicit gram label. It has its own workspace/lockfile and does not change the existing guest. Real Enpara issuance still requires parser/template review, running this extraction inside a separately identified guest, and an authenticated issuer attestation binding the complete document, selected revision, amount, stable right, holder and expiry. The resulting claim must then pass a genuine ZK proof and the Gate's ordinary permit/registry/consumption checks. A receipt or successful native PDF diagnostic is not an issuance proof.

The accepted key fingerprint is **SHA-256 of canonical SubjectPublicKeyInfo DER**, not a certificate fingerprint or a hash of PKCS#1 DER. Obtain approved fingerprints from an independent trust policy. Never extract a key from an untrusted PDF and automatically call it trusted.

This restrictive profile is a prerequisite for the Enpara adapter. Full Enpara statements with multiple signatures are not supported yet. Certificate chains, revocation, timestamps, bank-signing authority, holder ownership and asset backing are outside this module's guarantee.

## Public output

The guest commits the Solidity ABI encoding of:

```solidity
(uint32 profileVersion, bytes32 signerFingerprint, bytes32 signedDigest)
```

The 96-byte output contains no document text, names, account numbers or balances. A document digest remains linkable to someone who possesses the document. A future contract must independently check the signer against its registry and pin this guest's program identity. This signature-only guest must not be registered as a complete issuance verifier.

## Run the native checks

From the repository root, using the tested native Rust 1.96.0 toolchain:

```sh
cargo test --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-pdf-evidence --all-targets
cargo clippy --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-pdf-evidence --all-targets -- -D warnings
```

For a local PDF, supply the approved fingerprint explicitly:

```sh
cargo run --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-pdf-evidence \
  --example verify -- path/to/document.pdf APPROVED_SPKI_SHA256_HEX
```

This command prints signature metadata only. It does not generate a ZK proof or upload the PDF.

## Build and execute the SP1 guest

The guest and runner declare SP1 6.2.4. Use the matching `cargo prove` toolchain and keep `Cargo.lock` for the resolved dependency set. The tested lockfile resolves several executor and primitive dependencies to 6.7.0. These versions passed local execution together; the eventual Groth16 verifier version must be established by a real proof integration test. Compiling the SDK also builds its local executor helper and may download additional public build dependencies on first use.

```sh
cd proofs
cargo prove build --locked --packages ultratokenizer-pdf-guest --output-directory elf
cargo run --locked -p ultratokenizer-pdf-runner -- self-test elf/ultratokenizer-pdf-guest
```

The self-test runs one valid fixture and four invalid inputs inside SP1, including a malformed CMS length that previously caused a native parser panic. It requires native and guest output to match independent OpenSSL/Python fixture metadata; rejected inputs must fail native verification and have a nonzero guest exit code with no public values.

To execute a supported local document:

```sh
cargo run --locked -p ultratokenizer-pdf-runner -- execute \
  elf/ultratokenizer-pdf-guest path/to/document.pdf APPROVED_SPKI_SHA256_HEX
```

The runner explicitly selects a local executor, with the SDK's network proving feature disabled. SP1 execution is an integration check, not a cryptographic proof. Groth16 generation, verification on Hedera and performance measurements for real statements are later milestones.

## Local Groth16 proving

`claim-runner prove-local groth16` invokes the actual local CPU prover and Groth16 wrapper. It fails if local Docker is unavailable, generation fails, the mode/public values differ, or independent cryptographic verification fails. It writes no substitute proof. See the [claim profile commands and limits](claim-evidence/README.md#explicit-local-proving).

The former `groth16-scaffold` command has been removed. `native`, `execute` and `self-test` remain non-proof diagnostics and report `zkProof: false`.

Profile V2 requires a newly built guest and independently pinned program key. A historical profile V1 core proof is neither a V2 proof nor zero knowledge. Successful Groth16 generation and acceptance by the intended Hedera verifier must be demonstrated before claiming that integration works.

## Synthetic fixture

`pdf-evidence/fixtures/statement.synthetic.pdf` is a generated test document signed by a synthetic, self-signed RSA certificate. It has no bank authority and represents no asset. The adjacent JSON contains public fingerprints, digests and independently encoded expected output.

`tools/generate-fixture.py` uses Python's standard library and OpenSSL. It verifies the generated CMS signature, keeps the temporary private key outside the repository, deletes it afterward and writes only the public fixture and metadata. Regeneration creates a new key and intentionally changes fixture fingerprints:

```sh
python3 proofs/tools/generate-fixture.py
```

Place private documents in the ignored `proofs/fixtures/private/` directory. Build artifacts under `proofs/target/` and `proofs/elf/` are ignored.

## Dependency provenance and review boundary

PDF CMS parsing and signature verification use the MIT-licensed [public zkPDF library](https://github.com/privacy-ethereum/zkpdf), pinned to commit `dd6f3ac69ccb5be3d2ef0130bb8e33b2f52d1e18`. The dependency is fetched directly from that public repository; its source has not been copied into this workspace. RSA key encoding uses [RustCrypto RSA](https://github.com/RustCrypto/RSA). SP1 uses the [Succinct SDK and guest library](https://github.com/succinctlabs/sp1).

Ultratokenizer adds its own strict coverage checks, bounded CMS shape validation, explicit signer policy, minimal output format, guest boundary, local runner and synthetic adversarial tests. The CMS guard runs before upstream extraction or parsing; it addresses reproduced malformed-length panics and first-signer/trailing-data ambiguity without relying on panic recovery. This focused test suite is not an independent cryptographic audit of the upstream parser. PDF checks authenticate a restricted byte envelope, not rendering semantics. Keep this module away from a public upload endpoint until parser robustness, witness deserialization and execution resource limits are reviewed.
