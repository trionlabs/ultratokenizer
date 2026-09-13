# Adopt a verified proof from a separate public control request

This operator command can attach a real Groth16 proof to the **same existing
issuance job** when a separate, explicitly authorized public synthetic request
produced it. It cannot use an execution result, failed network proof, arbitrary
PDF, different holder, new reservation, or illustrative fixture as a substitute.
There is no HTTP route, browser control, new allocation, payment or submission.

Stop and reconcile the existing service observer and the separate public observer
first. The command opens the original `JobStore` exclusive lock. Do not delete a
running process's lock. Review the stable artifacts before computing their hashes.

```sh
node packages/demo-service/src/import-proof.mjs \
  --config work/runtime/hedera-testnet/document-flow/service.json \
  --review work/runtime/hedera-testnet/import-review.json \
  --review-sha256 REVIEWED_EXACT_FILE_SHA256
```

The owner-only review JSON uses these exact fields:

```json
{
  "format": "ultratokenizer.verified-proof-import.v1",
  "purpose": "adopt-separate-public-synthetic-proof",
  "jobId": "EXISTING_JOB_ID_WITHOUT_0X",
  "requestDigest": "0xEXISTING_JOB_ID",
  "reservationTransactionHash": "0xORIGINAL_RESERVATION_HASH",
  "originalRequestJournalSha256": "EXACT_ORIGINAL_PRIVATE_REQUEST_JOURNAL_SHA256",
  "originalBudgetSha256": "EXACT_ORIGINAL_PRIVATE_BUDGET_SHA256",
  "outputPath": "work/runtime/hedera-testnet/verified-proof-import/EXISTING_JOB_ID_WITHOUT_0X",
  "source": {
    "preparation": {
      "path": "REVIEWED_SOURCE_PREPARATION_PATH",
      "sha256": "EXACT_SHA256"
    },
    "requestJournal": {
      "path": "REVIEWED_SOURCE_REQUEST_JOURNAL_PATH",
      "sha256": "EXACT_SHA256"
    },
    "budget": {
      "path": "REVIEWED_SOURCE_BUDGET_PATH",
      "sha256": "EXACT_SHA256"
    },
    "rawProof": {
      "path": "REVIEWED_SOURCE_RAW_PROOF_PATH",
      "sha256": "EXACT_SHA256"
    },
    "normalizedProof": {
      "path": "REVIEWED_SOURCE_NORMALIZED_PROOF_PATH",
      "sha256": "EXACT_SHA256"
    },
    "retrieval": {
      "path": "REVIEWED_SOURCE_RETRIEVAL_RECEIPT_PATH",
      "sha256": "EXACT_SHA256"
    },
    "originAdmission": {
      "path": "CONFIGURED_ORIGIN_ADMISSION_PATH",
      "sha256": "EXACT_SHA256"
    }
  }
}
```

All source paths except origin admission must be canonical repository-relative
paths below `work/runtime/hedera-testnet/document-flow/public-control-demo04/`.
Origin admission must be the exact configured network origin-admission file.
Files must be owner-only; symlinks, changed hashes, alternate directories and
unknown fields are rejected. The output directory is derived from the existing
job ID. Existing output files are never overwritten; a partial import requires
operator review before another attempt.

The command authenticates the saved holder signature and compares the original
request, sealed preparation, source fingerprint/program bindings, reservation and
both proof-request identities. It retains the original private request journal
and budget in place. The public request must explicitly carry public synthetic
disclosure and its own distinct paid budget.

`retrieve-proof` then revalidates the complete signed public request journal and
current fulfillment through the existing requester, and downloads into fresh
private import outputs. Raw and normalized hashes must match the reviewed source
artifacts. The native `export-groth16` command checks SP1 proof cryptography using
the pinned ELF/vkey. The runtime checks all 224 public-value bytes against the
original preparation, calls the pinned deployed verifier and rechecks its block.
It verifies the original reservation is unused before and after this work.

Only then does it append normal job state through `JobStore.update`, retain
`provenance.json`, and call the existing issuer permit method. Permit failure
keeps the verified proof and provenance available for the normal authorized
permit-refresh path. A successful import does not release, refund or erase either
proof budget. The original provider liability still needs independent settlement.

Tests use explicitly injected retrieval and cryptographic-verification results;
they do not claim genuine network or chain acceptance:

```sh
node --test packages/demo-service/test/verified-proof-import.test.mjs
npm run check:demo-service
```

Runtime evidence is required before executing this command. An unfulfillable or
verification-failed control request supplies no importable proof, even if its
public-value execution matched the expected result.
