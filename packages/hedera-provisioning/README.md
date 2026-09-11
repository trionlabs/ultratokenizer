# Hedera HFS creation transport

This Node-only package preserves an independently approved, signed Ethereum creation while moving its large input through Hedera File Service. It uses the official Hiero SDK 2.88.0 and viem 2.56.3, pinned by the package lock. It accepts Hedera testnet (chain 296) only. No default payer, keys, deployed addresses or automatic registration are provided.

The lock also pins `@hiero-ledger/proto` to protobufjs 8.8.0 and all `ws` consumers to 8.21.3 through explicit overrides. The SDK's original dependency tree included versions covered by published advisories. These maintained patches retain the SDK version; the signing, serialization, recovery and actual ATS input tests pass with them. The 2026-09-11 npm audit reported zero known advisories for the resulting 120-package tree. This is a dated dependency check, not a security guarantee.

The current ATS constructor input is 31,759 bytes. Hedera documents a 24 KB inline limit for creation, so this input needs HFS. HFS holds **ASCII hex**, not the raw bytecode. The network decodes the file and restores the data covered by the original Ethereum signature. The builder tests the same restoration byte for byte.

## Install and check

```sh
npm --prefix packages/hedera-provisioning ci --ignore-scripts --no-audit
npm run check:hedera-provisioning
# After the reviewed ATS source build:
npm run check:ats:hfs
```

The unit suite uses real SDK serialization/signatures and intercepted network calls. The ATS input test uses the current, verified ATS and adapter artifacts with synthetic constructor addresses. The existing `check:ats` suite separately executes actual ATS bytecode on Anvil with a test verifier. None of these checks establishes live Hedera acceptance or SP1 proof verification.

## Boundaries

`prepareHfsCreation(signedTransaction, policy)` authenticates a canonical EIP-1559 direct creation: chain, sender, nonce, exact creation hash, zero value, low-s signature and gas fee limits. Policy and native inputs must have exact own data fields; accessors and unknown fields are rejected. The resulting builders return frozen `FileCreateTransaction`, one-chunk `FileAppendTransaction`, and `EthereumTransaction` instances. The file expires between one hour and one day after its explicit native valid start. Each operation has its own caller-supplied payer, node, unique transaction ID and fee cap. File readback must exactly match the complete expected ASCII hex before creating the Ethereum wrapper.

`submitHfsOnce({journalPath, transaction, publicKey, signer})` submits one prepared native operation. It copies the transaction into a private SDK instance and passes copied signing bytes to the signer. It verifies that signature, writes the complete signed bytes and a dispatch marker with `fsync`, then calls the built-in testnet client once with TLS, one node, one attempt and no operator. The supplied key must actually be authorized for the payer/file by Hedera; offline signature validation does not establish that authority.

`recoverHfsSubmission(journalPath)` never signs or submits. It queries the official testnet mirror and requires the recorded transaction ID **and exact native SHA-384 hash**, user transaction nonce 0, non-scheduled status, operation type and node to match. It rechecks cached outcomes against the provider. Its result is explicitly `provider_observed`, not a cryptographic inclusion proof. Missing, conflicting, oversized or unavailable responses remain unresolved. Downstream ATS admission still has to verify the exact creation input, runtime graph, authority and creation block through independently supplied pins.

One journal path identifies one operation. Reusing it cannot resend, even after a precheck failure or timeout. The journal is private, mode 0600; use the ignored `journals/` directory or another ignored private directory. Do not copy it to obtain a retry slot. Signed bytes can be broadcast while valid and must not enter public logs.

A process crash can leave a `.lock` sibling. Confirm that the owning provisioning process has stopped before removing **only that lock**, then call recovery with the same journal. Never delete the journal or retry an uncertain append under a new native ID. A partial journal fails closed and needs manual reconciliation against the preserved signed operation; it is not automatically repaired or treated as unused.

## Live deployment still required

This package is an operation transport, not a complete deployment scheduler. Before live use, the controller must retain a unique mapping from deployment step to journal/native ID, enforce sequential successful file operations, read back the file, account for the aggregate native fees plus Ethereum gas and relay allowance, and retain all graph admission evidence. The Ethereum fee envelope alone does not cap the total HBAR spent across file operations. The funded payer/file-key signer, EVM sender and holder configuration remain external inputs.

No file upload, contract deployment or funded-account transaction was performed by the local tests. Testnet reset, RPC/mirror disagreement, mutable files and signer compromise remain explicit operational trust boundaries. A changed file cannot authorize different Ethereum creation bytes because the original signature binds the full input; it can still cause failure and consume fees.

## Official references checked

- [Hedera Ethereum transactions](https://docs.hedera.com/native/smart-contracts/ethereum-transaction): HFS rehydration, creation/call size distinction, gas and relay allowance.
- [Create a file](https://docs.hedera.com/native/files/create) and [append to a file](https://docs.hedera.com/native/files/append): native file operations and signatures.
- [Consensus implementation at the reviewed commit](https://github.com/hiero-ledger/hiero-consensus-node/blob/7e0dc44e82999189dcef8635bd4795c366b73350/hedera-node/hedera-smart-contract-service-impl/src/main/java/com/hedera/node/app/service/contract/impl/infra/EthereumCallDataHydration.java): hex decoding of file contents before restoring the signed call data.
- [Transaction lookup](https://docs.hedera.com/api-reference/transactions/get-transaction-by-id) and [official REST endpoints](https://docs.hedera.com/reference/rest-api): hash/ID/nonce fields and the testnet mirror origin.
- [Official Hiero JavaScript SDK](https://github.com/hiero-ledger/hiero-sdk-js): package API and transaction retry/signing behavior, checked against the installed 2.88.0 source. The npm package advertises SLSA provenance; a metadata link alone is not independent verification of its attestation.
