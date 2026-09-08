# Ultratokenizer

Private document evidence, controlled token issuance, and inspectable receipts. The project starts with gold statements and keeps document authenticity, issuer authority, and on-chain outcomes separate.

## Current implementation

| Module                                     | What works                                                                                                                 | Boundary                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/web`                                 | SvelteKit Orbit journey, issuer review, discovery challenges, portable sample receipts and local digest checks             | Proof and mint outcomes are simulated                               |
| `packages/domain`                          | Strict canonical issuance requests, EIP-712 hashing, exact quantities and expiry checks                                    | Request shape and hashing do not authenticate evidence or authority |
| `proofs/pdf-evidence`                      | Native RSA-2048/SHA-256 verification for one supported signed PDF revision, with signer pinning and strict coverage checks | No claim extraction, identity check or custody assurance            |
| `proofs/pdf-guest` and `proofs/pdf-runner` | The evidence check executes inside SP1 and is compared with native output                                                  | Execution only; no ZK proof generation or issuance-request binding  |
| Root application                           | Interactive React architecture explorer and standalone HTML preview                                                        | Proposed architecture, not a deployed issuance system               |

There is no connected custodian, signed institutional permit, wallet integration or deployed Hedera verifier. A matching sample receipt digest establishes internal consistency only; anyone can compute a new digest for changed data.

## Run the product preview

Requires Node.js 22.13 or newer. Run both installs from the repository root: the web app consumes domain source whose dependencies are installed at the root.

```sh
npm ci
npm --prefix apps/web ci
npm run dev:web
```

Open the local URL printed by Vite. Choose **Try a sample**, select an amount, accept public disclosure, review all three test issuer checks, and simulate proof and mint. The receipt can be saved as JSON and checked after a fresh start. The optional discovery challenges exercise rejection and recovery.

No personal PDF is accepted by the browser. Sample JSON imports stay local. Session state and learning stamps disappear on refresh; downloaded JSON remains wherever it is saved.

See [web documentation](apps/web/README.md), [domain documentation](packages/domain/README.md), and [PDF/SP1 documentation](proofs/README.md) for module commands and limits.

## Validate and build

```sh
npm run check
npm run build:web
```

The aggregate check runs repository hygiene, root formatting/lint/type checks, domain tests, and the web app's own formatting, Svelte diagnostics and tests. Each independently configured module uses its own compiler and formatter. Targeted commands are `check:blueprint`, `check:domain`, and `check:web`.

The web static adapter writes ignored output to `apps/web/build`. It does not deploy a site.

Native evidence checks use the Rust toolchain documented under `proofs/`; CI uses Rust 1.96.0:

```sh
cargo test --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-pdf-evidence
cargo clippy --manifest-path proofs/Cargo.toml --locked -p ultratokenizer-pdf-evidence --all-targets -- -D warnings
```

CI validates the blueprint, domain, web app and native evidence module. SP1 guest builds and execution checks require the separate SP1 toolchain and remain explicit local checks; routine CI does not generate proofs or contact a proving service.

## Architecture explorer

```sh
npm run dev
npm run build
```

The root React/TypeScript explorer uses Vinext and the Cloudflare Vite plugin. `build:html` creates the ignored `public/ultratokenizer-blueprint.html`; the production build regenerates it automatically. Run `npm run build:html` to enable its standalone download during development. After a production build, `npm start` serves the explorer in the local Workers runtime.

## Next implementation boundaries

1. Reviewed document revision selection and strict quantity/unit extraction.
2. A complete request-bound claim program and real proof verification.
3. Institutional permits, exclusive reservations, registries and contract-enforced issuance on Hedera testnet.
4. Independent receipt verification and reconciliation against actual issuance outcomes.

Cryptographic verification alone cannot establish physical gold custody or enforce redemption.

## Contribution rules

Use English for code, comments, UI text and committed documentation. Keep modules scoped to one responsibility and test authorization, state transitions and integration boundaries. Do not present simulation or guest execution as proof generation.

Keep local tooling, private planning and scratch files outside version control. Never commit credentials, private documents, proving witnesses, personal contact details or generated build output. Use a GitHub no-reply or project `.invalid` address for commit authorship.

`npm run check:hygiene` checks tracked paths, common private-data patterns, commit email addresses and Turkish characters. Review all text for English-only prose; automated checks cannot identify every language or sensitive value.
