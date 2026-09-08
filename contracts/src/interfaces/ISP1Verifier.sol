// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Official SP1 verifier interface; use a pinned version-specific, non-proxy deployment.
/// https://github.com/succinctlabs/sp1-contracts
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
