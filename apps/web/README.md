# Ultratokenizer web

A static SvelteKit token workspace and independent receipt verifier. The visual flow follows real session state; there are no runtime sample journeys or simulated completion states.

Run from the repository root:

```sh
npm ci
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

## Issuance

The `/` route imports an independent deployment configuration and a separate `ultratokenizer.issuance-bundle.v1` public bundle. Deployment v1 means native HTS; v2 explicitly selects native HTS or the complete admitted ATS profile. Their strict schemas and actual wallet/RPC implementation belong to [packages/issuance](../../packages/issuance/src/index.ts). Deployment files are bounded to64 KiB before reading and imports alone do not call the configured RPC. No deployment, recipient, quantity, proof or successful outcome is supplied by default.

The amount is fixed by the canonical request, public values and permit bindings. There is no issuance amount editor: a complete 1 g claim issues exactly 1 g, once. The selected wallet must authorize that bound recipient. Every step is explicit: connect, validate the proof/permit and deployment pins, sign typed data, simulate current execution, submit the actual transaction, and reconcile its receipt and exact Gate event. Preflight success is never presented as a submitted or confirmed transaction.

The centered issuance view shows one current action and six steps: evidence, wallet, verification,
approval, mint and receipt. Independent network setup lives in a separate native dialog; it is not
an evidence step. Configuration and proof packages remain separate files. The header wallet control
requires imported configuration; connecting then validates the deployment through the shared client.
Only the package's matching recipient completes the wallet step. Configuration remains in memory
and must be supplied again after a reload.

The monochrome iris scene adapts the earlier document-to-coin design to actual session state.
Loading a package shows its exact quantity without claiming verification. A seal appears after a
successful proof check. The paper morphs into a coin only after receipt reconciliation; pending,
unresolved and reverted transactions keep the mint step open. Pointer tilt, restrained motion and
step transitions respect reduced-motion preferences. No animation advances the session.

The right rail reports the network, wallet, exact amount and current-session transaction outcomes;
advanced configuration is collapsed. Transfer remains a separate view. Errors and recovery stay
beside their action. The setup dialog supports Escape, local error feedback and focus return.
Switching views does not create a transaction or change session state.

The current accepted source is profile 2's synthetic signed capsule, restricted by the shared client to test deployments. Real cryptography does not make this real bank evidence, asset backing, custody or a redemption promise. This UI imports public proof artifacts; it neither reads private PDF/email evidence nor generates proofs. Actual local proof generation is a separate [proof runner workflow](../../proofs/README.md).

The full quantity, recipient and request data become public at onchain reservation/submission, even before successful issuance. Validation also sends the public proof to the explicitly configured RPC. The page never asks for a private document or private key.

`src/lib/application/issuance-session.ts` owns presentation orchestration. Missing configuration/provider and rejected checks leave subsequent actions unavailable. Wallet account/network changes invalidate unsubmitted checks and signatures. Once a hash exists, its captured request/signature/client survive wallet changes; unresolved transactions block replacement and can be reconciled again. Session data is in memory: keep the page open for unresolved transactions, preserve the hash, and save confirmed receipts before leaving. A reload does not restore an unfinished session.

A transport error during a send can leave the broadcast outcome unknown even without a returned hash. The workspace blocks automatic retry. For issuance, a hash recovered from wallet activity can be checked against the captured request and exact Gate event. Starting again requires the user to inspect wallet activity and explicitly confirm that nothing was sent; this also clears preflight checks and the signature. Transfer and HTS association both retain the original client and frozen action, sender, token,
chain, nonce and exact transfer fields before sending. Recovered hashes are checked against that
intent before replacing a reference. Wrong or unavailable candidates preserve uncertainty; a
matching success or authenticated revert records its actual outcome. Account, provider and form
changes cannot rewrite the attempted action. Preparation failures do not claim a broadcast.
Malformed or zero recovery hashes show a specific input error without reading the chain or changing
the retained attempt. Importing a valid replacement bundle clears completed token status and balance;
pending or unknown actions still prevent replacement.

The token panel uses the imported backend configuration. Native HTS exposes association for the connected wallet; ATS omits that action and the session and client both reject it before sending anything. Balance and transfer use the shared ERC-20 methods. Transfer quantities can divide the issued amount into whole milligrams. ENS is optional only for transfers: an explicit Ethereum mainnet RPC resolves the intended Hedera coin type, displays the full resulting address and resolver-default fallback boundary, then freezes that address for the transfer. Changing the input clears the resolution. ENS never changes an imported issuance recipient or grants source/issuer authority.

The session applies a two-minute local deadline to non-reconciliation operations. A deadline
returns control for inspection; it does not cancel a provider promise or imply non-submission.
A pending send permits hash reconciliation through its captured client while blocking new wallet
actions, configuration replacement and the no-send acknowledgement. Expired token preparation
cannot resume into a wallet send. Late hashes retain their original request or nonce-bound token
intent; an already confirmed matching hash is not downgraded. A conflicting late hash requires
reconciliation again. A late original callback cannot clear a newer reconciliation's busy state.

Transaction rejection reports use `transaction_declined` and the same retained-attempt recovery
path as transport uncertainty. Signing-only decline does not create a transaction recovery state.
After the provider has settled, explicit wallet-activity review can acknowledge that nothing was
sent. This is an operator assertion, not a chain proof. A provider that never settles continues
to block new wallet actions; a local deadline cannot safely cancel it. Session state is in memory,
so reloading or closing the page is not a safe cancellation mechanism and does not preserve these
locks. Retain the original request, token intent and any wallet hash outside the page before
restarting; durable cross-session orchestration is a separate integration requirement.

The currently integrated signing and receipt flow requires EOA signatures. Arbitrary native Ed25519 accounts and contract-wallet issuance are not promised by the UI.

## Independent verification

`/verify/` accepts `ultratokenizer.issuance-receipt.v1` (256 KB maximum) plus a separately obtained `ultratokenizer.audit-policy.v1` (8 KB maximum). It rejects the former sample receipt format.

The `src/lib/verification` worker boundary calls [packages/audit](../../packages/audit/src/index.ts). By default, canonical request/public-value/permit bindings and EOA signatures are checked locally. Proof cryptography and historical chain evidence remain unverified. The result always distinguishes verified, failed and unverified checks; it cannot claim complete assurance.

Historical token implementation links, supply roles and transfer configuration are explicitly
unverified. A current ATS deployment check in the issuance client does not establish that historical
state, and a receipt cannot supply its own backend admission.

An explicit optional RPC setting uses the caller-pinned SP1 verifier after checking its chain and runtime code. This sends public proof bytes, public values and the program key to that provider. It is online verification and does not establish historical registry state, reservation/supply/replay effects or transaction inclusion. Receipt authors cannot select a verifier or RPC through the receipt itself.

Every verification job runs in a dedicated Web Worker. UTF-8 bounds are checked before posting and inside the worker. Correlation IDs, cancellation, a 45-second timeout and disposal terminate workers and reject stale results. Worker failures do not fall back to the UI thread. Imported files stay in memory; the user may save the resulting audit report. The static page and worker assets must be available from the host; no offline cache is installed.

The report first shows passed, failed and unverified counts with its overall limits. Individual
checks are expandable and open automatically when a check fails. Completed online observations
have a separate references panel; the saved report retains all checks and evidence regardless of
which panels are open.

Worker replies must have bounded report fields and a receipt identical to the normalized input.
The v2 report must contain all 18 known checks and a `proofVerification` field. Completed RPC proof
observations bind block/hash, verifier identity, proof input hashes and the requested provider origin;
incomplete or offline checks have no RPC observation. Receipt and policy formats remain v1.
Unsupported history/account checks remain unverified;
transaction inclusion cannot be verified, and offline mode cannot report verified proof cryptography.
Malformed or substituted replies fail the job and allow a fresh retry. This is structural transport
validation; it does not independently establish the truth of an otherwise well-formed audit report.

## Checks

```sh
npm --prefix apps/web test
npm --prefix apps/web run check
npm --prefix apps/web run build
```

Unit tests cover real-client orchestration boundaries, exact quantities, rejected checks, wallet races, transaction reconciliation, worker lifecycle and untrusted replies. Test-only fixtures have real ephemeral EOA signatures but deliberately invalid proof bytes; they establish no real ZK acceptance or deployment. The old sample fixture remains only to test rejection.

Production browser checks use this package's pinned Playwright dependency:

```sh
cd apps/web
npx playwright install chromium
cd ../..
npm --prefix apps/web run build
npm --prefix apps/web run preview -- --port 4175 --strictPort
```

With the preview running, use another terminal:

```sh
PREVIEW_URL=http://127.0.0.1:4175/ npm --prefix apps/web run test:browser
PREVIEW_URL=http://127.0.0.1:4175/ npm --prefix apps/web run test:browser:backends
```

Stop preview before rebuilding, then start it again. A preview process can retain the previous
manifest while the build replaces hashed assets, leaving the prerendered loading shell visible
because the new JavaScript requests return 404. Serve the complete build over HTTP; opening
`build/index.html` through `file://` cannot load its module assets.

The browser test exercises the actual shared client against an intentionally mismatched test RPC, proving failure remains closed. It also checks worker auditing of signed test fixtures, missing trust pins, changed amounts, sample rejection, size bounds, cancellation/retry, unavailable workers, production CSP/hydration and 320px layout. It performs no live issuance. Screenshots are written to the ignored root `.scratch/web-qa/` directory. `PLAYWRIGHT_CHANNEL=chrome` can select an explicitly installed Chrome instead of bundled Chromium.

The backend browser check imports synthetic v1/v2 HTS and v2 ATS configurations, rejects an
incomplete ATS import, checks association visibility, preserves the full claim and divisible
transfer inputs, and checks desktop/mobile layout. It intercepts external requests and permits
no wallet or RPC call and no third-party page-load requests. Its screenshots and assertions establish
UI behavior, not deployment admission or mint.

## Static hosting

The build produces `build/index.html`, `build/verify/index.html` and worker assets. SvelteKit generates hash-based script CSP; scripts/workers remain same-origin, with no blanket inline-script exception. Explicit user RPCs require HTTPS connections or HTTP at `localhost` or `127.0.0.1` in `connect-src`. Browser deployment imports, ENS resolution and verification reject HTTP IPv6 loopback before transport because Chromium cannot apply an IPv6-literal CSP host source. The shared Node/CLI client retains IPv6 support. Application code initiates RPC only through the described user actions. Fonts use locally available families and system fallbacks; loading the app does not contact a font provider.

Serve the complete build and correct JavaScript content types. `static/_headers` supplies framing, MIME, referrer, permissions, opener and HTTPS policies for supporting hosts; translate them to server response headers elsewhere. Its supplemental `frame-ancestors` policy requires an HTTP header. It intentionally omits `connect-src`: a second, narrower directive would intersect the generated page policy and block explicit RPC and ENS providers. Do not replace the generated CSP with a policy that drops hydration hashes. Building does not deploy the app or register any chain authority.

Response headers are the primary framing defense. As a fallback, prerendered HTML exposes only a
neutral loading shell and same-origin direct link; file and wallet controls render after JavaScript confirms a top-level tab.
An embedded page keeps the notice even when a host omits response headers; its direct link is pinned
to the current origin, including double-slash path aliases. This fallback does not
replace HTTP frame protections. JavaScript is required to use the workspace.

`test:browser` also serves the actual static build with its `_headers` policy and checks it together
with the generated meta CSP. It verifies no automatic third-party requests, explicit HTTPS RPC and
ENS transport at HTTPS/localhost/IPv4 loopback, early HTTP IPv6 rejection, header-enforced frame denial
and headerless inactive frames with JavaScript enabled and disabled. Those RPC responses are
intercepted synthetic fixtures, with no live chain calls.

The token recovery browser cases use the production client with a synthetic wallet and intercepted
RPC: lose the returned hash, change account/chain/form fields, reject an old-nonce transaction, then
confirm the original transfer or HTS association with one send. This complements the no-wallet
backend import checks above. It does not establish live RPC behavior or durable recovery across a
page reload.
