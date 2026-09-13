# Validation coverage

Run commands from the repository root. CI jobs are independent: a failed guest build must not
skip request parity or isolated requester tests. This inventory describes configured coverage;
it does not assert that a remote CI run passed.

| Packages                                                      | Local gate                                                                                                    | CI job                                 | Boundary                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Root application; domain, audit, issuance, institution        | `npm run check`                                                                                               | `validate`                             | Type/lint/build and local unit/integration checks                                                                   |
| Local document demo service                                   | `npm run check:demo-service` (included in `check`)                                                            | `validate`                             | HTTP, durable jobs, holder authorization and injected proof/chain transports; no paid requests or live mint         |
| Web                                                           | `npm run check:web`, `npm run build:web`; `test:browser`, `test:browser:backends`, `test:browser:institution` | `validate`, `browser-verification`     | Static application, holder, institution and trust browser flows with synthetic transports                           |
| Observation worker                                            | `npm run check:workers`, `npm run build:workers`                                                              | `validate`                             | Actual local workerd; dry-run build, no deployment                                                                  |
| Hedera provisioning (separate npm lock)                       | `npm run check:hedera-provisioning`, `npm run check:ats:hfs`                                                  | `validate`, `ats-acceptance`           | Offline SDK transport, exact constructor sizing, graph ordering and local EVM runtime preparation; no live HFS send |
| Main Foundry contracts                                        | `npm run check:contracts`                                                                                     | `contracts`                            | Local EVM, failure models and verifier rejection                                                                    |
| ATS (separate npm/compiler locks)                             | `npm run check:ats`                                                                                           | `ats-acceptance`                       | Pinned compilation and local Gate/ATS state transitions with a test verifier                                        |
| PDF/claim evidence, PDF/claim runners, network request schema | `npm run check:evidence`                                                                                      | `native-evidence`                      | Native tests and clippy; schema tests run explicitly, not only as a dependency                                      |
| Native Enpara extraction (separate Cargo lock)                | `npm run check:enpara`                                                                                        | `native-evidence`                      | Native extraction, not an admitted guest/source profile                                                             |
| Network requester (separate Cargo lock)                       | `npm run check:network-requester`                                                                             | `network-requester`                    | Locked formatting, tests and clippy; synthetic signer/transport/journals, no live commands                          |
| Claim guest                                                   | `python3 proofs/tools/build-claim-guest.py` and runner identity/self-test commands in CI                      | `native-evidence`                      | Candidate ELF execution and identity comparison; no automatic admission or paid proof                               |
| Canonical TS/Rust request and claim identity                  | `npm run check:parity`                                                                                        | `request-parity`                       | Builds the Rust runner before comparing; Solidity pins are checked by Foundry                                       |
| Legacy signature-only PDF guest                               | Workspace formatting; native PDF evidence/runner checks above                                                 | No dedicated guest build/execution job | Not admitted for issuance; its 96-byte output cannot replace the claim profile                                      |

The requester job installs compiler/dependency tooling but never runs `quote`, `stage`,
`submit-request`, `recover-request` or `retrieve-proof`. Tests inject local transports; they do not
read account credentials or operate on retained paid-request journals. No secrets are configured
for this job. Native dependency fetching is distinct from an operational proof/network test.

Live proof acceptance, Hedera provisioning, funded wallet flows, source authority and physical
fulfillment require separately recorded evidence. Passing these gates does not close those exits.

The document browser checks use synthetic API, proof and wallet responses against the production
UI. They cover the three-step journey, receipt recovery and first-screen controls at desktop
viewport sizes. They do not establish that a remote prover fulfilled a request. The local demo
service is an operator process with issuer capabilities; it is separate from the observation-only
edge worker and is never deployed by these checks.
