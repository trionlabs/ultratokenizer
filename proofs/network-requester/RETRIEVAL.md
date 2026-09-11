# Bounded proof artifact retrieval

`retrieval::retrieve_once` retrieves one artifact for an already recovered, fulfilled synthetic
request. The module requires no requester key. It cannot sign, submit, upload, cancel, replace a
request, refresh a nonce, or release the paid budget. Its result is always
`downloaded_unverified`. The `retrieve-proof` CLI exposes this boundary separately from recovery
and paid submission:

```sh
proofs/network-requester/target/debug/ultratokenizer-network-requester retrieve-proof \
  proofs/network-journals/run.sp1-network-request.jsonl \
  EXPECTED_REQUEST_JOURNAL_SHA256 \
  proofs/network-journals/origin.sp1-network-submission.json \
  proofs/network-journals/run-raw.sp1-network-proof \
  proofs/network-journals/run-normalized.sp1-network-proof \
  proofs/network-journals/run-retrieval.sp1-network-submission.json
```

The origin JSON is limited to 16 KiB. No command argument contains a key or artifact URI.

## Inputs and authority

Retain the original mode-`0600` request journal and select its exact whole-file SHA-256 independently
of the network response. The latest durable event must identify that same request and transaction
as `FULFILLED` and `EXECUTED`, with a nonempty proof URI and its matching SHA-256. The complete
journal is locked during retrieval. Its event chain, recovered signature, original prepared intent,
and exact file hash are checked before any network read. The hashed snapshot must also match the
locked parsed events. Journals with observations ahead of the local clock are rejected.

The operator supplies one `OriginAdmission` with exactly these JSON fields:

| Field            | Required value                                                                  |
| ---------------- | ------------------------------------------------------------------------------- |
| `format`         | `ultratokenizer.reviewed-artifact-origin.v1`                                    |
| `origin`         | One independently reviewed canonical HTTPS DNS origin, without a trailing slash |
| `evidenceSha256` | Nonzero lowercase SHA-256 of the retained origin-review evidence                |
| `maximumBytes`   | Positive integer, at most `1048576`                                             |

An origin admission is an operator trust input. The evidence hash is a reference to retained review
material; the module does not fetch that material or prove its correctness. Never create the
admission merely by copying the host from a returned URI. The URI's canonical origin must match
the reviewed origin exactly. Literal IP addresses, local hosts, credentials, fragments, non-HTTPS
schemes, alternate ports, and URLs longer than 2,048 bytes are rejected. DNS and certificate
validation still rely on the chosen origin and the host's normal trust store. No origin is bundled
as a production default. If the service changes its origin or returns a non-HTTPS URI, retrieval
remains blocked until that delivery mechanism receives separate review.

`originAdmissionSha256` in the receipt hashes the admission's compact typed JSON serialization,
not the input file's whitespace. `requestJournalSha256` hashes the exact journal file bytes.

## Fresh binding and response limits

Before the GET, three unsigned reads re-check:

1. Every exposed immutable request field against the recovered signed protobuf and prepared plan.
2. The request transaction's exact hash, request ID, requester, nonce, and signature.
3. The current fulfilled/executed status, original request transaction, deadline, execution public
   values hash, exact recorded artifact URI, and nonzero fulfillment transaction hash.

Missing or changed data fails before downloading. A changed artifact URI requires another exact
recovery observation and a new review of the resulting journal hash. These reads are observations
from the pinned Succinct TLS service; they are not independent inclusion proofs. A returned
fulfillment transaction hash is recorded, with `independentInclusionVerified: false`.

The status API may omit its optional execution hash. In that case only the matching execution-result
hash in the already bound request-details response, explicitly marked executed, can supply it.
Every hash returned by either response must equal the signed expected hash. Conflicting hashes,
or executed status with neither usable commitment, fail before downloading.

The whole asynchronous retrieval has a 120-second deadline. The production RPC implementation
bounds each call to 20 seconds and each protobuf response to one MiB. The HTTPS transport disables
proxies, redirects, automatic retries, and all transparent content decompression. It requests
identity encoding, allows only HTTPS, uses a 10-second connection timeout and a 60-second GET/body
timeout, and performs one GET. The response must have status 200, the exact requested URL, and no
content encoding other than one literal `identity` value. Multiple encoding headers are rejected.

Both the declared content length and streamed body are bounded by `maximumBytes`. Missing content
length does not relax the bound. Empty bodies, empty chunks, more than 4,096 chunks, truncated
bodies, read failures, and declared/actual length disagreements fail. Local filesystem durability
still depends on the host; the asynchronous deadline is not a hard timeout for an unresponsive
filesystem or a whole-process memory limit.

## Structural normalization

Only fixed-integer, trailing-byte-free bincode encodings of `ProofFromNetwork` or
`SP1ProofWithPublicValues` are accepted. Re-encoding must reproduce the original bytes exactly.
The Groth16 enum discriminator is checked before deserializing other proof families. The decoder
has a separate one-MiB bound. A network envelope is converted into the SDK envelope with
`teeProof: None`; an existing SDK envelope must already have no TEE proof.

The wrapper must use the original admitted synthetic VKey, exact 224 public values and SHA-256,
and outer circuit `v6.1.0`. The 352-byte Groth16 encoding must be lowercase hexadecimal and carry
zero exit code, the pinned recursion root, and the full pinned Groth16 verifier hash. Its five
public-input metadata values must match the admitted VKey, masked SHA-256 of the exact public
values, exit code, recursion root, and encoded nonce.

These are serialization and binding checks. They do not perform a pairing check, prove the guest
ran, authenticate a bank, or prove gold backing. The decoder deliberately accepts the test's
structurally matching envelope with invalid all-zero pairing coordinates; independent verification
must reject it. Auxiliary SDK fields are not treated as separate evidence of validity.

## Private outputs and failure recovery

Supply distinct new paths for raw and normalized bytes, both ending in `.sp1-network-proof`, and
a receipt path ending in `.sp1-network-submission.json`. These suffixes are already Git-ignored.
Files are created with `create_new`, mode `0600` on Unix, file sync, and parent-directory sync.
Existing files are never overwritten. A partial save leaves its exact created files for inspection
and returns an error; it never fabricates a receipt. Do not interpret a file's presence alone as
successful retrieval or verification.

The receipt contains hashes of the private URI, raw artifact, and normalized artifact, plus request
identifiers and a local timestamp for the fresh status observation. It never includes the URI.
`proofCryptographicallyVerified`, `independentInclusionVerified`, and `budgetReleased` are all false.
Neither the request journal nor the budget is changed. A failed or interrupted read is not grounds
to resubmit a paid request. Retain partial output files and the original journal for review before
choosing any new retrieval output paths.

## Independent proof verification

First re-check the raw and normalized output SHA-256 values against the retrieval receipt and the
selected original program manifest. Run the network-disabled claim runner with the original
admitted ELF, reviewed synthetic request JSON, normalized proof, and explicit admitted VKey:

```sh
proofs/target/debug/ultratokenizer-claim-runner verify-local \
  proofs/elf/ultratokenizer-claim-guest \
  proofs/claim-evidence/fixtures/request.synthetic.json \
  proofs/network-journals/run-normalized.sp1-network-proof \
  EXPECTED_ADMITTED_PROGRAM_VKEY
```

The runner derives the VKey from the ELF, checks the request/public-values binding and verifies
cryptographically with the light SDK verifier. Only after successful independent verification may
`export-groth16` produce the EVM envelope. Direct verifier and Gate acceptance on the EVM remain
separate checks. A local state test using a permissive verifier does not close them.

## Pinned implementation basis and evidence scope

The locked SDK's [download implementation](https://github.com/succinctlabs/sp1/blob/cfb55443120fe5a13f63eaf60bdab6edc269c9a1/crates/sdk/src/network/client.rs#L812)
uses the reported proof URI directly but wraps downloads in retries and materializes the body.
This module implements its own bounded transport. The supported
[SDK proof wrappers](https://github.com/succinctlabs/sp1/blob/cfb55443120fe5a13f63eaf60bdab6edc269c9a1/crates/sdk/src/proof.rs)
are checked against installed `sp1-sdk 6.2.4`. The existing lock resolves the verifier to
`sp1-verifier 6.7.0`; its [Groth16 envelope implementation](https://github.com/succinctlabs/sp1/blob/cd7850de24cd611683a961a8dcb64c94f7876b7a/crates/verifier/src/groth16/mod.rs)
and [recursion root](https://github.com/succinctlabs/sp1/blob/cd7850de24cd611683a961a8dcb64c94f7876b7a/crates/verifier/src/lib.rs)
were checked directly. SHA-256 of the installed `groth16_vk.bin` is
`4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696`, matching the committed
synthetic manifest and existing claim-runner export pin. No dependency or admitted program pin
changes are part of retrieval.

Offline tests use synthetic signed request journals, real SDK serialization, and injected read-only
RPC/HTTP responses. They cover exact bindings, origin restrictions, streamed limits, decoder
failures, deadline cancellation, output permissions, and partial saves. They demonstrate neither
a real artifact download nor genuine proof verification.
