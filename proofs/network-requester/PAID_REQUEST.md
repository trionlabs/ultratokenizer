# Reviewed one-shot paid request

These commands are an operator boundary for one reviewed synthetic request. They are not a service,
a scheduler, a USD price oracle, or authorization to spend. Obtain explicit authorization for the
requester, disclosed synthetic input, exact quote, positive per-request cap and positive total cap
before `submit-request`. Caps are canonical decimal integers in PROVE wei (10^18 wei per PROVE).
The operator must derive them from the separately authorized spending budget and a fresh price; the
binary does not turn a USD authorization into an exchange-rate guarantee.

Build and test before obtaining the five-minute quote:

```sh
cargo build --manifest-path proofs/network-requester/Cargo.toml --locked --offline
cargo test --manifest-path proofs/network-requester/Cargo.toml --locked --offline
cargo clippy --manifest-path proofs/network-requester/Cargo.toml --locked --offline --all-targets -- -D warnings
```

Only `submit-request` below is a paid write. `init-budget` and `prepare-request` are offline and do
not load a key. `recover-request` uses unsigned bounded reads and does not load a key. Existing
`quote` verifies `NETWORK_PRIVATE_KEY` against an explicit requester but performs reads only;
existing `stage` has separate program/artifact-write authorization and must not be repeated to
resolve an ambiguous paid request. Do not print a key, private journal, signed request, or artifact
URI into a terminal transcript.

## Offline immutable budget

Create one new budget journal once, before the first attempt. The placeholders below must be
replaced with reviewed values; no default caps or requester are supplied.

```sh
proofs/network-requester/target/debug/ultratokenizer-network-requester init-budget \
  EXPECTED_REQUESTER SINGLE_CAP_WEI TOTAL_CAP_WEI \
  proofs/network-journals/run.sp1-network-budget.jsonl
```

The file is created with `create_new`, mode `0600` on Unix, a file lock, a hash-linked first event,
file sync and parent-directory sync. Its first event fixes the requester, network and both caps.
All later maximum-cost reservations count against the cumulative cap permanently. The package has
no release, reset, edit-limit or automatic new-budget operation. Submit holds the same budget lock
through signing and dispatch, so competing processes using this journal cannot spend its cap twice.

This is a conservative local encumbrance ledger, not a measurement of settled fees. It does not
control other software using the account or a trusted operator who copies, rewrites, deletes or
replaces the journals. Run only one paid workflow for the account and retain its original budget
through every ambiguity. The hash chain detects accidental drift; it is not an authentication code
against the operator who owns the files. File locking and durability assume a local filesystem with
working advisory locks and `fsync` semantics.

## Exact quote and stage admission

Obtain a new quote after staging has definitively completed. The quote must report the program
registered and sufficient balance. A reviewed settings file with suffix
`.sp1-network-submission.json` has exactly these fields:

| Field                     | Type and rule                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `schemaVersion`           | Integer `1`                                                                                            |
| `quoteId`                 | The selected quote's sealed ID                                                                         |
| `quoteFileSha256`         | Lowercase 64-character SHA-256 of the exact quote file bytes, including whitespace                     |
| `stagingJournalSha256`    | Lowercase 64-character SHA-256 of the exact completed staging file bytes                               |
| `deadlineUnix`            | Explicit positive UTC seconds; at most 14,400 seconds after quote observation                          |
| `minAuctionPeriodSeconds` | Explicit integer, no larger than the remaining request lifetime                                        |
| `proverWhitelist`         | Explicit array of at most 32 distinct lowercase nonzero addresses; `[]` deliberately allows any prover |

There are no authority overrides or automatic prover-list lookups. Quote parameters supply the
auction domain, auctioneer, executor, verifier, treasury, base fee and PGU price. The preparation
supplies the pinned VKey, `sp1-v6.1.0`, Groth16 mode, exact cycle and gas limits and SHA-256 of the
224 public values. The completed, hash-reviewed stage supplies the program and private-stdin URIs.
The quote ID and exact byte hash both have to match. At preparation, signing and dispatch the quote
must still be in its review window of no more than 300 seconds and at least 300 seconds must remain
before the proof deadline. The request may finish after the short quote review window.

```sh
proofs/network-requester/target/debug/ultratokenizer-network-requester prepare-request \
  proofs/network-journals/run.sp1-network-preparation.json \
  proofs/network-journals/run.sp1-network-quote.json \
  proofs/network-journals/run.sp1-network-staging.jsonl \
  proofs/network-journals/run.sp1-network-submission.json \
  proofs/network-journals/run.sp1-network-budget.jsonl \
  proofs/network-journals/run.sp1-network-request.jsonl
```

This creates and syncs the exact prepared intent, then reserves
`baseFee + gasLimitPgu × maxPricePerPgu` under both caps using checked integer arithmetic. It rejects
reusing the underlying VKey/witness/request/public-values identity even when a new preparation or
quote timestamp changes the outer IDs. A failure between the two files may leave a prepared file
without a budget reservation; it cannot be submitted. There is no automatic repair or release for
this deliberately conservative state.

These inputs are reviewed institutional/operator evidence. A self-sealed JSON journal is not proof
that an artifact service stored the right bytes. The preceding staging command rederives only the
embedded synthetic witness and checks its preparation, ELF and VKey. The paid command accepts the
completed stage's exact reviewed hash; it cannot authenticate external gold or bank ownership.

## One signed dispatch

After reviewing the final prepared request and existing budget, load the explicitly authorized
requester key in `NETWORK_PRIVATE_KEY` without exposing it, then run once:

```sh
proofs/network-requester/target/debug/ultratokenizer-network-requester submit-request \
  proofs/network-journals/run.sp1-network-request.jsonl \
  proofs/network-journals/run.sp1-network-budget.jsonl
```

The command rechecks the exact current auction parameters, registered program, current balance and
one nonce. A read failure or mismatch causes no signature or paid write. It then performs these
durability barriers in order:

1. Record the full protobuf signing intent and nonce, then sync.
2. Sign that body using the local EIP-191 signer, independently recover its address, record the full
   signed protobuf plus SHA-256, then sync.
3. Record the matching dispatch attempt, then sync and check freshness again.
4. Call the raw auction `RequestProof` method once. Record a well-formed acknowledgement as a lookup
   hint, not proof of inclusion or proof generation.

There is no high-level SDK `request_proof`, `prove`, `wait`, retry, nonce refresh, upload or cancel in
this path. If any barrier fails, the paid RPC is not called. If the RPC or post-send journal write
fails, the earlier signed request remains the recovery reference. A recorded signing intent makes
every subsequent invocation of `submit-request` fail before obtaining a new nonce or signature,
including when signing itself failed. A stuck intent or expired prepared request stays encumbered;
do not create a replacement budget or treat RPC silence as proof nothing happened.

## Exact unsigned recovery and proof handoff

```sh
proofs/network-requester/target/debug/ultratokenizer-network-requester recover-request \
  proofs/network-journals/run.sp1-network-request.jsonl
```

Recovery checks every exposed immutable request field, then `GetTransactionDetails` for the exact
requester, nonce, raw signature, request ID and transaction hash. The locally recovered EIP-191
signature binds the full original protobuf, including fields omitted by the request-details API.
A response acknowledgement is only a lookup hint and may be corrected by exact recovery; a
previously recovered identity cannot be replaced. Missing/redacted fields, unknown statuses,
overlapping pages, multiple matches, or an unavailable lookup remain unresolved. A successful
lookup is an observation from the authenticated RPC service, not an independent chain inclusion
proof.

The unsigned command has a 120-second recovery deadline after connection, at most five pages of
100 candidates, at most eight transaction-detail reads, and a one-MiB protobuf response limit per
RPC. It does not retry failed calls or infer absence from reaching a limit or finding zero matches.
It validates the status transaction hash, deadline and any execution public-values hash before
recording status. An omitted status execution hash can be supplied only by the exact-bound,
executed request-details response; every returned hash must match the signed expected value.
It prints only identifiers and a hash of any proof URI. Fulfilled status remains
`proofVerified: false`; recovery does not download or implicitly accept an artifact.

All request and budget journals must remain intact and private. A torn append, invalid hash chain,
permissive file mode, lock conflict or clock regression fails closed. This package does not repair
a damaged journal: retain its exact bytes and the earlier durable signed intent for separate
reviewed forensic recovery. It never treats that failure as permission for a fresh request.

The separate [retrieval command](RETRIEVAL.md) accepts only the exactly recovered artifact using
an independently reviewed origin and bounded HTTPS responses. Verify the serialized proof
independently against the admitted ELF/VKey and exact public values. The EVM verifier check is a
separate step. Neither downloaded bytes nor a network `FULFILLED` response is a genuine-proof
acceptance result.

## Pinned upstream basis and validation scope

The installed `sp1-sdk 6.2.4` crate records upstream commit
`cfb55443120fe5a13f63eaf60bdab6edc269c9a1`. Its
[high-level request implementation](https://github.com/succinctlabs/sp1/blob/cfb55443120fe5a13f63eaf60bdab6edc269c9a1/crates/sdk/src/network/client.rs#L585)
wraps request creation in a retry closure that reads a nonce. This package uses its exact
[auction protobuf fields](https://github.com/succinctlabs/sp1/blob/cfb55443120fe5a13f63eaf60bdab6edc269c9a1/crates/sdk/src/network/proto/auction/types.rs#L139)
and the SDK's
[protobuf signing convention](https://github.com/succinctlabs/sp1/blob/cfb55443120fe5a13f63eaf60bdab6edc269c9a1/crates/sdk/src/network/utils.rs)
through one raw tonic call instead. The direct `alloy-primitives 1.5.3` dependency is the same
version already in this standalone lockfile; it provides independent EIP-191 signer recovery.

Offline tests cover durable on-disk signed bytes at the network seam, every pre-send persistence
barrier, post-send write failure, restart and competing-process locking, immutable cumulative
caps, timestamp resealing, exact quote/stage bytes, changed current quote parameters, expiry,
bounded recovery, wrong nonce/signature/request fields, misleading acknowledgements and status
binding. All keys, URIs and transport results in those tests are synthetic fixtures. No live
request, paid service, artifact retrieval, genuine SP1 proof or Hedera execution is claimed by them.
