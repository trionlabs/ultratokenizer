// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Test-only boundary double. This authenticates no source and verifies no SP1.
/// Its deliberate binding guard lets these tests exercise real Gate state paths.
contract GateStateOnlyVerifier {
    bytes32 public expectedValuesHash;
    bool public reject;
    bytes32 public constant TEST_VKEY = keccak256("TEST ONLY: not an SP1 program key");

    function configure(bytes32 valuesHash, bool rejected) external {
        expectedValuesHash = valuesHash;
        reject = rejected;
    }

    function verifyProof(bytes32 key, bytes calldata values, bytes calldata proof) external view {
        require(
            !reject && key == TEST_VKEY && keccak256(values) == expectedValuesHash
                && keccak256(proof) == keccak256(hex"cafe"),
            "test verifier rejected"
        );
    }
}
