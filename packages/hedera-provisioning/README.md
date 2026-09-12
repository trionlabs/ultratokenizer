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

## Sequential creation controller

One controller owns one signed Ethereum creation and its HFS operations. It does not schedule the complete ATS deployment graph or reserve a budget across that graph; those require separate aggregate planning and admission.

`planAtsGraph({expectedManifestSha256, maxFundingTinybarByCreation, totalBudgetTinybar, buildRoot?})` is an offline inventory and aggregate ceiling check. It verifies the current source/artifact build against a caller-supplied expected manifest SHA-256, then orders the four recursive libraries, ten ATS facets, Gate and atomic profile creation. The profile constructor creates the resolver, adapter and token internally; they are not separate transactions. Every one of the 16 direct creations needs a positive caller-supplied maximum funding amount; the sum must fit the caller's total tinybar cap. Only the profile's _template_ already exceeds 24 KiB, so its HFS requirement is certain. `inline_candidate` for another creation does not guarantee its final constructor input fits inline.

The returned plan hash binds the local inventory, order and operator-provided ceilings. It does not prepare signed creation bytes, derive sender nonces or transaction IDs, prove those fee ceilings sufficient, reserve payer funds across processes, or admit any chain state. Instantiate and independently review each exact constructor and linked runtime before a creation controller can be used; an external reviewer must authenticate the supplied manifest pin. The graph remains an offline preflight even when this function succeeds.

`prepareAtsGraph({planInput, sender, governor, startNonce})` takes those same inventory inputs plus public EVM identities and the explicit first creation nonce. It launches a fresh local Anvil node with no generated accounts or fork, impersonates the public sender locally, and executes all 16 exact constructors. It returns linked creation bytes, predicted addresses, constructor-resolved runtime bytes/hashes, local gas usage and the three profile-created child runtimes. Solidity library self-address guards and Gate/profile immutables are obtained from actual constructor execution. No private key, signature or Hedera submission is involved. The caller must still verify the live sender nonce, absence of prior code, sufficient bounded fees and independently reconcile every deployed runtime and ATS authority before admission. `check:ats:hfs` exercises this preparation twice for deterministic output, checks library links and immutables, and requires Anvil plus the reviewed ATS build.

`initializeHfsController({journalPath, input})` validates the original signed creation and creates an offline, hash-linked plan. Keep the journal and its sibling operation journals inside the ignored `journals/` directory. Initialization returns the `planSha256` required by every subsequent call. The plan fixes its filesystem location, creation policy, signer public key, payer, node, file lifetime, and fee ceilings. It accepts exactly these input fields:

| Field                        | Meaning                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `deploymentId`               | A distinct nonzero lowercase 64-character identifier                |
| `signedTransaction`          | The original signed EIP-1559 creation accepted by the builder       |
| `creationPolicy`             | The builder's independent testnet creation policy                   |
| `payer`, `node`, `publicKey` | Explicit native payer, selected testnet node and payer/file signer  |
| `fileLifetimeSeconds`        | Canonical decimal string between `3600` and `86400`                 |
| `fees`                       | The exact fee settings below, all canonical decimal tinybar strings |

The fee fields are `fileCreateMaxFeeTinybar`, `fileAppendMaxFeeTinybar`, `readbackMaxFeeTinybar`, `readbackPaymentTinybar`, `ethereumMaxFeeTinybar`, `maxGasAllowanceTinybar`, and `totalBudgetTinybar`. Each must be positive except the relay gas allowance, which may be zero. Initialization refuses a total budget smaller than the conservative funding envelope for every planned operation.

`advanceHfsController({journalPath, expectedPlanSha256, signer})` advances one operation: file create, each ordered append, one paid file readback, then the Ethereum wrapper. Supply `signer(bytes)` as the institution's signing callback; no requester key, operator-bearing client or alternate network endpoint is accepted. The signer receives a copy of the exact native body and its returned signature is verified. The controller records and syncs the step, unique journal name, explicit native ID, body hash and maximum cost reservation before any signing call. Future calls use that same operation's recovery path; they cannot regenerate its ID, sign again or consume a second reservation.

```js
const initialized = await initializeHfsController({ journalPath, input });
const result = await advanceHfsController({
  journalPath,
  expectedPlanSha256: initialized.planSha256,
  signer: signInstitutionTransaction,
});
```

Call once per intended next step. `step_succeeded` and `step_recovered` allow another advance. `unresolved` retains the reservation and permits recovery only; `failed` retains the observed terminal failure. A crash before the per-operation signed journal exists stays unresolved rather than obtaining a new signing opportunity. A torn controller journal, changed plan/location, changed signed native body or changed historical observation fails closed. Concurrent advances share one exclusive controller lock. A stale lock requires the same stopped-process review described for operation journals.

Before progressing, the controller rechecks every previously saved native outcome through exact-hash recovery. Missing or conflicting history blocks subsequent signing, including after an observed testnet reset. This detects inconsistent observations, not every possible network reset; downstream deployment admission must still establish the intended chain state. A successfully completed readback is recovered locally from its retained signed query and saved response, and must be no older than five minutes before the Ethereum step. The full returned bytes must equal the expected ASCII hex. A changed file can cause a charged failure, but cannot alter the original signed Ethereum creation.

### Paid file readback

`readHfsContentsOnce` is a separate one-attempt paid query. Its header contains an ordinary signed native transfer from the payer to the selected node. That transfer is **never submitted separately**. The query records its file ID, exact payment, fee cap, native ID, signing intent, signed payment and full query protobuf before dispatch. A fixed TLS testnet client makes one application dispatch with that immutable payment, no operator and no implicit fee estimation. This limits application attempts; it does not establish exactly one physical RPC transmission or independent node authentication from the SDK's TLS flag. The adapter validates the response header's protobuf semantics, returned file ID, exact byte length and contents hash. The returned bytes and observation time are synced before the controller can create an Ethereum wrapper.

This requires a small private compatibility adapter pinned to SDK `2.88.0`. The ordinary public `FileContentsQuery` path replaces an explicit payment ID during preparation and generates another signed payment when constructing the actual request. The adapter overrides only those two lifecycle hooks to preserve the already recorded official protobuf. Tests exercise the inherited SDK execution loop with only the RPC dispatch intercepted, forbid any `TransactionId.generate` inside readback, and assert one dispatch with the exact durable signed query. Changing the SDK version requires reviewing this adapter; its runtime version check refuses a silent upgrade.

`recoverHfsReadback` never queries or pays again. It can recover a response already saved locally after checking the exact signed payment/query and contents. If the original query was sent but its response was lost, the step remains unresolved and the controller cannot proceed to creation. Readback signatures authorize a payment to a node; they do not independently authenticate the response or bind a file ID. The retained complete query and provider response are operational evidence with `provider_observed` assurance.

### Cumulative fee reservation

The plan reserves these components once, in tinybars, for each unique step:

| Component                            | Conservative reserve                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| File operations and Ethereum wrapper | Sum of their explicit native maximum transaction fees                  |
| Paid readback                        | Its explicit query transfer plus its payment transaction's maximum fee |
| Ethereum sender gas funding          | `ceil(gasLimit × maxFeePerGas / 10^10)`                                |
| Relay gas funding                    | The wrapper's explicit `maxGasAllowanceTinybar`                        |
| Aborted Ethereum execution           | An additional fixed `100000000` tinybars, or 1 HBAR                    |

Ethereum gas price is denominated in weibars; `10^10` weibars equal one tinybar. Integer conversion rounds upward with `BigInt`. Sender gas and relay allowance are separate funding ceilings; there is no additional aggregate gas line that counts them again. The abort cushion covers the separately documented aborted-transaction charge against the relayer. It is deliberately conservative: normal and aborted execution are alternative outcomes, and this reserve is not a claim that both charges occur. The controller never treats the reserve as measured expenditure or returns it to the available budget after an uncertain result. Recovery reads add zero reservations.

The budget is local to this immutable controller and does not control another process using the same payer or a trusted operator who rewrites/recreates the plan. Keep one original controller for the signed creation throughout ambiguity. A hash chain detects drift; it does not authenticate history against its file owner. Local filesystem locking and sync semantics remain operational assumptions.

### Live deployment and graph admission remain separate

`deployment_observed` means the controller retained exact provider observations for the file operations and Ethereum creation. Its result always has `chainGraphAdmitted: false` and `settledCostKnown: false`. The ATS runtime graph, contract address/code, roles, original creation block and downstream Gate registration still need their independent deployment admission checks. The funded payer/file-key signer, EVM sender and holder configuration remain external inputs.

The controller tests use real SDK serialization/signatures and intercepted consensus, mirror and query responses. They cover sequence, crash recovery, concurrent calls, budget limits, configuration/location drift, exact ASCII readback and the single-payment query lifecycle. No file upload, contract deployment or funded-account transaction was performed by those tests.

## Official references checked

- [Hedera Ethereum transactions](https://docs.hedera.com/native/smart-contracts/ethereum-transaction): HFS rehydration, creation/call size distinction, gas and relay allowance.
- [Create a file](https://docs.hedera.com/native/files/create) and [append to a file](https://docs.hedera.com/native/files/append): native file operations and signatures.
- [Consensus implementation at the reviewed commit](https://github.com/hiero-ledger/hiero-consensus-node/blob/7e0dc44e82999189dcef8635bd4795c366b73350/hedera-node/hedera-smart-contract-service-impl/src/main/java/com/hedera/node/app/service/contract/impl/infra/EthereumCallDataHydration.java): hex decoding of file contents before restoring the signed call data.
- [Transaction lookup](https://docs.hedera.com/api-reference/transactions/get-transaction-by-id) and [official REST endpoints](https://docs.hedera.com/reference/rest-api): hash/ID/nonce fields and the testnet mirror origin.
- [Official Hiero JavaScript SDK](https://github.com/hiero-ledger/hiero-sdk-js): package API and transaction retry/signing behavior, checked against the installed 2.88.0 source. The npm package advertises SLSA provenance; a metadata link alone is not independent verification of its attestation.
- [Pinned gas charging implementation](https://github.com/hiero-ledger/hiero-consensus-node/blob/7e0dc44e82999189dcef8635bd4795c366b73350/hedera-node/hedera-smart-contract-service-impl/src/main/java/com/hedera/node/app/service/contract/impl/exec/gas/CustomGasCharging.java): sender/relay charging and the separately capped one-HBAR aborted-transaction relayer charge used for conservative budgeting.
