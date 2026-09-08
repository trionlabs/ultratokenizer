// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RequestHash} from "../src/RequestHash.sol";
import {IssuanceGate} from "../src/IssuanceGate.sol";

/// Independent serialization parity with the native claim guest's public synthetic fixtures.
/// No proof verification is claimed by this test.
contract SharedClaimAbiTest {
    function testNativeClaimFixtureMatchesSolidityRequestAndPublicValues() public pure {
        RequestHash.Request memory request = RequestHash.Request(
            1,
            "ISSUE",
            0x4444444444444444444444444444444444444444444444444444444444444444,
            296,
            address(0x1111111111111111111111111111111111111111),
            address(0x2222222222222222222222222222222222222222),
            address(0x3333333333333333333333333333333333333333),
            1000,
            "XAU_MILLIGRAM",
            0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3,
            0x5555555555555555555555555555555555555555555555555555555555555555,
            0xb6417de325d0882c4503ac0613ae9fbe626868abf498d71b56a8e916e7923e82,
            0x617dc7ea467453c7bfd93b57b93bda15cba00b3024ba28671c01b499d10ef651,
            1,
            1,
            0,
            1999999000
        );
        bytes memory encoded =
            hex"00000000000000000000000000000000000000000000000000000000000000016d2f6c833f286cc920a981057a3c090eab9f336fefe632517bc2188eaa80521048fdaab6170b61057682520bdbc81419b97c31d0072717d36ba752b7a203cf8ea1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1617dc7ea467453c7bfd93b57b93bda15cba00b3024ba28671c01b499d10ef651b6417de325d0882c4503ac0613ae9fbe626868abf498d71b56a8e916e7923e820000000000000000000000000000000000000000000000000000000077359400";
        require(encoded.length == 224, "wrong public output length");
        IssuanceGate.Evidence memory evidence = abi.decode(encoded, (IssuanceGate.Evidence));
        require(
            evidence.profileVersion == 1 && evidence.requestDigest == RequestHash.digest(request),
            "guest/request mismatch"
        );
        require(
            evidence.signerFingerprint == 0x48fdaab6170b61057682520bdbc81419b97c31d0072717d36ba752b7a203cf8e
                && evidence.sourceId == 0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1,
            "source mismatch"
        );
        require(
            evidence.claimUsageId == request.claimUsageId && evidence.claimCommitment == request.claimCommitment,
            "claim mismatch"
        );
        require(
            evidence.claimValidUntil == 2000000000 && evidence.claimValidUntil >= request.validUntil, "expiry mismatch"
        );
        require(keccak256(abi.encode(evidence)) == keccak256(encoded), "noncanonical public output");
    }
}
