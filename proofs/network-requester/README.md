# SP1 Network requester

This standalone crate is the credential-bearing boundary for Succinct mainnet. Its dependency lock
is separate from the evidence workspace, so enabling the SP1 network stack cannot silently change
the reviewed guest build. It accepts the integrity-sealed embedded V2 fixture or a separately
reviewed deployment request whose exact request-file SHA-256 and EIP-712 digest are pinned in the shared schema, alongside one allowlisted synthetic PDF. A separate version-2 input review admits ten exact synthetic PDF hashes and one fixed Gate/token pair for document-service jobs. No path accepts an
arbitrary document or caller-supplied witness.

The staging operations are:

- `quote` verifies the requester address from `NETWORK_PRIVATE_KEY` and reads current Groth16 auction
  parameters, PROVE balance and program-registration state. It performs no upload or proof request.
- `stage` rederives the synthetic witness, checks the preparation, ELF hash and VKey, then performs
  at most one program registration and uploads the witness as `PrivateStdin`. It cannot submit a
  proof request. Every external attempt is recorded in a new append-only mode-`0600` journal; an
  ambiguous result must be inspected and never retried by rerunning the command.
- `stage-reviewed-synthetic` applies the same one-attempt boundary to a schema-2 preparation. It
  rechecks the review-file integrity hash, the compiled request/PDF authorization pins, authenticated
  deployment and recipient bindings, public values and the complete witness before loading the requester key.
  A version-1 review cannot authorize a different request. A version-2 demo-job review can bind fresh
  nonces and expiry only for the compiled ten-PDF batch and fixed deployment; its full request-file
  hash and digest are sealed into the preparation and rechecked during staging. The local service
  verifies the holder's EIP-712 signature before dispatch. The CLI remains a trusted operator tool,
  not a substitute for holder consent or an arbitrary-document upload endpoint.
- `inspect-stage` validates a staging journal without credentials or network access and prints only
  public identifiers plus hashes of artifact URIs.

Create the preparation with the network-disabled claim runner. This command accepts no document
path and can encode only the embedded, hash-pinned synthetic fixture:

```sh
mkdir -p proofs/network-journals
cargo run --manifest-path proofs/Cargo.toml --locked \
  -p ultratokenizer-claim-runner -- network-prepare-synthetic \
  proofs/elf/ultratokenizer-claim-guest \
  proofs/programs/claim-v2.json \
  proofs/network-journals/run.sp1-network-preparation.json
```

Load the requester key into the process environment without printing it, then obtain a short-lived
quote:

```sh
cargo run --manifest-path proofs/network-requester/Cargo.toml --locked -- \
  quote \
  proofs/network-journals/run.sp1-network-preparation.json \
  0xEXPECTED_REQUESTER \
  proofs/network-journals/run.sp1-network-quote.json
```

After separately authorizing the exact ELF and synthetic witness disclosure, stage them once:

```sh
cargo run --manifest-path proofs/network-requester/Cargo.toml --locked -- \
  stage \
  proofs/network-journals/run.sp1-network-preparation.json \
  0xEXPECTED_REQUESTER \
  proofs/elf/ultratokenizer-claim-guest \
  proofs/network-journals/run.sp1-network-staging.jsonl

cargo run --manifest-path proofs/network-requester/Cargo.toml --locked -- \
  inspect-stage proofs/network-journals/run.sp1-network-staging.jsonl
```

`PrivateStdin` keeps the artifact out of the ordinary public-input class. It is not a claim that the
proving network cannot process or observe the witness. Only the embedded fixture and the separately
reviewed allowlisted synthetic PDFs have an upload path; real Enpara evidence must remain local until its separate disclosure and authority
model is approved.

The completed 2026-09-11 staging run is summarized in the tracked
[public receipt](../programs/claim-v2-succinct-staging.json). The program was observed after staging,
the requester balance did not change between the adjacent quotes, and no proof request was submitted.
The receipt records hashes rather than artifact URIs and marks the source, bank authority and backing
claims as false.

Preparation, quote, staging, submission and proof artifacts use mandatory ignored suffixes. New
journals are created with mode `0600` on Unix. Never commit `.env` files, requester keys, witnesses,
journals, artifact URIs or proof artifacts.

The paid operations are `init-budget`, `prepare-request`, `submit-request` and `recover-request`.
They require explicit positive single-request and cumulative PROVE-wei caps, an existing completed
stage, and a fresh quote with its exact file hash. Preparation is offline. Submission records the
intent, exact EIP-191-signed protobuf, and dispatch attempt durably before one raw auction RPC call.
Once signing starts, reopening the journal cannot sign, refresh the nonce, or submit again.
Unsigned recovery checks request fields plus the recorded sender, nonce and signature; neither a
timeout nor an empty search releases the conservative cumulative budget. See the
[paid request procedure](PAID_REQUEST.md) for the exact settings, commands, and failure boundaries.
Recovery reports elapsed deadlines separately from service statuses, which can remain `Assigned`
after the proving window closes. Deadline expiry never authorizes another paid request.

Run `npm run check:network-requester` from the repository root for the pinned Rust formatting,
locked tests and clippy checks. The independent CI requester job runs the same command without
account secrets or live CLI operations. Shared journal-schema tests also run explicitly in the
native-evidence job. See the [coverage inventory](../../.github/VALIDATION.md).

This package has offline transport and persistence tests; those tests do not demonstrate an actual
paid request or a genuine proof. Recovery can record that a proof artifact is available but does not
download or verify it. The separate `retrieve-proof` command checks the recovered journal and an
independently reviewed HTTPS origin, retrieves bounded bytes, and records `downloaded_unverified`.
See the [retrieval procedure](RETRIEVAL.md); independent SDK/EVM verification is still required.
The only admitted remote candidate remains the original synthetic V2 program in the
shared request schema; a different Linux build is not admitted by these commands.

## Reviewed deployment-bound synthetic input

The original `network-prepare-synthetic` and `stage` commands and schema-1 journals remain supported;
old preparation IDs and serialized fields are unchanged. The reviewed path uses schema 2 and never
loosens the original embedded-fixture check. It preserves the same reviewed program VKey and ELF.

Prepare an owner-only review JSON with the following exact keys. Address and hash fields use
lowercase hex; SHA-256 fields and the signer fingerprint have no `0x` prefix. Replace placeholders
with independently reviewed values from the final request and admitted deployment. Do not derive
trust from values carried by an untrusted proof bundle.

```json
{
  "schemaVersion": 1,
  "purpose": "authorized-synthetic-testnet-proof",
  "sourceKind": "synthetic-signed-pdf-capsule",
  "synthetic": true,
  "productionApproved": false,
  "chainId": "296",
  "gate": "0xREVIEWED_GATE",
  "token": "0xREVIEWED_TOKEN",
  "recipient": "0xREVIEWED_RECIPIENT",
  "issuerId": "0xREVIEWED_ISSUER_ID",
  "sourceId": "0xREVIEWED_SOURCE_ID",
  "amountMilligrams": "1000",
  "signerFingerprint": "dab715c9d49c43851ab892db3d6a55f7f47d5685570cf340658567ab19fe113f",
  "pdfSha256": "44dc648ff3a8ab338ffe2a2857fb44668fc8917db292ab25fa384efb2d59bffa",
  "requestJsonSha256": "REVIEWED_EXACT_REQUEST_FILE_SHA256",
  "requestDigest": "0xREVIEWED_REQUEST_DIGEST"
}
```

The named PDF digest is the sole additional admitted synthetic document. A `synthetic: true` flag
cannot authorize another PDF. Native verification must still confirm its signature, signed capsule,
exact quantity and complete request binding. PDF, request and review files must be regular files
with owner-only permissions and no links; sizes are bounded. The review's exact byte hash is supplied
separately, preserved in the sealed preparation and rechecked at staging. Expired requests fail.

```sh
cargo run --manifest-path proofs/Cargo.toml --locked \
  -p ultratokenizer-claim-runner -- network-prepare-reviewed-synthetic \
  proofs/elf/ultratokenizer-claim-guest proofs/programs/claim-v2.json \
  work/review.json REVIEWED_REVIEW_FILE_SHA256 \
  work/allocation.synthetic.pdf work/request.json \
  work/run.sp1-network-preparation.json

cargo run --manifest-path proofs/network-requester/Cargo.toml --locked -- \
  stage-reviewed-synthetic work/run.sp1-network-preparation.json \
  0xEXPECTED_REQUESTER proofs/elf/ultratokenizer-claim-guest \
  work/run.sp1-network-staging.jsonl \
  work/review.json REVIEWED_REVIEW_FILE_SHA256 \
  work/allocation.synthetic.pdf work/request.json
```

Preparation performs local guest execution and PGU measurement, not a proof or upload. Staging
uploads the exact derived witness as PrivateStdin and can register the same program if necessary;
it does not submit a paid proof request. After staging, use the existing fresh quote, immutable budget,
prepare-request, submit-request and recovery procedure. Neither review metadata nor preparation
asserts chain admission: the operator must independently admit the actual Gate/token graph before
freezing the request. A changed request requires a new review, preparation, stage and paid plan.

Authorization and test boundary: the review-file hash proves file integrity, not independent
approval. `REVIEWED_SYNTHETIC_REQUEST_SHA256` and `REVIEWED_SYNTHETIC_REQUEST_DIGEST` in the
shared schema pin the separately approved request, including Gate, token, recipient, issuer,
reservation and expiry. Changing that request requires a reviewed source pin update, not just
resealing CLI inputs. These pins do not attest to bank status or on-chain deployment validity.
CI exercises authenticated reviewed-field comparisons using the embedded synthetic claim and
rejects relabeling that witness as the deployment PDF. It does not upload a witness, read a
requester key or prove live network acceptance. The approved deployment's private artifacts
remain outside the repository.

### Explicit public synthetic control

`stage` and `stage-reviewed-synthetic` retain private inputs. The separate
`stage-reviewed-public-synthetic` command can publish only an already allowlisted, reviewed
synthetic preparation. It requires additional, explicit authorization for **public** witness
visibility. A local `privateStdinEnabled` setting does not establish that Succinct has enabled
private inputs for a requester; [private inputs require provider enablement](https://docs.succinct.xyz/docs/sp1/prover-network/advanced-usage).

Prepare this separate authorization file for human review. Keep `authorizedPublicDisclosure`
false until approval covers the complete synthetic PDF, certificate/signature material and
request encoded in the witness. The preparation ID binds their exact hashes and the pinned ELF,
VKey and public values. The requester and review hash are checked independently.

```json
{
  "schemaVersion": 1,
  "purpose": "public-synthetic-sp1-control",
  "authorizedPublicDisclosure": false,
  "preparationId": "EXACT_EXISTING_PREPARATION_ID",
  "requester": "0xEXPECTED_REQUESTER",
  "reviewManifestSha256": "REVIEWED_REVIEW_FILE_SHA256",
  "validUntilUnix": 0
}
```

After approval, set the approved expiry and disclosure flag, review the exact file hash, and
use a **new attempt directory**. Do not modify an existing private staging or paid journal.

```sh
network-requester stage-reviewed-public-synthetic \
  work/public-control/run.sp1-network-preparation.json \
  0xEXPECTED_REQUESTER proofs/elf/ultratokenizer-claim-guest \
  work/public-control/run.sp1-network-staging.jsonl \
  work/public-control/review.json REVIEWED_REVIEW_FILE_SHA256 \
  work/public-control/allocation.synthetic.pdf work/public-control/request.json \
  work/public-control/public-disclosure.json REVIEWED_PUBLIC_DISCLOSURE_FILE_SHA256
```

Staging uses `ArtifactType::Stdin`, records the disclosure in its append-only intent and permits
no proof submission. The ordinary quote/prepare/submit commands retain that authorization in
the sealed plan and encode `stdin_private = false`. A public/private URI or journal substitution
fails before paid dispatch. Private plans omit the new field so existing plan hashes remain valid.
Recovery and retrieval compare the signed visibility flag with the exact observed request.

Changing visibility preserves the underlying witness identity. An already reserved witness
cannot get another spending slot in the same budget. An explicitly approved comparison therefore
needs a separately reviewed attempt budget **while retaining every old outstanding maximum in
the operator's global spending calculation**. This is a second paid request, not recovery or a
refund of the private request. Never reset a budget, reuse journals or automatically resend.
Neither a public upload nor a successful control proves the cause of an earlier private failure.
No source document, witness or credential is committed by this workflow.
