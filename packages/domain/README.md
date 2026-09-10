# Domain module

Validates issuance requests and distinct issuer permits, produces deterministic EIP-712 signing data, and owns the shared issuance event ABI. This module has no network calls, wallet storage, document processing, proof generation or mint authority.

## Run

Install dependencies from the repository root with `npm ci --no-audit`, then:

```sh
npm --prefix packages/domain test
npm --prefix packages/domain run demo
```

The package compiles to the ignored root `dist/domain/` directory and uses Node's test runner. It uses the repository's pinned TypeScript and viem installations. It is an internal source module, not a published package.

The demo validates a synthetic request and prints its digest. The addresses and identifiers in the fixture are demonstration values, not deployed contracts or authenticated asset records. To inspect another request after building:

```sh
node dist/domain/examples/inspect-request.js path/to/request.json
```

The output distinguishes request validation from evidence verification, issuer authority, replay state and chain submission. Only the request shape and expiry are checked.

## API

Import the public API from `src/index.ts` in TypeScript or the generated `dist/domain/src/index.js` in Node.

| Function                                    | Result                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `parseIssuanceRequest(input)`               | Validated, normalized and frozen request; throws `RequestValidationError` on invalid input |
| `serializeIssuanceRequest(input)`           | Stable JSON for storage and export; not a signing format                                   |
| `getIssuanceRequestTypedData(input)`        | EIP-712 domain, type definitions and message for a signer                                  |
| `getIssuanceRequestDigest(input)`           | 32-byte EIP-712 digest of the complete request                                             |
| `assertIssuanceRequestActive(input, now)`   | Validated request only when `now < validUntil`; `now` is a bigint in Unix seconds          |
| `parseIssuerPermit(input)`                  | Validated, normalized and frozen issuer permit                                             |
| `getIssuerPermitTypedData(request, permit)` | Distinct issuer signing data bound to the complete request and its issuer                  |
| `getIssuerPermitDigest(request, permit)`    | EIP-712 digest of the bound issuer permit                                                  |
| `getClaimUsageId(identity)`                 | Stable claim usage identifier derived from authenticated capsule identifiers               |
| `CLAIM_USAGE_TYPE`                          | Pinned domain-separator type string for the claim usage derivation                         |
| `ISSUED_EVENT_ABI`                          | Frozen gate event definition shared by the audit package and chain observer                |

Parsing and hashing intentionally allow expired requests so historical audit remains possible. Call the expiry check explicitly for current execution. Contracts must use the chain's timestamp and live state at issuance.

## Request format, version 1

Every field is required. All input values are strings. Extra fields are rejected so unsupported data cannot appear covered by a signature.

| Field                             | JSON representation                                 | EIP-712 binding                    |
| --------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `schemaVersion`                   | Literal `"1"`                                       | Domain version and message `uint8` |
| `action`                          | Literal `"ISSUE"`                                   | `string`                           |
| `requestId`                       | Nonzero bytes32 hex                                 | `bytes32`                          |
| `chainId`                         | Positive uint256 decimal string                     | Domain `chainId`                   |
| `gate`                            | Nonzero EVM address                                 | Domain `verifyingContract`         |
| `token`, `recipient`              | Nonzero EVM addresses                               | `address`                          |
| `amount`                          | Positive uint256 decimal string                     | `uint256`                          |
| `unit`                            | Literal `"XAU_MILLIGRAM"`                           | `string`                           |
| `issuerId`                        | Nonzero institution ID, distinct from a signing key | `bytes32`                          |
| `reservationId`                   | Nonzero bytes32 hex, fixed before proving           | `bytes32`                          |
| `claimCommitment`, `claimUsageId` | Nonzero bytes32 hex                                 | `bytes32`                          |
| `policyVersion`, `rightsVersion`  | Positive uint64 decimal strings                     | `uint64`                           |
| `nonce`                           | Uint256 decimal string; zero allowed                | `uint256`                          |
| `validUntil`                      | Positive uint64 Unix seconds, exclusive expiry      | `uint64`                           |

The domain name is `Ultratokenizer`; the primary type is `IssuanceRequest`. `request-digest.ts` defines the exact message field order. Addresses become checksummed and bytes32 values become lowercase. Invalid mixed-case address checksums are rejected. Quantities never pass through floating-point arithmetic; leading zeros, whitespace, fractions and scientific notation are rejected.

`amount` is gold quantity in milligrams. A token adapter must separately define the relation to token decimals/base units; the current module performs no conversion.

The synthetic fixture's version-one digest is:

```text
0xc591af7ea5cdef6005e1a9b31f14d7d30566e87615478d25a4861f43721b5deb
```

This is a pinned protocol regression fixture, not independent evidence of a deployed contract or an audited cryptographic implementation.

## Claim usage identifier

The claim usage identifier is the stable, privacy-preserving identity used to track consumption of one authenticated source claim across requests. The exact-amount V2 evidence profile requires the full signed quantity; smaller and larger requests both fail. It is distinct from a per-request nonce and from the claim commitment, which binds the claim's mutable content.

The derivation is canonical and identical in `packages/domain` (`claim-identity.ts`), the Rust evidence crate (`claim_identity.rs`) and the SP1 guest:

```text
usageType = "UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)"
claimUsageId = keccak256(abi.encode(keccak256(usageType), sourceId, claimId))
```

Every field is a 32-byte word; the type hash is the domain separator. The fields come from the authenticated source capsule and mean:

- `sourceId` — the authenticated source institution identifier, distinct from its signing key.
- `claimId` — the **claim subject key**: a stable, high-entropy, opaque per-claim identifier that stands in for the account/statement identifier and statement period in this synthetic profile.

Why this shape:

- **Authenticated source identity only.** Every input is a signed capsule field; no arbitrary user input enters the hash.
- **Survives source/document revisions.** A revision changes the holder, capacity and expiry, none of which are inputs. The source keeps `sourceId` and `claimId` constant across revisions of the same claim, so the identifier is stable.
- **Not reset by issuer, wallet, salt or policy.** Issuer, holder wallet, any fresh salt and the policy version are excluded by construction. Passing them to `getClaimUsageId` is rejected, so a user cannot re-randomize the nullifier to reuse a claim.
- **Entropy.** The output is a 256-bit Keccak digest. `claimId` is the primary entropy source and must be generated with high entropy; the other fields are opaque institutional identifiers. Uniqueness for single-use tracking requires `claimId` to be unique per claim within a source.
- **Privacy.** The identifier is a one-way hash, so it does not publish a raw document or account identifier as a nullifier. It is deterministic and therefore linkable, which is intentional for single-use tracking; an observer who can enumerate a low-entropy `claimId` namespace could match identifiers, so `claimId` must be unguessable.

`issuerId` is excluded in V2. Re-authorizing the same source right under another issuer preserves the same consumption identity. The source keeps its opaque right ID stable across redelivery, key rotation and corrections. This prevents issuer-based replay within one Gate; it does not share consumption state with another Gate or chain. A new deployment must preserve consumed rights and backing obligations before accepting old claims. Adding a chain or Gate to the hash would create fresh identities rather than provide that continuity.

`getClaimUsageId` validates identifier shape (nonzero 32-byte hex) but does not authenticate the source. The evidence/prover integration supplies authenticated capsule fields; the request still carries the derived `claimUsageId` and `claimCommitment` as separate bytes32 values.

## Trust boundary

An issuer permit contains `requestDigest`, `issuerId`, positive uint64 `keyVersion`, uint256 `nonce`, and positive uint64 `validUntil`, all represented as strings. Its primary type is `IssuerPermit`; its chain and gate domain come from the request. The digest helpers reject a different request digest or issuer, and a permit that expires after its request. They allow historical hashing and do not establish current key authorization. Holder signatures and issuer signatures serve different roles and cannot substitute for each other.

The digest binds the request contents. It does not establish that a source document is authentic, a signer is an authorized issuer, a reservation exists, a claim identifier was correctly derived, or mint capacity is available. Signatures still require signer and authority verification. Nonces still require persistent consumption checks.

The module accepts a supplied `claimUsageId` and derives one from authenticated capsule fields via `getClaimUsageId`; the two must agree before the request is proven, and uniqueness is enforced by the issuance gate. The holder must approve all bound fields, and both proof and permit must reference the same request. The issuance gate separately checks the active chain, gate, registry state, authority, expiry and atomic consume-and-mint behavior. See [the contract module](../../contracts/README.md) for its implementation and deployment limits.

Tests cover malformed inputs, integer and checksum boundaries, canonical ordering, request and permit binding, actual EOA signature tampering, expiry and historical hashing. Other modules test Solidity parity, shared event ABI and request hashing inside Rust. Domain tests alone do not establish smart-contract wallet, proof, registry or blockchain acceptance.

The implementation uses [EIP-712](https://eips.ethereum.org/EIPS/eip-712) through [viem's typed-data hashing](https://viem.sh/docs/utilities/hashTypedData). EIP-712 itself does not provide replay protection. This module's source, tests and documentation were created with Codex assistance and have not received an independent security audit.
