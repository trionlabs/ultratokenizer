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

| Operation             | Allocation                          | Pool accounting              |
| --------------------- | ----------------------------------- | ---------------------------- |
| `reserve`             | New exact request becomes `pending` | Full amount enters pending   |
| Exact `reserve` retry | Existing state is preserved         | Unchanged                    |
| `markIssued`          | Pending becomes `issued`            | Pending moves to outstanding |
| `releaseUnused`       | Pending becomes `released`          | Pending is released once     |

`setBackingCap({ issuerId, token, milligrams })` sets the local pool cap. A missing
pool has zero capacity. Aggregate pending plus outstanding exposure cannot exceed
the cap, and cap reductions cannot go below exposure. Accounting uses exact
`BigInt` arithmetic over persisted allocations, including totals above SQLite's
signed integer range. Pools aggregate the same issuer/token across requests for
different Gates or chains in this database.

Issued obligations never expire and have no release, burn or redemption method.
An expired request, expired permit, RPC outage, missing transaction hash, or
reservation that was never opened leaves the local allocation pending. A failed
or uncertain `openReservation` attempt can safely retry its identical local
allocation. A never-opened allocation remains locked until a separate verified
absence/cancellation process is designed; a timeout is insufficient.

Terminal observations must have explicit `kind: 'issued'` or `kind: 'unused'`, the
matching request, chain, Gate, reservation and claim identifiers, and a block
anchor. Issued observations also identify the issuance transaction. Unused
observations require `reason: 'revoked-unused' | 'expired-unused'`, a released,
zero-use reservation and unused request/claim flags. A reservation-opened receipt
is not an issuance observation. Identical terminal observations are idempotent;
conflicting terminal observations are rejected.

These observations are trusted caller evidence. The library checks their shape
and binding, but cannot verify their truth. Trusted orchestration must authenticate
the exact canonical transaction/event or definitive released-unused contract
state before calling a terminal method. It must preserve unresolved allocations
on uncertain outcomes and prevent issuance outside this authoritative ledger.

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

The database schema is version 2. Earlier schema files are rejected with
`unsupported_database`; there is no automatic migration, recreation or identity
reset. Existing institutional state must be preserved for a separately reviewed
migration and reconciliation process.

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
