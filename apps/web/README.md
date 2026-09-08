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

The audit panel can save a completed sample receipt as JSON and check a saved receipt after a fresh start. Imports stay in the browser, are limited to 64 KB, and are validated against a strict simulation schema. Recalculation checks whether the canonical request matches its saved EIP-712 digest. This establishes internal consistency only: a modified request with a freshly calculated digest can also match, and no issuer, proof or chain authenticity is established.

## Boundaries

- `src/lib/domain/journey.ts` owns presentation transitions, exact gram-to-milligram conversion and invalidation when a request changes.
- `src/lib/adapters/sample-request.ts` creates synthetic requests using `packages/domain` and calculates their real EIP-712 digest. Identifiers and addresses are fixtures, not deployed resources.
- `src/lib/adapters/sample-receipt.ts` owns the export schema, bounded JSON validation and independent digest recalculation. UI components handle local files and downloads.
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

Sixteen tests cover flow gates, exact amounts, rejection and recovery, invalidation, duplicate completion, learning markers, receipt round-trips, request tampering, schema validation and size limits. The receipt tests bundle the same browser adapter into a temporary directory using Vite and clean it up afterward. The static adapter produces `build/`; it does not deploy the application.
