# Reproducible ATS provisioning build

This package builds a narrow synthetic gold-deposit-right profile from normal repository sources. It includes the ten selected ATS facets, all four linked libraries, the direct resolver and proxy, an inert constructor-only initializer, and the current main `IssuanceGate` and `AtsGateMintAdapter`. It does not deploy anything or register a verifier.

The token starts with zero supply, three decimal places, a fixed 1,000,000 mg cap and a single partition. Its metadata explicitly describes a synthetic right; it makes no bank, physical reserve, securities or ISIN claim. The initializer grants the adapter the sole issuer role and retains administration in its inert runtime. The profile accepts caller-supplied facet/library addresses and hashes: a reviewed build and exact deployment graph remain required admission evidence.

## Build and test

Run these commands from the repository root using the repository's pinned Node version. The native ATS compiler supports Linux x64 and macOS x64/arm64; other platforms fail explicitly.

```sh
npm --prefix contracts/ats ci --ignore-scripts
npm --prefix contracts/ats run compiler:fetch
npm --prefix contracts/ats run build
npm --prefix contracts/ats run verify
npm --prefix contracts/ats test
```

Only `npm ci` and the explicit compiler fetch need public network access. Build and verification do not fetch sources, use system compiler fallbacks or read ignored historical artifacts. The build replaces only this package's generated output. Compiler caches, dependencies and `build/` are ignored.

The actual client acceptance test requires installed root dependencies and `anvil` on `PATH`. It starts and stops an ephemeral loopback EVM. From the repository root:

```sh
npm --prefix packages/issuance run build
ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS="$PWD/contracts/ats/build" \
  node --test packages/issuance/dist/test/ats.test.js
```

Without that environment variable, the ordinary unit suite intentionally skips the local EVM test. With it set, missing, changed or incomplete artifacts fail verification before deployment. The mandatory repository ATS check supplies this directory and requires the local test.

The local test executes real ATS and current Gate/adapter bytecode. A separate **test-only** verifier checks test public-value binding; it is not SP1 acceptance or authenticated source evidence. The test covers actual reader ABI/storage assumptions, identity and creation-block mismatches, rejected deployer authority, exact issuance, a fresh unused request that validates before rights revocation and fails afterward, and a 125 mg transfer confirmed through the client's prepare/send/wait intent API.

## Source and compiler provenance

`source-lock.json` records public archive URLs, archive SHA-256 digests, and byte lengths and SHA-256 digests for every vendored source. The import closure contains 197 unchanged Solidity files: 187 from [ATS commit be4f860e408ec5b1a24d12feb6f872aabff69319](https://github.com/hashgraph/asset-tokenization-studio/tree/be4f860e408ec5b1a24d12feb6f872aabff69319), package version 8.0.0; six from OpenZeppelin Contracts 4.9.6; and four from OpenZeppelin Contracts Upgradeable 4.9.6. The upstream Apache-2.0 and two MIT licenses are retained in `vendor/`. Do not format or otherwise rewrite vendored files. One upstream time-travel storage wrapper belongs to the production-linked import closure; this is not a test verifier or test deployment path.

`build-config.json` pins both compiler identities, checksums, settings and selected targets:

| Source                                          | Compiler                            | Settings                     |
| ----------------------------------------------- | ----------------------------------- | ---------------------------- |
| Current main Gate, adapter and relative imports | solc-js 0.8.30, commit 73712a01     | Paris, optimizer 200, via IR |
| ATS closure and local initializer               | native solc 0.8.28, commit 7893614a | Cancun, optimizer 100, no IR |

The main compiler is locked by `package-lock.json` and its `soljson.js` checksum. The native compiler installer checks the exact official binary digest before execution; the build checks it again. The macOS universal binary and Linux x64 checksums are recorded by the official [macOS](https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/macosx-amd64/list.json) and [Linux](https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/list.json) compiler indexes. The initial solc-js 0.8.28 attempt failed on this closure with a WASM memory-access exception; selecting the pinned native compiler preserves the Solidity version and settings.

The main sources are read directly from `contracts/src/`; no copied Gate or adapter is compiled. A virtual `AdapterArtifactPin.sol` embeds the freshly built adapter's creation-code hash in the initializer. Any deliberate source, compiler, settings or link change requires a new build and deployment review, including review of the client's fixed ATS selector and link-offset checks.

## Output contract

`build/manifest.json` has format `ultratokenizer.ats-build.v1`, scope `synthetic-provisioning`, compiler configuration, current input hashes, 19 artifact records, the generated adapter-pin hash, and 15 runtime link records. Each `artifacts/<Name>.json` contains compiler identity/settings, source identity, ABI, creation/runtime templates, metadata, method selectors, link references and immutable references. Manifest records include artifact SHA-256 and template byte lengths.

`build/test-manifest.json` has format `ultratokenizer.ats-test-build.v1`, scope `test-only-no-proof-acceptance`, the production manifest hash and one `test-artifacts/GateStateOnlyVerifier.json` record. The permissive test artifact is excluded from the provisioning artifact set and its source metadata. Standard JSON inputs and compiler warnings are also retained under `build/` for diagnosis.

`scripts/verify-build.mjs` exports `verifyBuild({repoRoot?, buildRoot?})`, returning the verified manifest/hash, production artifacts, test manifest and test artifacts. It checks exact inventories, current source hashes, artifacts, compiler settings, recursive links and the generated adapter pin. Mutation tests reject source drift, missing transitive sources or artifacts, stale Gate inputs and changed artifact bytes. These integrity records are not a self-authenticating source-to-bytecode proof: review and a fresh trusted build are still necessary. Runtime templates must be linked and immutable values instantiated before deployed code hashes are pinned.

## Remaining deployment boundary

The initializer checks its adapter creation hash and supplied runtime identities, but it does not independently certify canonical facet/library source, correct link addresses or the entire initial configuration. The independent admission must bind the reviewed creation input, exact artifacts and deployed links, direct creation receipt, inert owner, sole issuer/no agent state, resolver configuration and absent mutable authority paths. The client combines that trusted admission with current runtime, selector, role and effective-state checks. Scalar storage reads cannot establish arbitrary mapping emptiness or historical ownership/configuration by themselves.

The fresh local build measures a 27,119-byte initializer creation template, plus 4,640 bytes of constructor ABI: **31,759 bytes of complete creation input**, producing a 331-byte runtime. Its measured local Cancun execution uses 14,353,212 gas. These are local EVM measurements, not Hedera fee or gas-limit validation. The largest linked library runtime is 21,762 bytes.

Current [Hedera EthereumTransaction documentation](https://docs.hedera.com/native/smart-contracts/ethereum-transaction) describes a 24 KB inline creation-data limit and continued support for HFS-backed `callDataFileId`. This profile exceeds that inline limit. The [HFS transport package](../../packages/hedera-provisioning/README.md) validates the complete signed/reconstructed input and provides sequential file operations, one paid exact readback, fee reservations and hash-bound recovery for one direct creation. Its tests preserve this actual constructor input offline. Scheduling and budgeting the complete ATS graph, independent graph admission, live receipt compatibility and network gas/opcode checks remain separate work. [HFS creation](https://docs.hedera.com/native/files/create) and [append](https://docs.hedera.com/native/files/append) are external transactions, not actions performed by this build package. No factory-based admission, live upload/deployment, genuine proof acceptance, redemption or physical backing is established here.
