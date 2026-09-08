# Ultratokenizer

A ZK Self-Sovereign Tokenizer, starting with an interactive architecture blueprint for private document evidence and controlled, independently auditable issuance.

## Current scope

This repository implements the blueprint interface only. It does not upload private documents, generate proofs, connect wallets, call a custodian or submit blockchain transactions. Scenario outcomes illustrate the proposed rules.

The initial implementation will support one document schema, one institutional integration and one rights model. Production modules will be built in explicit stages after their acceptance criteria are agreed.

## Repository structure

- `app/`: application route, metadata and styles.
- `components/blueprint/`: module contracts, flow explorer and design scenarios.
- `components/ui/`: shared interface primitives.
- `preview/`: entry point for the standalone preview.
- `scripts/`: reproducible preview generation.

## Development

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run dev
npm run check
npm run build
```

`build:html` creates `public/ultratokenizer-blueprint.html`. This generated file is ignored by Git. The production build regenerates it before building the application.

Run `npm run build:html` to enable the standalone download during development. After a production build, `npm start` serves the application in the local Workers runtime. Set `WATCH_POLLING=true` if filesystem events are unavailable.

The application uses React, TypeScript and Vinext with the Cloudflare Vite plugin. Its runtime configuration is in `vite.config.ts`; no hosted project or account credentials are required for local development.

Pull requests and pushes to `main` run repository hygiene, formatting, lint, type checks and a production build in CI.

## Build sequence

1. Evidence schema, canonical request and real proof verification on Hedera testnet.
2. Institution permits, versioned registries, atomic issuance and the ATS lifecycle.
3. Independent proof packages, complete supply reconciliation and external verification.

Define the audit package contract in the first stage. A later auditor must not depend on private documents or the application API.

## Contribution rules

Use English for code, comments, UI text and committed documentation. Keep modules scoped to one responsibility. Add tests for authorization, state transitions and integration behavior as those modules are implemented. Do not present a prototype as a deployed proof system.

Keep local tooling, private planning and scratch files outside version control. Never commit credentials, private documents, proving witnesses, personal contact details or generated build output. Use a verified GitHub no-reply address for commit authorship.

`npm run check:hygiene` checks tracked paths, common private-data patterns, commit email addresses and Turkish characters. Review all text for English-only prose; automated character checks cannot identify every language or sensitive value.
