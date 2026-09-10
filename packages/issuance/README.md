# Issuance client

This package connects an explicit EIP-1193 wallet to separately supplied deployment pins. It has no default accounts, deployment addresses, verification keys or successful proof states. The supported application source profile is currently **synthetic profile 2 on a test deployment**, with the SP1 v6.1.0 outer verifier. A real proof of that guest does not establish real institutional backing.

Load an `ultratokenizer.deployment.v1` configuration separately from any document or imported claim. It contains `purpose: "test"`, an RPC URL, Gate runtime code hash, confirmation count, and the complete independent audit policy: chain/Gate/token, issuer and versions, guest vkey, source/profile and direct verifier identity. `parseDeploymentConfig` validates it; `createIssuanceClient({ provider, deployment })` uses it. No bundled example is a trusted deployment or a default program key.

Version1 always means the original native HTS backend. `ultratokenizer.deployment.v2` adds an
explicit `backend`: either exactly `{ "kind": "hts" }`, or the complete admitted ATS configuration
described below. Unknown backends, missing fields and attempts to inject a backend into version1
are rejected. Parsed configurations remain reparseable and frozen. The complete import is bounded
to64 KiB; no backend is inferred from an asset name, bundle or missing contract method.

An `ultratokenizer.issuance-bundle.v1` contains only `request`, `permit`, `issuerSignature`, `publicValues`, `proofBytes` and `programVKey`, plus its format. `parseIssuanceBundle` checks structural and request binding; parsing alone does not verify cryptography. The request fixes the whole authenticated quantity, for example 1 g → exactly 1,000 mg. It is not an editable partial-mint amount. The exact on-chain reservation must exist before signing in this client; its recipient, token, full amount, request digest and claim usage ID are public even if issuance never succeeds. Documents and private witness material are not bundle fields.

The supported portable signing/receipt path uses canonical 65-byte EOA signatures. The Gate's separate ERC-1271 support does not imply complete smart-wallet or counterfactual-account support in this browser/offline-audit workflow.

`validate` checks the imported request/permit/evidence bindings and compares live program, source, issuer, rights, adapter and exact reservation records at one selected block. It checks pending/outstanding exposure and asks the pinned verifier to verify the proof at that same block, then confirms that the block remains canonical according to the RPC. This is a preflight snapshot: state can change before execution. `simulate` executes the complete Gate call without submitting it.

`sign` rechecks the selected wallet after the signing prompt. `submit`, `associate` and `transfer` recheck account and chain immediately before sending. Explicit user rejection is retained as rejection; other send failures are unresolved because a disconnected wallet may have submitted before returning a hash. Preserve any known hash and reconcile before offering another submission. A client cannot make wallet state checks and network submission one atomic operation.

During `submit()`, an issuance simulation or final preflight outage returns `issuance_preflight_unavailable` before calling the wallet's transaction method. It must not be presented as a possible broadcast. Errors after entering the actual send boundary remain uncertain unless the wallet explicitly rejected the operation.

Issuance reconciliation binds the exact logical request and holder signature, not an original wallet sender/nonce intent. A confirmed success for that request establishes its issuance. A newly supplied reverted transaction cannot establish that another unknown or retained submission failed, even when its calldata matches. The web session preserves that ambiguity with `issuance_recovery_unresolved`; only the already retained original hash can resolve that attempt as reverted. Invalid recovery candidates never replace the original reference.

Use `connect()` to request the wallet account, `validate(bundle)` for preflight, `sign(bundle)` for holder approval, `simulate(bundle, signature)` before `submit(bundle, signature)`, and `wait(bundle, signature, hash)` for reconciliation. `associate()`, `balance()` and `transfer(recipient, milligrams)` operate on the configured token; post-issuance transfers remain divisible into positive integer milligrams. `resolveEnsRecipient` resolves an optional name to an address before that address is confirmed as transfer intent.

`getTokenBackend(deployment)` distinguishes the explicitly selected backend. Ordinary balance,
decimal and transfer calls use the shared ERC-20 ABI. `associate()` is exclusive to native HTS and
rejects ATS before making a wallet or RPC call; it never returns a fabricated success or hash.

`wait` does not require the original account to remain selected or its permit to remain live. It refreshes the receipt, checks the supplied transaction hash, canonical block and confirmation depth, compares historical Gate code, verifies the exact direct `issue` calldata and matches one complete `Issued` log. It exports the existing audit receipt format. Replacement/repricing/cancellation receipts are not silently substituted: reconcile the actual wallet transaction hash explicitly. A changed or unavailable chain view remains unresolved.

For token actions, capture `prepareTokenTransaction(operation, expectedAccount)` before sending,
preserve its frozen intent and original client, call `sendTokenTransaction(intent)`, then
`waitTokenTransaction(hash, intent)`. The intent fixes action, chain, token, sender, pending nonce
and transfer recipient/quantity. Preflight rechecks wallet and nonce after simulation and sends
that explicit nonce; preflight outages do not report an unknown wallet broadcast. Confirmation
checks the exact transaction and, for transfers, one matching `Transfer` event at a canonical
block. An old otherwise identical transaction cannot confirm a new nonce. HTS association also
requires a historical `isAssociated()` read with the original sender as caller; ATS rejects the
operation. Current wallet selection and expired mint permissions do not prevent reconciliation.

The legacy hash-only `waitTokenTransaction(hash)` checks generic successful token inclusion only.
It is retained for compatibility and must not certify the intended action in a product UI. The web
session always supplies its original intent, and accepts a recovered hash only after those checks.
A matching reverted transaction is a definitive failed broadcast, not a claim that nothing was sent.
Missing historical RPC capability leaves confirmation unresolved. [HIP-719](https://raw.githubusercontent.com/hashgraph/hedera-improvement-proposal/main/HIP/hip-719.md)
defines the caller-relative HTS association interface; native historical-call behavior still needs
live Hedera acceptance.

All chain observations depend on the configured RPC; this package is not a consensus light client. The optional RPC audit verifier distinguishes explicit execution reverts from transport/internal server failures, and offline audit remains incomplete even if that adapter accepts cryptography. No historical custody, redemption or exclusive backing guarantee is inferred.

## ATS deployment admission

`src/ats.ts` implements a strict, versioned profile for the selected ATS8.0.0 gold-right configuration.
It records the fixed upstream commit and compiler selector/link layout, without default addresses
or accepted runtime hashes. The independent deployment supplies token runtime identity, adapter,
direct resolver and inert initializer identities; exactly ten named facets and four named libraries;
explicit configuration ID/version1; ATS max supply; and a separately reviewed atomic-creation record.
All address sets, fields, integer bounds and nested records are validated and frozen.

The creation record binds a transaction hash, complete input hash, block number/hash and external
review commitment. Its hash is an independently accepted assertion, not a certificate that validates
itself. The supported history is direct creation of the inert initializer, with token, adapter,
resolver and initializer absent before that block. A factory/migration history needs its own profile.

Before wallet operations and proof preflight, the shared chain module checks ATS at one canonical
block, including actual runtime library links, proxy storage/configuration, selected selectors,
initialization status, relevant roles, owner, supply/decimals and transfer-policy state. The Gate's
rights entry must select the same token and adapter/hash. Changing code/configuration fails;
unavailable RPC or a changed block view remains unresolved. These current checks do not authenticate
historical mint configuration, physical reserves or all entries in an arbitrary storage mapping.

Revoking a Gate issuance-rights version prevents new issuance and permit preparation. It does not
freeze already-issued token balances or ordinary transfers. Those operations still check the
admitted token and immutable Gate/adapter relationship, then follow the token's own transfer rules.

The caller must independently admit the exact constructor/artifacts and initial state. Arbitrary
caller-supplied hashes cannot prove that an inert-looking owner or selected source is trustworthy.
The narrow asset intentionally has no maintenance, recovery or redemption path. Live Hedera
deployment, a valid application Groth16 proof and persistent institution orchestration remain
separate acceptance work; accepting a JSON configuration does not demonstrate any of them.

## Institution wallet

`createIssuerClient({ provider, deployment })` uses the same independent pins and chain checks for
the institution's actual EOA wallet. Its trusted caller must first reserve the canonical request
against the stable right in the Node-only `packages/institution` durable ledger. This wallet client
cannot discover whether two differently named institutional records represent the same backing.

`openReservation(proofExport)` accepts only the runner's bounded public Groth16 export shape,
rechecks the proof through the pinned verifier and checks current registry, capacity and consumption
before simulating and sending the exact reservation. An export's `verified_groth16_export` label is
input, not trusted evidence. Existing reservations are never silently overwritten or resubmitted.
Keep the returned hash for `waitReservation(proofExport, hash)`, which checks historical code,
canonical inclusion, exact calldata, institution sender and one matching `ReservationOpened` event.
Its `kind: "reservation-opened"` observation is not a successful mint observation.

`signPermit(proofExport, reservationHash, { nonce, validForSeconds })` requires that reservation
evidence plus a fresh active/unused reservation. The caller supplies a persistent nonce and a
lifetime of 1-600 seconds; expiry is capped by the request and issuer-key lifetime. The wallet signs
the actual EIP-712 permit. Signer recovery and fresh account, key, reservation, nonce and expiry
checks precede returning the public issuance bundle. A wallet may already have created a signature
when a later check fails; the Gate remains the execution authority.

The durable ledger is not imported into browser exports. Wallet rejection, RPC uncertainty, process
exit and elapsed time do not release its pending allocation. No orchestration should call
`markIssued` on a reservation observation or release backing merely because a send returned no hash.
The trusted durable bridge and native-chain lifecycle exercise remain separate integration work.

Run `npm --prefix packages/issuance test` after the root dependency install. Tests use explicitly local JSON-RPC/wallet models and real EOA signatures to exercise failures and binding. They do not demonstrate a valid application Groth16 proof, real token creation or a live Hedera transaction.

## Actual ATS acceptance

The normal-source build is documented in [contracts/ats](../../contracts/ats/README.md). After its
locked dependency install and explicit compiler fetch, run `npm run check:ats` from the root. That
lane rebuilds current source artifacts and requires actual local ATS/Gate execution; absent or
changed inputs and a skipped/missing local test fail. Default unit tests retain an explicit local
EVM skip. The CI workflow has a separate unconditional ATS job; no remote CI result is claimed.
A separate test verifier isolates state integration. This does not prove SP1 acceptance or live
Hedera compatibility.
