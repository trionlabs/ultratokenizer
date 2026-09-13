# Local document preparation service

This Node-only service connects the holder's document screen to the existing institution ledger,
issuer client and SP1 requester. The browser uploads a signed PDF, approves one exact issuance
request in its wallet, and receives a real verified bundle when proof generation and issuer
authorization finish. The browser remains responsible for submitting and confirming the mint.

The supported input is a closed batch of ten SHA-256-pinned synthetic gold PDFs. Each represents
exactly 1,000 milligrams for its signed recipient. Native CMS/capsule verification runs before a
document is accepted and again against the newly prepared request. This does not produce a ZK
proof. Raw EML, arbitrary PDFs, real bank documents, quantity selection and issuer selection are
not supported by this demo profile.

## Run

Run from the repository root after building domain, issuance and institution packages:

```sh
node packages/demo-service/src/main.mjs work/runtime/hedera-testnet/document-flow/service.json
```

The private configuration, source manifest, PDFs, ledger, credentials and job journals stay
Git-ignored. The service binds only `127.0.0.1`. A local preview server proxies `/api` to its port;
the configured browser origin must match exactly. The API never serves static source documents,
configuration files or credentials. `GET /api/health` performs no RPC call.

Required configuration fields:

| Field                                     | Meaning                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `format`                                  | `ultratokenizer.demo-service.v1`                                                                                        |
| `origin`, `port`                          | Exact loopback browser origin and loopback API port                                                                     |
| `deploymentPath`, `discoveryPath`         | Independently admitted deployment and published 8004 attribution index                                                  |
| `manifestPath`                            | Private ten-document manifest with exact file hashes and source identities                                              |
| `policyTermsPath`, `rightsTermsPath`      | UTF-8 terms; both hashes must match canonical Gate records                                                              |
| `storePath`, `ledgerPath`                 | Private job directory and unified institution ledger                                                                    |
| `claimRunnerPath`, `networkRequesterPath` | Existing compiled native tools                                                                                          |
| `programManifestPath`, `elfPath`          | Admitted SP1 program manifest and matching ELF                                                                          |
| `issuerLabel`, `issuerCredential`         | Display label and `{path, variable}` for the issuer credential                                                          |
| `maxReservationFeeTinybar`                | Maximum gas fee liability for each issuer reservation transaction                                                       |
| `operationsEnabled`                       | Explicit operator dispatch switch, initially `false`                                                                    |
| `budgetReviewPath`                        | Time-bounded USD review retaining previous budget liability and pinning the new budget identity                         |
| `network`                                 | Requester address/credential, existing budget journal, admitted artifact origin, disclosure approval and proving limits |

`network` contains `requesterAddress`, `credential: {path, variable}`, `budgetPath`,
`originAdmissionPath`, `privateStdinEnabled`, `disclosureApproved`, `approvalValidUntilUnix`,
`proofDeadlineSeconds` (300–14,400), `minAuctionPeriodSeconds` and `proverWhitelist`.
Credential values are read only for an explicitly enabled, holder-authorized operation. A disabled
service can inspect documents without reading credentials. Configuration changes require a service
restart; stopping the service is the immediate local dispatch stop.

8004 supplies attribution. Gate registrations and separately admitted deployment pins determine
authority. The terms response reports `checked: true` only after checking both exact text hashes
against the pinned Gate at one canonical RPC block. This remains a trusted-RPC observation.

## Browser contract

| Endpoint                    | Input/result                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/config`           | Selected issuer, terms and readiness; no private settings                                 |
| `POST /api/documents`       | Binary `application/pdf`, at most 256 KiB; authenticated fixed amount and recipient       |
| `POST /api/jobs/prepare`    | `{documentId, recipient}`; immutable request, digest and `PreparedIssuanceRequest`        |
| `POST /api/jobs/:id/start`  | `{holderSignature}` over the exact EIP-712 issuance request                               |
| `GET /api/jobs/:id`         | Separate proof/issuance phase, status and artifact readiness                              |
| `GET /api/jobs/:id/bundle`  | Existing verified issuance bundle, only with a current permit                             |
| `POST /api/jobs/:id/permit` | `{holderSignature}`; explicit same-proof permit refresh or resume after issuer activation |

`documentId` is the unprefixed PDF SHA-256; `jobId` is the unprefixed request digest. JSON POSTs
accept only their named fields and are limited to 16 KiB. Every POST requires the exact browser
Origin. Responses are uncached and contain a bounded error code/message, never raw process errors,
signed issuer transactions, credentials, source paths or artifact URIs. A status `transactionHash`
identifies the reservation, not a mint.

Uploading the same document again reports its existing signed job status. While that request is
valid, preparation returns it unchanged, even when the budget blocks new proofs. The holder signs
the same request to resume; the authenticated start returns its current status without reserving,
dispatching or paying again. Proof and receipt acceptance still require their normal verification.

## Real execution and recovery boundaries

1. Authenticate the allowlisted PDF; preserve its opaque claim identity and exact amount. Prepare
   one durable request for that document. The holder must sign that exact request before any
   ledger allocation, issuer signing, upload or payment.
2. Reserve in the unified institution ledger. Use `openPreparedReservation` and
   `waitPreparedReservation` to create and authenticate the exact chain reservation. All issuer
   reservation sends share one serialized nonce stream. Their intent, signed transaction and
   dispatch marker are durable before broadcast. An uncertain reservation stops subsequent sends.
3. Run native SP1 network preparation with the unchanged admitted guest. Use the existing requester
   for one staging operation, fresh quote, budget reservation and one paid submission. The service
   never creates a budget, raises its caps or retries an ambiguous submission. Recovery is unsigned
   and bounded by the request deadline. Elapsed time is not a terminal status or a refund.
4. Retrieve only from the separately admitted artifact origin. Check its recorded hashes, run the
   SDK's actual Groth16 verification/export, and call the pinned on-chain verifier at a canonical
   block. Only then request an issuer permit lasting at most 600 seconds and expose the bundle.
5. The browser re-verifies the bundle and retains its matching holder signature. The holder signs
   the final mint transaction in the wallet. Receipt verification uses the separate audit policy.

The Gate may remain paused during preproof reservation and proving. Final bundle authorization
requires deliberate Gate activation. A failed or expired permit can be refreshed against the same
verified proof; this endpoint cannot request a replacement proof.

There is one process lock and at most ten active durable jobs. An expired preparation can be
replaced only while it remains an untouched `awaiting_signature` draft: no persisted signature,
state update, extra field or file is allowed. The old directory is retained under
`expired-unsigned/`; its job ID stops resolving and its signature cannot authorize the fresh
request. This prevents an unauthenticated preparation from permanently consuming a document.
Signed jobs and jobs with possible reservation or proof side effects always require reconciliation.

Concurrent updates use per-job queues and
a hash-linked event log; reopening checks the request digest and journal continuity. A crash during
an operation becomes `attention_required`, with no automatic redispatch. A leftover process lock
must be checked against the running process before an operator removes it. Keep signed transaction
and SP1 journals when reconciling. Do not delete a job or release its ledger allocation to retry.
Automatic crash recovery, cancellation/release and final mint-to-ledger reconciliation are not
service endpoints; use the existing trusted institution chain bridge and requester recovery tools.

An operator may explicitly continue one narrowly identified pre-upload failure:

```sh
node scripts/start-document-demo.mjs --resume-prepared-proof <existing-64-hex-job-id>
```

Stop the existing launcher first and correct its private credential configuration. This startup
option keeps the status API available while continuing the same job; it is not an HTTP endpoint.
It accepts only a signed, reserved job stopped with `invalid_request` or `operations_disabled`,
with matching request/review/native preparation and no staging, quote or paid-request artifacts.
It rechecks the existing reservation against canonical chain observations and rejects any consumed,
cancelled or expired right. An exclusive durable continuation marker prevents a second attempt,
including after a crash. The reservation and preparation files are retained; no allocation or
reservation is repeated. Rust staging still re-authenticates the PDF and re-derives the witness
against the sealed preparation before upload. Any later or ambiguous job requires operator
reconciliation instead. Both issuer and requester credentials are validated before a new start can
persist its dispatch signature or reserve backing.

For an already acknowledged or exactly recovered paid request whose observation stopped, use a
different explicit startup option:

```sh
node scripts/start-document-demo.mjs --resume-submitted-proof <existing-64-hex-job-id>
```

This validates the retained preparation, signed request identity and matching reserved budget
entry, then invokes only unsigned observation, retrieval and proof verification. It cannot stage,
quote, prepare, sign or submit another paid request, and does not require unused proof budget.
Expired authorization for new spending does not stop read-only observation; producing a fresh issuer
permit still requires current operation approval. Only one observer runs per process. After a later
observation failure the operator can explicitly resume that same request again. Malformed journals,
conflicting identities, unacknowledged requests and partial retrieval artifacts fail closed.

The observer retries at most three consecutive recognized transport failures with fifteen-second
spacing, within the existing signed proof deadline. The UI reports temporary observation failure
without claiming another proof was submitted. Commitment mismatches and corrupt data are never
classified as transient transport errors. No timed wait, deadline or observation failure releases
budget or creates permission to submit a replacement.

An unresolved earlier request keeps its conservative budget liability. A distinct allowlisted
document may start only under an explicit aggregate USD review that retains the prior budget caps,
pins the new budget's immutable Created identity, and admits a new bounded budget within the user's
total authorization. Appending a reservation does not change that Created identity. Prior request
uncertainty never authorizes a retry of its witness or a reset of its budget. Disclosure approval,
private-input readiness and the explicit dispatch switch must also pass. The proving deadline
leaves time for a permit before the approval expires. A successful document upload does not mean a
proof exists or that minting is ready.

Before starting a new job, the remaining budget must cover the entire single-request cap. Only one
unfinished document may enter reservation/proof dispatch at a time, including interrupted jobs
after a restart. This prevents a second document from reserving backing while the first has not
yet reserved its proving fee. Polling and same-proof permit refresh remain available when the
remaining budget cannot cover another proof.

## Validation

```sh
npm --prefix packages/demo-service test
npm run check:network-requester
```

Tests exercise real EIP-712 and issuer transaction signing with public deterministic test keys,
durable deduplication, nonce/update concurrency, HTTP boundaries, uncertainty and permit refresh.
Test runtime adapters stand in for remote proof/chain completion; those tests do not establish live
proof acceptance. Real input inspection is separately recorded with `zkProof: false`.
