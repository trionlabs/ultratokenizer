# Ultratokenizer web

A static SvelteKit token workspace, local signed-document journey and independent receipt verifier. The visual flow follows real session state; there are no runtime sample journeys or simulated completion states.

Run from the repository root:

```sh
npm ci
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

## Issuance

The `/` route loads operator-provided deployment configuration from same-origin `/deployment.json`. Its document service authenticates an admitted signed PDF and prepares a request-bound public proof bundle; manual bundle import remains in the operator view. Deployment v1 means native HTS; v2 explicitly selects native HTS or the complete admitted ATS profile. Their strict schemas and actual wallet/RPC implementation belong to [packages/issuance](../../packages/issuance/src/index.ts). Deployment files are bounded to 64 KiB while reading and imports alone do not call the configured RPC. No deployment, recipient, quantity, proof or successful outcome is supplied by default.

The amount is fixed by the canonical request, public values and permit bindings. There is no issuance amount editor: a complete 1 g claim issues exactly 1 g, once. The selected wallet must authorize that bound recipient. Every step is explicit: connect, validate the proof/permit and deployment pins, sign typed data, simulate current execution, submit the actual transaction, and reconcile its receipt and exact Gate event. Preflight success is never presented as a submitted or confirmed transaction.

The product label is **zkPDF-backed token issuance**: the SP1 claim program verifies the sealed-PDF
profile, not DKIM or email provenance. This does not add browser PDF parsing or accept arbitrary
bank statements. The centered issuance view has three steps: upload document, verify and mint,
then review. Verification and minting have separate progress and wallet approvals within step two. The app loads network configuration automatically before evidence input.
Normal holder views have no deployment-file upload or network-configuration step. Operators can
open `/?operator=1` and select **Operator configuration** to import an independently reviewed
deployment into the current tab. This opt-in exposes local tools only and grants no chain authority.
The override has its own native dialog and file errors; an invalid import preserves the current
configuration and proof package. The fixed configuration URL cannot
be selected by a proof package or a query parameter. The request omits credentials, disallows
redirects, bypasses cache and has an eight-second deadline and a 64 KiB streamed limit. A missing
or invalid response leaves issuance unavailable; there is no sample fallback. Loading configuration
alone sends no wallet or configured-RPC request. Connecting then validates the deployment through
the shared client; only the package's matching recipient completes the wallet step. Configuration
stays in memory and is fetched again after a reload. Manual overrides are not persisted.

The monochrome iris scene adapts the earlier document-to-coin design to actual session state.
Authenticated document intake shows its exact quantity without claiming a ZK proof exists. A seal appears after a
successful proof check. The paper morphs into a coin only after receipt reconciliation; pending,
unresolved and reverted transactions keep the mint step open. Pointer tilt, restrained motion and
step transitions respect reduced-motion preferences. No animation advances the session.

The right rail reports the network, wallet, exact amount and current-session transaction outcomes.
All workspaces share `AppHeader`, including the same navigation labels, active-page state and
responsive layout. Holder and institution wallet controls use its action slot; Trust, Verify and
the guide remain wallet-free. Switching between Tokenize and Transfer on the holder page preserves
the tab's query string and session. Selecting any workspace starts its destination view at the top
of the page, including selecting the active view again and cross-route navigation. Back and Forward
between Tokenize and Transfer restore their previous scroll positions.
Deployment overrides are available only in the explicit operator view. Transfer remains a separate
view. Errors and recovery stay beside their action. The setup dialog supports Escape, local error
feedback and focus return.
Switching views does not create a transaction or change session state.

The current accepted source is profile 2's synthetic signed capsule, restricted by the shared client to test deployments. Real cryptography does not make this real bank evidence, asset backing, custody or a redemption promise. The normal UI uploads one of the admitted synthetic signed PDFs to the same-origin local document service. That operator process runs native checks and coordinates the existing [proof runner workflow](../../proofs/README.md); the browser does not generate the SP1 proof. Arbitrary bank PDFs and email evidence remain unsupported.

The full quantity, recipient and request data become public at onchain reservation/submission, even before successful issuance. Validation also sends the public proof to the explicitly configured RPC. The page accepts the admitted synthetic document and never asks for a private key. Uploading the PDF does not start paid work; the holder must authorize the exact request first.

`src/lib/application/issuance-session.ts` owns presentation orchestration. Missing configuration/provider and rejected checks leave subsequent actions unavailable. Wallet account/network changes invalidate unsubmitted checks and signatures. Once a hash exists, its captured request/signature/client survive wallet changes; unresolved transactions block replacement and can be reconciled again. The document journey retains its public job binding, signed request and any returned bundle/hash in session storage for read-only recovery. Restored data is untrusted and checked again. No PDF bytes or filename are stored there. Keep unresolved hashes and save confirmed receipts; clearing browser storage does not cancel a chain transaction or remote proof job.

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
Evidence validation, simulation and balance reads can be retried after their deadline because
they cannot open a wallet prompt or send a transaction. Their late results and errors are ignored,
including while a replacement check is running.
A pending send permits hash reconciliation through its captured client while blocking new wallet
actions, configuration replacement and the no-send acknowledgement. Expired token preparation
cannot resume into a wallet send. Late hashes retain their original request or nonce-bound token
intent; an already confirmed matching hash is not downgraded. A conflicting late hash requires
reconciliation again. A late original callback cannot clear a newer reconciliation's busy state.

Transaction rejection reports use `transaction_declined` and the same retained-attempt recovery
path as transport uncertainty. Signing-only decline does not create a transaction recovery state.
After the provider has settled, explicit wallet-activity review can acknowledge that nothing was
sent. This is an operator assertion, not a chain proof. Connection, network-switch, signing and
send calls that never settle continue to block new wallet actions; a local deadline cannot safely
cancel their wallet prompts or prevent a late transaction. Token preparation also retains the lock
until it settles, and an expired preparation cannot continue into sending. Session state is in memory,
so reloading or closing the page is not a safe cancellation mechanism and does not preserve these
locks. Retain the original request, token intent and any wallet hash outside the page before
restarting; durable cross-session orchestration is a separate integration requirement.

The currently integrated signing and receipt flow requires EOA signatures. Arbitrary native Ed25519 accounts and contract-wallet issuance are not promised by the UI.

## Operator configuration

Keep the independently admitted deployment export at
`work/runtime/hedera-testnet/deployment.json` (repository-relative, Git-ignored). Then run:

```sh
npm run prepare:web
npm run build:web
```

Preparation compiles and uses the shared deployment schema, rejects unknown fields, and admits
only chain 296 with the documented public `https://testnet.hashio.io/api` endpoint. A generic URL
filter cannot identify secrets in URL paths; another endpoint requires a reviewed code change to
this export lane. It atomically writes normalized configuration to `apps/web/static/deployment.json`.
Missing or invalid input fails without replacing an existing export. To withdraw configuration,
remove that generated static file and rebuild/redeploy; an already served build remains available
until it is replaced.
The command validates format, not live contract admission. Do not use illustrative test addresses.

The explicit testnet switch derives its wallet chain id from the loaded deployment rather than
repeating a literal, and when the wallet does not know the chain it asks to add it with that
deployment's own `rpcUrl` (falling back to the public endpoint only if it is not HTTPS). So the
chain the wallet ends up on reads from the same endpoint this app does.

**The static configuration is public**, served at `/deployment.json` and copied into the web build.
Git-ignore only excludes it from source control. Never put keys, access tokens, source documents,
private witnesses or journals in the static directory. Serve the file with `application/json` on the
same trusted origin as the application. A deployment's configuration and its evidence package must
come from independent trust paths. Protecting the application origin is part of that trust boundary.

No deployment export is committed. Prepare the site from the locally admitted deployment; a
holder-tab override does not configure the institution or trust pages. Historical proof/HFS journals
stay at their canonical paths and must not be moved for a retry. The local runtime README indexes
the required artifacts without copying credentials.

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

### Cloudflare Pages

`npm run deploy:web` prepares the public configuration, builds, and uploads
`apps/web/build` with `wrangler pages deploy`. Set `CF_PAGES_PROJECT` to the
project name; wrangler resolves its own credentials. Pages serves `_headers`
verbatim, so the deployed site carries the same framing, MIME, referrer,
permissions, opener and transport policy that `test:browser` asserts locally.

The build runs where the private deployment record lives. `prepare:web` reads
it from the Git-ignored `work/` tree and admits only the documented public
Hedera testnet endpoint, so a hosted build environment would need that record
copied into it; uploading the finished static output avoids that. Nothing in
the repository names the project or the domain.

The document journey on `/` calls same-origin `/api/*`, which is the local
preparation service in `packages/demo-service`. That service binds `127.0.0.1`
and holds the issuer credential, the institution ledger and the source
documents, so it is not part of a public deployment and must not be exposed.
On a hosted build those calls return 404 and the upload step reports that the
document service is unavailable; every other route is self-contained. `/demo/`
makes no chain call at all and is the entry point to link publicly.

## Institution and Trust workspaces

`/demo/` teaches the protocol in four steps — Prove, Authorise, Mint, Evidence — named after who
acts: you, the issuer, the chain, then anyone. A step rail on the left moves between them, and one
SVG stage beside it accumulates rather than resets: each step lights the next part of the same
picture and everything already lit stays lit, so the diagram a reader ends with is the one they
have been building all along. `?step=N` opens a step directly, and browser Back walks the steps
instead of leaving the site.

Above the steps, a standing disclosure states what is deployed and what has not happened, and a
thesis band names the three questions the system answers separately — is the document real
(zkPDF, inside SP1), who is the issuer (the ERC-8004 registry), may this mint happen (the Gate).
Under each step, two to three collapsed items carry the detail: one line, the reason it exists, an
illustration, and a link to the source a reader can open independently. They start closed so the
step reads in one screen.

The last step holds the evidence that must not cost four clicks to reach: the deployment addresses
with their HashScan links, and an honest mapping against the Hedera track requirements including
the two only partly met.

`test/demo-claims.test.mjs` pins the page's hard numbers to the files that define them — the
ordered guard count in `IssuanceGate.issue()`, the request field count in `packages/domain`, and
the capsule and public-value sizes in `proofs/claim-evidence` — so a change to any of those fails
rather than leaving the page asserting a stale figure.

It does not report completed transactions. Source document signing and private ledger operations
remain institution tooling outside the browser. The holder imports the institution's public
proof-and-permit package, and receipt verification needs no wallet.

The walkthrough makes no chain calls and fetches no third-party resource. It reads only the
same-origin `deployment.json` this host publishes, to render addresses and their outbound links;
without that file it still teaches the protocol and says the configuration is absent. Live chain
values belong to `/trust/`. Illustrations rest in their completed state rather than waiting on a
scroll observer, only the open step's panel is in the DOM, and every animation stops under
`prefers-reduced-motion`. Below 760 pixels the wide stage would set its labels at about three
pixels, so a text list carries the same progression instead. `test/demo-browser.mjs` asserts these
properties at 1440, 768, 390 and 320 pixels, checks that an opened item cites an `https://` source,
and checks that no source is ever fetched.

`/institution/` loads the same site-managed deployment as the holder. It offers two wallet roles:

- The configured issuer imports a strict Groth16 claim-proof export, reviews its exact allocation,
  opens and reconciles a reservation, then signs and downloads a permit package valid for at most
  ten minutes. The private stable-right ledger must already have reserved that allocation; the
  browser acknowledgement does not authenticate or update the Node/SQLite ledger.
- The Gate governor reviews the configured issuer and can admit its currently unregistered key
  version, set the issuer/token backing cap, and pause or open issuance. Each operation is simulated,
  bound to the wallet nonce, and reconciled against its exact transaction calldata and pinned Gate
  code. Unresolved submissions retain their intent and hash instead of sending automatically again.
  Source, program, policy and rights bootstrap remains deployment tooling. Review references are
  local page context, not an on-chain dossier, a signer counter-signature or regulatory approval.

Use separate issuer and governor wallet accounts. No private key is entered into the application.
If a permit expires while the request and existing reservation are still live, the issuer signs a
fresh permit for that same proof and reservation; the holder imports the replacement package.
An expired request needs a new request-bound proof under the stable-right accounting rules.
Keep original transaction hashes for recovery. Browser memory and review notes do not survive reload.

`/trust/` reads one canonical block through the configured RPC and shows the current issuer,
program, source, rights and backing records. It compares those records with application pins and
can export a clearly labelled observation and the app's audit policy. These exports do not
authenticate their own trust root, prove historical authority or establish physical backing.
The sealed synthetic PDF/capsule profile is zkPDF-backed; arbitrary bank statement extraction and
zkEmail are not implemented by this UI.

`npm run test:browser:institution` exercises both new production routes with intercepted synthetic
RPC: role denial, an exact cap transaction and reconciliation, no automatic sends, and 320px layout.
It does not establish live Hedera acceptance. `npm test` includes the authority client's canonical
state, nonce, runtime, amount and submission-failure checks.

The Trust page links Gate, token and verifier addresses to HashScan and Sourcify on chain 296.
A link alone is not a source-match result. Discovery cards expose NFT owners and service wallets;
an auditor owner or wallet matching the current governor or issuer signer is labelled shared
control. Different addresses alone do not establish an independent audit.

The optional `/discovery.json` sidecar is read only by `/trust/`. Its strict
`ultratokenizer.discovery.v1` schema binds `chainId`, `gate`, `issuerId`, an `identityRegistry`
object (`address`, `proxyCodeHash`, `implementation`, `implementationCodeHash`, `owner`), and one
to three unique `entries` (`role`, decimal-string `agentId`, NFT `owner`, service `wallet`,
`metadataHash`). Roles are `issuer`, `deployment` and `auditor`. The file is an operator-reviewed
index; ERC-8004 does not natively reverse-resolve this application's issuer ID.

The reader checks registry and implementation runtime hashes, the EIP-1967 implementation slot,
registry owner, NFT owners and service wallets at the same canonical block as the Gate. It accepts
only `data:application/json;base64,` registration URIs, at most 16 KiB after decoding, with
`metadataHash = keccak256(exact decoded UTF-8 bytes)`. Remote metadata, images and service endpoints
are never fetched or rendered. Metadata must include its actual registry tuple and the prepared
`ultratokenizer.discovery-dossier.v1` fields, including policy and rights versions. Issuer wallets
and deployment program declarations are compared with current Gate state. All matching is current
attribution through a configured RPC, not authenticated historical inclusion or a self-proving
trust root. A missing sidecar, changed owner, upgrade, transfer, metadata change or outage affects
only the discovery section. No registry read enters issuance or offline receipt verification.
