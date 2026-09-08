# Issuance coordination worker

Authenticated request tracking and read-only Hedera reconciliation. The API worker validates request ownership. A SQLite-backed Durable Object owns each canonical request and uses durable alarms to inspect its transaction. It never signs, submits, retries or cancels a chain transaction, authorizes an issuer, or releases a reservation.

## Modules and ownership

| Module              | Responsibility                                                                                | Persistent data                                             |
| ------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `auth.ts`           | Verify short-lived access tokens against explicitly configured public keys                    | None                                                        |
| `index.ts`          | Enforce origin, rate limits, bounded JSON, holder signature and subject ownership             | None                                                        |
| `coordinator.ts`    | Persist request lifecycle, atomic event history, fenced observation leases and alarm recovery | One request per Durable Object; last 128 transition records |
| `chain-observer.ts` | Validate the configured chain, gate code, canonical block and matching issuance event         | None                                                        |
| `model.ts`          | Shared lifecycle and observation types; bounded retry policy                                  | None                                                        |

Private PDFs, witnesses, account statements, raw identity subjects, access tokens and holder signatures are not stored. The request contains deliberately public issuance fields; the subject is reduced to a namespaced digest for access control. That digest is an identifier, not an anonymity guarantee. Logs contain fixed error/status codes and attempt counts only.

## Install and validate

From the repository root:

```sh
npm ci --no-audit
npm --prefix workers/issuance ci --no-audit
npm --prefix workers/issuance run check
npm --prefix workers/issuance test
npm --prefix workers/issuance run build
```

The domain source resolves its dependencies from the root. Worker tooling and dependencies have a separate lockfile. Wrangler generates binding types from the explicit local configuration. `build` is a deployment dry run; it does not publish a worker. The matching local runtime supplied by Wrangler 4.130.0 is Miniflare 5.20260908.0-alpha, pinned in the lockfile. Runtime tests use its compatibility converter and real workerd/SQLite, with all outbound RPC handled by synthetic fixtures. A deployed Cloudflare acceptance test remains required before release.

The integration test concurrently creates the same request, checks cross-subject denial, injects a SQL failure after scheduling an alarm, restarts the runtime while observation is pending, and checks recovery and a matching event. Separate tests cover real JWT/EOA signatures, provider failures, block reorganization, code/event mismatch, redirects and bounded input.

## Required deployment configuration

The checked-in configuration has no operational trust keys or addresses and fails closed. `/healthz` reports process health only. It does not report production readiness.

| Setting                         | Required value                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | Exact identity-provider issuer and dedicated API audience                           |
| `AUTH_JWKS`                     | Reviewed public RSA/RS256 signing keys with key IDs; at most eight keys             |
| `ALLOWED_ORIGIN`                | Exact browser application origin                                                    |
| `CHAIN_ID`                      | Target chain ID; testnet is configured as `296`                                     |
| `GATE_ADDRESS`                  | Deployed issuance gate address                                                      |
| `GATE_CODE_HASH`                | Keccak-256 of that gate's reviewed runtime bytecode                                 |
| `RPC_URL`                       | Operator-controlled HTTPS JSON-RPC endpoint; put credential-bearing URLs in secrets |
| `MIN_CONFIRMATIONS`             | Required canonical block confirmations, between 1 and 32                            |

Tokens must be RS256 access tokens with `typ: at+jwt`, a configured `kid`, matching issuer/audience, and `sub`, `iat`, `exp`, and `wallet` claims. Maximum lifetime and age are five minutes with no expiry leeway. The trusted identity provider must establish the wallet claim. Request registration also requires that wallet's EIP-712 signature. API registration currently supports 65-byte EOA signatures; ERC-1271 wallets supported by the contract require a separately reviewed API authentication adapter.

Public keys are deployment configuration. Rotate them by deploying a reviewed set that includes the intended overlap, then removing revoked keys. Never accept a key, key URL or issuer URL from the token itself. The application supplies neither a login provider nor issuer-account provisioning. No identity is treated as an institutional signing key by this worker.

Use `.dev.vars` locally; it is ignored. Keep production and staging bindings, keys, RPC endpoints and hostnames separate. `workers_dev` and preview URLs are disabled. Bind an approved route only after deployment configuration and acceptance checks pass.

## HTTP interface

All `/v1/` operations require a bearer access token. Browser requests must use the exact allowed origin. JSON responses are not cached. Rate limits apply before JWT verification by edge IP and afterward by authenticated subject. Edge limits are abuse controls, not transactional quotas or issuer capacity.

| Method and path                          | Input                                          | Result                                                           |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `POST /v1/requests`                      | `{ request, holderSignature }`, at most 16 KiB | Idempotent canonical request registration                        |
| `GET /v1/requests/:digest`               | None                                           | Subject-owned tracking state                                     |
| `POST /v1/requests/:digest/transactions` | `{ transactionHash }`, at most 256 bytes       | Observe a wallet-submitted transaction                           |
| `POST /v1/requests/:digest/reconcile`    | None                                           | Restart observation after exhausted retries; one-minute cooldown |
| `POST /v1/requests/:digest/cancel`       | None                                           | Stop tracking before a transaction is attached                   |

`tracking_cancelled` does not revoke an already signed request. On-chain expiry, issuer revocation and reservation controls remain authoritative. An attached transaction cannot be cancelled through this interface. Attaching the same hash is idempotent. A different hash is accepted only after it independently confirms this exact request; until then the original reference and recovery process remain intact. Prior confirmed-reference corrections are preserved. No API operation broadcasts a transaction.

## Failure and recovery semantics

Each alarm persists a unique lease and a future recovery alarm before external I/O. Completion checks the lease and revision again, so a delayed observer cannot overwrite newer state. Alarm scheduling, state and transition history share a storage transaction. Requests survive eviction or process restart. Provider calls have deadlines, streamed responses are bounded, and HTTP redirects are rejected without following them.

Observation retries use exponential delay up to five minutes. After 24 attempts, `attention_required` preserves the transaction and uncertainty. Authenticated `reconcile` starts another observation cycle after a one-minute cooldown. No retry assumes that a missing receipt means a failed transaction, frees reserve capacity, or submits another mint.

`confirmed` means a successful transaction contains exactly one matching `Issued` event from the configured gate, whose runtime code hash and canonical block were checked through the configured RPC. Internal gate calls by relayers are supported. This result still depends on RPC honesty and the reviewed gate deployment. It is not independent proof verification, historical registry verification, complete token-supply reconciliation or physical reserve assurance. Use the portable audit module for separately reported cryptographic checks.

## Release and operations gates

Before deployment, configure the real identity provider and pin the independently verified gate deployment. Exercise malformed authentication, key rotation, rate limits, a provider outage, receipt delay, retry exhaustion and recovery against the deployed worker. Test actual Hedera receipts and native HTS behavior. Verify that platform storage restores and deployment rollback preserve request state and migrations. Never put raw payloads into platform invocation logs; this configuration disables them and emits only structured application events.

Alert on sustained `unavailable`, `attention_required`, authentication failure spikes and RPC disagreement. Assign an operator and response procedures for those conditions. Cloudflare log retention, alert destinations, recovery objectives, external RPC service guarantees and production routing are operational configuration, not established by the local suite. Keep this worker private/unconfigured until those release gates are met.

Storage and alarm behavior follow the official [SQLite storage interface](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Durable Objects lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). Authentication uses [JOSE verification](https://github.com/panva/jose).
