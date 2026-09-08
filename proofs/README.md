# PDF evidence verification

This workspace implements the first evidence boundary for Ultratokenizer: authenticate a PDF's signed bytes against an explicitly supplied signer fingerprint. It contains a native Rust library, an SP1 guest and a local execution runner.

It does not yet extract a gold balance, bind an issuance request, validate holder identity, issue tokens or generate a Groth16 proof. Execution success is labeled `zkProof: false`.

## Modules

| Module         | Responsibility                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `pdf-evidence` | Strict signature coverage, RSA-SHA256 verification, approved-signer matching and minimal public output.   |
| `pdf-guest`    | Execute the same evidence check inside SP1 and commit its output only on success.                         |
| `pdf-runner`   | Run the compiled guest locally, compare its output with native verification and exercise rejection cases. |

The TypeScript request module remains in `packages/domain`. The evidence output is not yet connected to its EIP-712 request digest.

## Supported profile

Version 1 accepts one RSA-2048 signature using SHA-256 and exponent 65537. The signature must cover the entire supplied PDF revision except for exactly one hexadecimal `/Contents` value. Multiple signature markers, appended revisions, malformed ranges, extra excluded content and ambiguous signature selection are rejected.

The CMS boundary accepts definite-length DER with one signer, one RSA/SHA-256 X.509 v3 certificate, detached `data` content and unique signed attributes containing `contentType` and a 32-byte `messageDigest`. Issuer name and serial number must match that certificate. Only zero bytes may follow the CMS value inside the signature gap. BER encoding, certificate bundles, unsigned attributes and other profiles require separate review and are rejected. Signature containers are limited to 64 KiB including padding, 16 levels of constructed nesting and 2,048 ASN.1 elements.

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
