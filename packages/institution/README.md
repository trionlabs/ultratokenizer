# Institution allocation ledger

A Node-only library for trusted institutional operators. It persists stable rights,
exact issuance allocations and conservative backing exposure in an actual SQLite
database. It does not sign documents or permits, submit transactions, authenticate
chain observations, or establish physical ownership or backing.

The current source prototype uses synthetic rights. A genuine proof over a
synthetic source does not turn those rights into real bank obligations.

## Identity and exact allocation

`openInstitutionLedger({ path })` requires an explicit absolute database path. There
is no default institution, key, database or in-memory mode. Import the source from
`src/index.ts` in institution-local Node code; browser and worker code must not
import this package.

`registerRight({ sourceId, recordReference, holder, milligrams })` creates or returns
one stable right. The institution supplies a private, stable reference to its
exclusive asset allocation, not a delivery identifier, PDF hash, email hash,
statement date or signing-key version. The same source/reference pair always
returns the same randomly generated 32-byte `claimId` and public `claimUsageId`.
Changed quantity or holder is rejected. A source identity must remain stable when
its signing key rotates.

Repeated statements about the same backing must resolve to the same institutional
right. Different source/reference pairs cannot be recognized as duplicate physical
collateral by this library; that mapping and exclusive backing remain institutional
responsibilities. The ledger cannot infer them from a balance snapshot.

`reserve({ rightId, request })` accepts the canonical domain request and requires
its full exact milligram quantity, holder and `claimUsageId`. Decimal strings are
mandatory; no rounding, partial issuance or fee deduction is supported. Individual
quantities are positive and bounded to signed 64-bit integers. Token conversion
and contract-specific limits still require chain validation.

One pending or issued allocation blocks every different request for that right,
including changes to issuer, policy, commitment, token, Gate or chain. An exact
retry returns the existing allocation without consuming additional cap. Retrying
an already released request returns its released record; it does not reopen it.

Distinct rights also reserve `(chainId, gate, requestId)` and
`(chainId, gate, recipient, nonce)` exclusively while pending or issued. These
locks cover competing local requests before either consumes the on-chain replay
flags; issuer or token changes do not bypass them. Only definitive unused release
frees those slots. `(chainId, gate, issuerId, reservationId)` remains permanently
bound to its original request, including after release, because the Gate does not
recycle reservation identifiers. Collisions return `request_conflict`.

## Lifecycle and cap

| Operation                | Allocation                                                    | Pool accounting                |
| ------------------------ | ------------------------------------------------------------- | ------------------------------ |
| `reserve`                | New exact request becomes `pending`                           | Full amount enters pending     |
| Exact `reserve` retry    | Existing state is preserved                                   | Unchanged                      |
| `markIssued`             | Pending becomes `issued`                                      | Pending moves to outstanding   |
| `releaseUnused`          | Pending becomes `released`                                    | Pending is released once       |
| `releaseExpiredUnopened` | Expired request with an absent reservation becomes `released` | Local pending is released once |

`setBackingCap({ issuerId, token, milligrams })` sets the local pool cap. A missing
pool has zero capacity. Aggregate pending plus outstanding exposure cannot exceed
the cap, and cap reductions cannot go below exposure. Accounting uses exact
`BigInt` arithmetic over persisted allocations, including totals above SQLite's
signed integer range. Pools aggregate the same issuer/token across requests for
different Gates or chains in this database.

Issued obligations never expire and have no release, burn or redemption method.
Local time, expired permits, RPC outages and missing transaction hashes cannot release
an allocation. A failed or uncertain `openReservation` attempt retains its identical
local allocation. An expired request with no reservation can close only through
`releaseExpiredUnopened` with the distinct authenticated observation described below.

Terminal observations must have explicit `kind: 'issued'`, `kind: 'unused'` or
`kind: 'expired-unopened'`, the
matching request, chain, Gate, reservation and claim identifiers, and a block
anchor. Issued observations also identify the issuance transaction. Unused
observations require `reason: 'revoked-unused' | 'expired-unused'`, a released,
zero-use reservation and unused request/claim flags. A reservation-opened receipt
is not an issuance observation. Identical terminal observations are idempotent;
conflicting terminal observations are rejected.

`kind: 'expired-unopened'` additionally requires a canonical `blockTimestamp` at or
after the request's `validUntil`, `reservationAbsent: true`, and unused request/claim
flags. It reports historical absence, not transaction cancellation or future absence.
The ledger preserves the original digest and permanent reservation-ID lock after release.
A fresh allocation needs a new request digest and reservation ID; an exact retry stays
released. Existing issued or released outcomes cannot change to this outcome.

These observations are trusted caller evidence. The library checks their shape
and binding, but cannot verify their truth. Trusted orchestration must authenticate
the exact canonical transaction/event or definitive released-unused contract
state before calling a terminal method. It must preserve unresolved allocations
on uncertain outcomes and prevent issuance outside this authoritative ledger.

## Trusted RPC accounting bridge

`createInstitutionChainBridge({ ledger, pins })` supplies a Node-only read path into the
existing ledger. Pins explicitly select test purpose, chain 296 (or local chain 31337), an
operator-trusted RPC URL, Gate address/runtime hash, admitted program VKey, immutable deployment
block number/hash, and a positive confirmation margin. There are no default addresses or keys.
The bridge neither opens reservations nor signs or sends transactions. It never accepts an
observer's arbitrary terminal-observation object as chain evidence.

`settleIssued(requestDigest, transactionHash)` reads the exact transaction and successful receipt,
strictly decodes/re-encodes the issuance call, binds its request/permit/public values and one exact
Gate event, checks the independently pinned VKey, and requires matching reservation consumption
and request/claim/request-ID/holder-nonce/permit-nonce flags. Receipt and transaction hashes, block
numbers/hashes, transaction indices, sender agreement, destination and value must agree. The
sender may be a relayer; the Gate authorization nonce is distinct from the EVM transaction nonce.
Later revocation or pause does not erase a valid earlier issuance.

`settleUnused(requestDigest)` reads the exact existing reservation at one numeric block selected
by the configured confirmation margin. It requires released state, zero use, unused request and
claim, and either actual revocation or an expired reservation. Time passing, an absent reservation,
a reverted transaction or a missing response cannot release the local allocation. Unrelated
requests consuming a holder nonce are not treated as consumption of this claim.

`settleExpiredUnopened(requestDigest)` checks that the confirmed numeric block's timestamp
has reached the signed request deadline, all nine reservation fields are at their zero
defaults, and the exact request and claim remain unused. It rechecks the block hash and
timestamp before releasing local pending exposure. The admitted immutable Gate rejects
the old request at and after that deadline; changing the deadline changes its signed digest.
The runtime pin must identify that reviewed Gate implementation, not arbitrary proxy code.

A delayed issuer call with a longer reservation expiry can still open a reservation for the
expired request. It cannot mint that request, but its chain pending capacity needs explicit
revocation or expiry. This local terminal path neither cancels the issuer call nor reports
chain capacity as released. It does not exclude independently authorized, untracked requests;
institutional issuance must remain under the authoritative ledger.

All paths check Gate runtime, chain and deployment anchor and recheck the target block after
dependent reads. A 120-second monotonic operation deadline is checked before any ledger mutation;
each RPC has a ten-second timeout, no retry and a 512-KiB response bound. There is no history-to-latest
fallback. Exact terminal retries return the original persisted observation rather than a new block
anchor; opposite outcomes or different issuance hashes conflict. All uncertain/mismatched reads
leave pending exposure unchanged, and provider errors are not copied into diagnostics.

This authenticates consistency under the explicitly trusted RPC service, not consensus inclusion.
A coherent malicious provider can fabricate code, state and receipts. Hedera's relay maps `safe`
and `finalized` to the latest mirror block; the bridge uses numeric blocks and calls confirmations
an observation margin, not extra consensus finality. See the
[reviewed official relay implementation](https://github.com/hiero-ledger/hiero-json-rpc-relay/blob/e187b2e6773f7ac53d974aabdabe0707eeedee3c/src/relay/lib/services/ethService/ethCommonService/CommonService.ts#L133).
Physical backing, independent proof verification, honest historical governance and cross-Gate
continuity remain separate obligations. Direct ledger terminal methods remain trusted operator
APIs; arbitrary Node code can bypass the bridge. Keep operational settlement behind this boundary.

## Private storage and operational limits

Public snapshots omit `recordReference` and `claimId`. `privateClaimIdentity(rightId)`
provides explicit private getters for source-document construction; default
inspection is redacted, enumeration omits its fields and JSON serialization
throws. Callers can still disclose a value they explicitly read and must keep
source documents and private identifiers outside public logs and exports.

The database contains those private values in plaintext. It is created as a
regular `0600` file inside an owner-only `0700` directory; unsafe existing paths,
symlinks, loose permissions and foreign databases are rejected. Database and
journal files are Git-ignored. This is filesystem access control, not encryption.
Use local storage with working SQLite file locking and protected backups. Copied,
stale-restored or separately recreated databases do not share allocation locks;
reconciliation before resumed issuance is an operator responsibility.

The database schema is version 3, introducing the distinct expired-unopened observation.
Version-2 databases require explicit `openInstitutionLedger({ path, upgradeFromVersion: 2 })`.
The upgrade first validates the complete version-2 table/index definitions, which are unchanged,
then updates only the version marker in the same initialization transaction. Rights, private
identities, allocations, terminal observations and exposure are preserved. Retrying this option
on version 3 is harmless. Older, foreign and drifted databases remain rejected without repair.

Stop every prior-version writer and preserve a private backup before the explicit upgrade.
Version-2 binaries reject version 3 when reopened, but already-open old processes do not check
the marker again. SQLite transaction locking does not fence out those processes. Never recreate
a database or reset identities to get around an unsupported version.

Opening a supported version also compares its complete stored table/index definitions with
the version's creation recipe, under the initialization transaction. Missing or altered fields,
constraints, indexes and unexpected schema objects are rejected with `unsupported_database`;
the ledger does not repair them or change existing rights. Normal SQLite ANALYZE statistics
are excluded from this comparison. Ad hoc DDL changes require a reviewed migration even when
they appear equivalent. This detects schema drift, not unauthorized row edits or a malicious
operator who controls the database and process. Operators must not change DDL while it is open.

Writes use `BEGIN IMMEDIATE`, unique constraints and rollback on failure. The API
is synchronous and intended for a small institution-local process, with a bounded
SQLite busy wait. Concurrent processes may share the same database; storage
contention can still fail an operation, which callers must reconcile or retry
without changing the canonical request. Pool reads scan active allocations; this
is not an unbounded-scale service.

The package uses the built-in [Node 22 SQLite API](https://nodejs.org/download/release/v22.17.0/docs/api/sqlite.html),
available without its earlier feature flag since Node 22.13 and still experimental
in Node 22.17. The verified local Node 22.17.0 runtime embeds SQLite 3.50.0, so this
module uses DELETE rollback journaling to avoid the affected
[WAL-reset race](https://www.sqlite.org/wal.html#the_wal_reset_bug).
[`synchronous=EXTRA`](https://www.sqlite.org/pragma.html#pragma_synchronous)
also synchronizes the rollback-journal directory on commit. These settings and
local restart tests do not constitute hardware power-loss certification.

## Verification

From the repository root:

```sh
npm --prefix packages/institution test
```

Tests use real temporary SQLite files and concurrent Node processes. They cover
stable identity after reopening, exact retry, competing reservations and cap,
request/nonce/reservation collision scopes, immutable issued exposure,
conservative release, wrong-phase observations, earlier-schema rejection and
private serialization/storage. They do not contact a chain or prove physical
backing, source authenticity, permit validity, or actual ZK proof acceptance.
