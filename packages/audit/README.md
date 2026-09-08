# Portable issuance audit

A standalone, read-only library and command for exported issuance bundles. It uses the canonical request and issuer-permit definitions in `packages/domain` and the seven-word claim / `Issued` event layout in `contracts/src/IssuanceGate.sol`. It never calls the application API or a chain endpoint.

This format is **`ultratokenizer.issuance-receipt.v1`**, distinct from the browser preview's **`ultratokenizer.sample-receipt.v1`**. The existing browser verifier continues to support sample receipts only. No real proof, deployment or issuance is implied by creating a bundle.

## Build and run

Use the repository's installed Node, TypeScript, esbuild and viem dependencies:

```sh
npm --prefix packages/audit test
node packages/audit/dist/cli.js --receipt receipt.json --policy trusted-policy.json
node packages/audit/dist/cli.js --receipt receipt.json --policy trusted-policy.json --strict
```

Build output stays in this package's ignored `dist/`. The bundled command/library requires the repository's installed `viem` dependency, but no application server. No files or chain state are mutated.

Exit codes:

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | No failed offline checks; report still says `incomplete` and `complete: false`. |
| `1`  | Invalid input, failed bindings, or invalid signatures.                          |
| `2`  | `--strict` requested and evidence remains incomplete.                           |
| `64` | Invalid command arguments.                                                      |

Default exit `0` is **not an issuance attestation**. Automated consumers must inspect `status`, `complete`, each check and `missingEvidence`, or use `--strict`.

## Receipt schema

The exact root fields are:

| Field             | Content                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `format`          | `ultratokenizer.issuance-receipt.v1`                                                                       |
| `request`         | Canonical issuance request from `packages/domain`.                                                         |
| `requestDigest`   | Its claimed EIP-712 digest, nonzero bytes32.                                                               |
| `holderSignature` | Canonical 65-byte EOA signature over the request digest.                                                   |
| `permit`          | Canonical issuer permit from `packages/domain`.                                                            |
| `issuerSignature` | Canonical 65-byte EOA signature over the distinct permit digest.                                           |
| `publicValues`    | Exactly 224 bytes of ABI-encoded claim output.                                                             |
| `proofBytes`      | Nonempty hexadecimal proof bytes, at most 64 KiB. Presence is not validity.                                |
| `programVKey`     | Claimed nonzero program verification key, compared with caller policy.                                     |
| `transaction`     | `null` or exactly `{ "chainId": "…", "hash": "0x…" }`. This is a lookup reference, not inclusion evidence. |

Receipt JSON is capped at 256 KiB of UTF-8. Unknown fields are rejected at every modeled level. No document, witness, full private balance, embedded verification key, trust policy, registry assertion or signer selector is accepted. The parser normalizes supported public fields; it does not infer issuer trust from them. Error messages do not echo source values, unknown field names, paths, parser internals or signatures.

EOA signatures require low `s` and `v` equal to 27 or 28, matching `SignatureCheck.sol`. This version does not support ERC-1271 contract-wallet signature verification. Historical account code is explicitly unverified, even when EOA recovery matches an address.

The claim words are `uint32 profileVersion`, `bytes32 requestDigest`, `bytes32 signerFingerprint`, `bytes32 sourceId`, `bytes32 claimUsageId`, `bytes32 claimCommitment`, and `uint64 claimValidUntil`. Integer padding and ranges are checked; trailing bytes are rejected. Matching claim bytes do not prove that an SP1 program executed.

## Separate caller trust policy

Supply policy from a channel the verifier already trusts. Do not read policy from the receipt, follow a receipt-provided policy URL, or automatically accept registry assertions carried in a bundle.

An exact `ultratokenizer.audit-policy.v1` policy contains:

- `format`, `chainId`, `gate`, `token`.
- `issuerId`, `issuerAddress`, `issuerKeyVersion`.
- `policyVersion`, `rightsVersion`.
- `programVKey`, `profileVersion`, `sourceId`, `sourceSignerFingerprint`.
- `proofSystem` (`sp1-groth16`), exact `outerVersion` such as `v6.1.0`, `verifierAddress`, and `verifierCodeHash`.

Identifiers are nonzero fixed-size hexadecimal values; integers are canonical positive decimal strings. Policy JSON is capped at 8 KiB. No deployed keys or trusted program defaults are shipped. A measured program key is not automatically an audited or trusted program.

## Library interface

```ts
import {
  parseAuditPolicy,
  auditIssuanceReceipt,
  getExpectedIssuedEvent,
} from './packages/audit/dist/index.js';

const policy = parseAuditPolicy(trustedPolicyJson);
const report = await auditIssuanceReceipt(receiptJson, policy);
const expectedLog = getExpectedIssuedEvent(receiptJson);
```

`auditIssuanceReceipt` genuinely checks canonical request/permit digests, holder and pinned-issuer EOA recoveries, caller pins, claim bindings, gate amount range, and `permit expiry ≤ request expiry ≤ claim expiry`. It does not use the machine clock as if it were an independently established historical block timestamp.

`getExpectedIssuedEvent` returns `{ address, topics, data }` derived from the bundle. It is neither a substitute for auditing the bundle nor proof that an event occurred. A separate chain observer must use its own trusted network configuration, independently obtain the successful transaction and matching log from the pinned gate, and assess finality. An ABI alignment test compares the exported event definition directly with the Solidity source.

### Explicit proof adapter

The library supplies **no default proof-verification adapter**. A caller may pass `{ proofVerifier }`, implementing `ProofVerificationAdapter`:

- `identity`: proof system, exact outer version, verifier address and code hash. All must match the separate caller policy.
- `verify({ proofBytes, publicValues, programVKey, policy }): Promise<boolean>`: actual cryptographic verification against that pinned configuration.

The adapter is trusted executable code installed/configured by the caller; its identity declaration is not independently authenticated by this library. A `true` result marks only `proof_cryptography` verified. `false` fails that check; an exception leaves it unverified with a safe error. An identity mismatch fails closed without invoking the adapter. Prior binding failures also prevent invocation. Callers running expensive adapters must supply their own execution isolation, timeout and cancellation; no adapter is loaded by the CLI.

## Evidence that remains missing

Offline output remains `complete: false`, including after an explicit proof adapter succeeds. Transaction inclusion/success/finality, historical issuer/source/program/policy/rights state, reservation capacity and consumption, mint/supply effects, replay/nonce accounting, execution time, current revocation and account-code / ERC-1271 state are unverified.

Cryptographic and chain checks cannot themselves establish physical custody, document-subject identity, exclusive real-world reserves, or enforceable redemption. Those trust questions remain explicit limitations.

The tests generate disposable local EOA keys and use synthetic public requests. They do not produce or claim a valid SP1 proof or a live transaction.
