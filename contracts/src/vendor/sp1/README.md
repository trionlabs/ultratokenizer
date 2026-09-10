# Pinned direct SP1 Groth16 verifier

These three Solidity files are unmodified copies from [succinctlabs/sp1-contracts, commit `d3629729c3216eb51bd4859d027a8eb729399fa4`](https://github.com/succinctlabs/sp1-contracts/tree/d3629729c3216eb51bd4859d027a8eb729399fa4/contracts/src). The selected outer circuit directory is `v6.1.0`; this is distinct from the Rust SDK package version and the application's guest program verification key. This commit permits Solidity `^0.8.20` for the generated Groth16 verifier. The repository builds it with the pinned Solidity 0.8.30 compiler.

| Upstream path under `contracts/src/` | SHA-256 of exact local source bytes                                |
| ------------------------------------ | ------------------------------------------------------------------ |
| `ISP1Verifier.sol`                   | `9e918032a5aa799c1319b14b013154d6a40ca6e5f2267c9f540560abd7fd7689` |
| `v6.1.0/Groth16Verifier.sol`         | `01ab92508b9d56556ee247c7cb6b2ebd9c17835a4618896462b2a3a8708a50bf` |
| `v6.1.0/SP1VerifierGroth16.sol`      | `48e1db5baca3b102242ebd88280b3689a088076688146cd0d98876f5dacb76d0` |

All three declare `SPDX-License-Identifier: MIT`. Original authorship notices credit Succinct Labs and, for the Groth16 template, Remco Bloemen. The pinned upstream tree provides no separate license file; [LICENSE-MIT.txt](LICENSE-MIT.txt) reproduces the [MIT permission and disclaimer text](https://spdx.org/licenses/MIT.html). No copyright holder or year absent from upstream has been invented. Foundry formatting excludes this directory to retain byte-for-byte source provenance.

## Proof envelope and identities

The direct contract is `src/vendor/sp1/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier`. It has no proxy, configurable implementation or gateway registry. Its wrapper declares:

```text
VERSION       v6.1.0
VERIFIER_HASH 0x4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696
VK_ROOT       0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352
```

`verifyProof(bytes32,bytes,bytes)` checks the first four proof bytes against `VERIFIER_HASH`, hashes public values with SHA-256 masked to 253 bits, and decodes the remaining bytes as `(uint256 exitCode, uint256 vkRoot, uint256 nonce, uint256[8] proof)`. A canonical envelope is therefore **356 bytes**, including its four-byte selector. The wrapper requires exit code zero and the pinned recursion `VK_ROOT`, then verifies the pairing with five public inputs. The legacy 260-byte envelope cannot satisfy this decoder. The upstream ABI decoder does not enforce the absence of trailing bytes; canonical transport validation is a separate client requirement. The wrapper ABI must be used; inherited raw pairing and compression entry points are not the Gate's verification interface.

The outer `VERIFIER_HASH`, recursion `VK_ROOT`, deployed runtime code hash and guest program vkey identify different objects. None can substitute for another. In particular, this outer verifier does not establish that an approved guest implements exact issuance or authenticates a real bank source; that depends on the reviewed guest and its pinned vkey.

## Local artifact and deployment pin

With `contracts/foundry.toml` (Solidity `0.8.30`, optimizer 200 runs, `via_ir = true`, Paris EVM, default IPFS metadata, no libraries), the direct verifier runtime is 5,851 bytes with Keccak-256:

```text
0xebc2d3ceb8616e13986f89724165f3b9e97993bfa4059d7ddc5e12c4db02124d
```

Reproduce the artifact with `forge build --root contracts`. The generated artifact is `contracts/out/SP1VerifierGroth16.sol/SP1Verifier.json`; `deployedBytecode.object` is the byte string to hash. Source paths, metadata or compiler settings can change this runtime hash even when the outer circuit identity is unchanged. The deploy script computes the expected hash from `type(SP1Verifier).runtimeCode` in its own build and requires both the supplied hash and the already-deployed address's runtime to match it. It does not default to a public proxy/gateway or deploy a verifier itself.

`contracts/test/Sp1Groth16Verifier.t.sol` exercises this actual verifier: short/legacy envelopes, wrong selectors, unsuccessful exits, wrong recursion roots, out-of-field public input and invalid pairings all revert. A Gate test verifies that a real-verifier rejection preserves the reservation, replay markers and pool accounting. These are negative cryptographic checks on the local EVM. **No valid proof of this application's guest is included or claimed by those tests**, and they do not establish native Hedera precompile compatibility.
