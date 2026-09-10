# SP1 Network requester

This standalone crate is the credential-bearing boundary for Succinct mainnet. Its dependency lock
is separate from the evidence workspace, so enabling the SP1 network stack cannot silently change
the reviewed guest build. It accepts only the integrity-sealed, embedded synthetic V2 fixture. It
has no command that accepts an arbitrary document or witness.

The binary exposes three operations:

- `quote` verifies the requester address from `NETWORK_PRIVATE_KEY` and reads current Groth16 auction
  parameters, PROVE balance and program-registration state. It performs no upload or proof request.
- `stage` rederives the synthetic witness, checks the preparation, ELF hash and VKey, then performs
  at most one program registration and uploads the witness as `PrivateStdin`. It cannot submit a
  proof request. Every external attempt is recorded in a new append-only mode-`0600` journal; an
  ambiguous result must be inspected and never retried by rerunning the command.
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
proving network cannot process or observe the witness. Only the reviewed synthetic fixture has been
authorized; real Enpara evidence must remain local until its separate disclosure and authority
model is approved.

The completed 2026-09-11 staging run is summarized in the tracked
[public receipt](../programs/claim-v2-succinct-staging.json). The program was observed after staging,
the requester balance did not change between the adjacent quotes, and no proof request was submitted.
The receipt records hashes rather than artifact URIs and marks the source, bank authority and backing
claims as false.

Preparation, quote, staging, submission and proof artifacts use mandatory ignored suffixes. New
journals are created with mode `0600` on Unix. Never commit `.env` files, requester keys, witnesses,
journals, artifact URIs or proof artifacts.

A future paid submission command must require a fresh quote, its exact hash, an exact single-request
PROVE cap and a total-attempt PROVE cap. It must issue one RPC submission only and recover ambiguous
responses by request/nonce lookup without automatic resubmission. No such command exists yet.
