// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISP1Verifier} from "../../src/interfaces/ISP1Verifier.sol";

/// Test-only stand-in for Gate/HTS orchestration. It proves nothing.
/// Deployment scripts and application execution must never import this contract.
contract MockSp1Verifier is ISP1Verifier {
    address public owner;
    bytes32 public programVKey;
    bytes32 public expectedPublicValues;
    bool public reject;

    error Unauthorized();

    constructor(bytes32 programVKey_) {
        owner = msg.sender;
        programVKey = programVKey_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// Pass/fail toggle plus the program key and expected public-values hash.
    /// A zero expected hash accepts any 224-byte public values.
    function configure(bytes32 programVKey_, bytes32 expectedPublicValues_, bool reject_) external onlyOwner {
        programVKey = programVKey_;
        expectedPublicValues = expectedPublicValues_;
        reject = reject_;
    }

    function setReject(bool reject_) external onlyOwner {
        reject = reject_;
    }

    function verifyProof(bytes32 key, bytes calldata publicValues, bytes calldata proofBytes) external view override {
        require(!reject, "MockSp1Verifier: reject");
        require(key == programVKey, "MockSp1Verifier: program vkey mismatch");
        require(publicValues.length == 224, "MockSp1Verifier: bad public values");
        require(proofBytes.length != 0, "MockSp1Verifier: empty proof");
        if (expectedPublicValues != bytes32(0)) {
            require(keccak256(publicValues) == expectedPublicValues, "MockSp1Verifier: public values mismatch");
        }
    }
}
