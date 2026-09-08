# Ultratokenizer web

An isolated SvelteKit product preview with holder, issuer and audit interactions. It runs separately from the root architecture explorer.

```sh
npm ci
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

Run these commands from the repository root. The web app imports the canonical domain source, whose dependencies are installed at the root.

Open the local URL printed by Vite. Three temporary interface directions share the same journey:

- `/?variant=A`: Orbit, with a document at the center of a spatial journey.
- `/?variant=B`: Workbench, with a transformation chamber beside its controls.
- `/?variant=C`: Passport, with a paper folio and a perforated progress stub.

The development-only bottom switcher cycles between designs and updates the URL. Arrow keys also work outside controls and dialogs. Reload preserves the design, while the sample journey resets. The switcher is omitted from production builds.

Choose **Try a sample**, adjust the gold amount, accept public disclosure, then switch to the test issuer. All three issuer seals must be selected before simulated approval. The remaining steps explicitly simulate proof and mint outcomes. The eye button opens request, privacy, audit and failure details. Motion follows the operating system's reduced-motion preference.

Orbit's **Discoveries** opens three optional learning challenges. Catch an edited sample, recover a rejected proof, and complete a sample before recalculating its request digest. Collected stamps survive journey resets but disappear on refresh. They never unlock issuance actions. Completion has a brief visual flourish that is removed with reduced motion.

The independent `/verify/` route is a read-only static workspace: it requires no app backend, account or wallet and never changes the sample journey. It supports the same v1 sample format, with request consistency and four unverified evidence levels shown separately. The hosting server must still supply the page and worker assets; no offline cache is installed.

The audit panel can save a completed sample receipt as JSON and check a saved receipt after a fresh start. Imports stay in the browser, are limited to 64 KB, and are validated against a strict simulation schema. Recalculation checks whether the canonical request matches its saved EIP-712 digest. This establishes internal consistency only: a modified request with a freshly calculated digest can also match, and no issuer, proof or chain authenticity is established.

## Boundaries

- `src/lib/application/preview-session.ts` owns session orchestration, role changes, errors, learning announcements and exact-journey guards for asynchronous receipt checks.
- `src/lib/components/PreviewWorkspace.svelte` wires presentation and focus to that module; `PreviewInspector.svelte` owns dialog navigation. Routes compose these modules without duplicating business logic.
- `src/lib/domain/journey.ts` owns presentation transitions, exact gram-to-milligram conversion and invalidation when a request changes.
- `src/lib/adapters/sample-request.ts` creates synthetic requests using `packages/domain` and calculates their real EIP-712 digest. Identifiers and addresses are fixtures, not deployed resources.
- `src/lib/adapters/sample-receipt.ts` owns the unchanged sample v1 export schema, bounded JSON validation and digest recalculation.
- `src/lib/verification` exposes the typed `ReceiptVerifier` interface. The browser adapter posts bounded UTF-8 text to a dedicated Worker, which performs parsing, schema validation and digest verification. A new request cancels the old one; correlation IDs, `AbortSignal`, an eight-second timeout and disposal reject stale work and terminate its worker. Each completed job also terminates its worker. Startup/execution failures are explicit; there is no main-thread verification fallback.
- `ReceiptExchange.svelte` shares file handling, cancellation, safe errors and evidence-level display between the Orbit inspector and independent verifier. Files are capped before reading; UTF-8 byte limits are rechecked before `postMessage` and in the worker. The DOM never renders raw parser errors.
- `src/lib/domain/discoveries.ts` records session learning progress separately from journey authority.
- `src/lib/components` contains receipt inspection, local receipt exchange, privacy disclosure and discovery challenges.
- `src/lib/prototype` holds temporary visual directions, the tactile document, shared controls and a development switcher. The root page selects a direction; the domain transition module remains the authority for presentation state. These designs are not a production interface commitment.

This is a simulation. It performs no PDF verification, identity check, custody reservation, permit signing, proof generation, wallet interaction or blockchain transaction. The Rust PDF modules are not connected to the browser. No personal PDF is accepted. Session state stays in memory and disappears on refresh; exported sample JSON remains wherever the user saves it.

Browser state and checkboxes are never mint authority. A production implementation needs authenticated issuer and custody services, a request-bound proof, a signed issuer permit and contract-enforced replay and reservation checks. UI guards only model the intended journey.

## Validation

```sh
npm --prefix apps/web test
npm --prefix apps/web run check
npm --prefix apps/web run build
```

Twenty-three tests cover flow gates, exact amounts, rejection and recovery, invalidation, duplicate completion, learning markers, receipt round-trips, request tampering, schema validation and size limits. The receipt tests bundle the same browser adapter into a temporary directory using Vite and clean it up afterward. The static adapter produces `build/`; it does not deploy the application.

## Static deployment security

`npm run build` produces `build/index.html` and `build/verify/index.html` with SvelteKit-generated hash CSPs. Hydration is allowed by its exact script hash; scripts and dedicated workers load from the same origin. Inline scripts and event handlers receive no blanket exception. Inline styles remain allowed because the tactile UI uses reactive CSS custom properties and Svelte-managed styling. The existing Google Fonts stylesheet/font origins are explicitly allowed; verification works without them.

Deploy the complete build, including `_app/immutable/workers/`. Serve JavaScript with its correct content type. `static/_headers` supplies framing restrictions, `nosniff`, no-referrer, a restrictive permissions policy, same-origin opener policy and HTTPS HSTS for hosts that understand this format. On other static servers, translate those entries into HTTP response headers. Do not assume copying `_headers` makes an arbitrary server enforce it. Its supplemental CSP adds `frame-ancestors`, which cannot be enforced from an HTML meta policy. Do not replace the generated per-page CSP with a script policy that drops the hydration hashes.

The sample schema establishes no issuer authentication or asset rights. Future signed receipt formats require a separately reviewed schema and verification implementation; unsupported formats fail closed.

## Worker browser checks

`test/worker-browser.mjs` uses `@playwright/test` pinned in this package's development dependencies. From a clean checkout, run these commands from the repository root:

```sh
npm ci
npm --prefix apps/web ci
cd apps/web
npx playwright install chromium
cd ../..
npm --prefix apps/web run build
npm --prefix apps/web run preview -- --port 4175 --strictPort
```

Keep that preview running. In another terminal at the repository root:

```sh
PREVIEW_URL=http://127.0.0.1:4175/ npm --prefix apps/web run test:browser
```

Start a **fresh** preview after each build. `PREVIEW_URL` selects the local static preview and defaults to `http://127.0.0.1:4173/`. The test uses Playwright's bundled Chromium by default. On Linux CI, `npx playwright install --with-deps chromium` also installs required system libraries. To opt into an already installed Chrome explicitly:

```sh
PLAYWRIGHT_CHANNEL=chrome PREVIEW_URL=http://127.0.0.1:4175/ npm --prefix apps/web run test:browser
```

This exercises an actual browser Worker, its emitted production asset, UTF-8 preflight limits, termination, CPU-bound timeout and cancellation, retry, unavailable-worker errors, static CSP/hydration, all evidence levels and a 320px layout. Network requests outside the static host and application API requests are blocked. The JSON fixture contains synthetic identifiers only.
