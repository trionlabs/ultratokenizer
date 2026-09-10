// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SP1Verifier} from "../src/vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";
import {Verifier} from "../src/vendor/sp1/v6.1.0/Groth16Verifier.sol";
import {IssuanceGate} from "../src/IssuanceGate.sol";
import {RequestHash} from "../src/RequestHash.sol";
import {GateFixture, Vm} from "./IssuanceGate.t.sol";

/// Real verifier rejection tests. No valid proof fixture is claimed by this suite.
contract Sp1Groth16VerifierTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SP1Verifier internal verifier;
    bytes32 internal constant KEY = bytes32(uint256(77));
    bytes32 internal constant VERIFIER_HASH = 0x4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696;
    bytes32 internal constant VK_ROOT = 0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352;

    function setUp() public {
        verifier = new SP1Verifier();
    }

    function envelope(uint256 exitCode, uint256 vkRoot) internal pure returns (bytes memory) {
        uint256[8] memory invalidProof;
        return abi.encodePacked(bytes4(VERIFIER_HASH), abi.encode(exitCode, vkRoot, uint256(0), invalidProof));
    }

    function testPinnedOuterCircuitIdentity() public view {
        require(keccak256(bytes(verifier.VERSION())) == keccak256("v6.1.0"), "wrong outer circuit");
        require(verifier.VERIFIER_HASH() == VERIFIER_HASH && verifier.VK_ROOT() == VK_ROOT, "wrong outer pins");
        require(address(verifier).codehash == keccak256(type(SP1Verifier).runtimeCode), "runtime changed");
        require(envelope(0, uint256(VK_ROOT)).length == 356, "wrong canonical envelope length");
    }

    function testShortAndLegacyProofEnvelopesRevert() public {
        vm.expectRevert();
        verifier.verifyProof(KEY, hex"", hex"");
        vm.expectRevert();
        verifier.verifyProof(KEY, hex"", hex"4388a2");
        uint256[8] memory invalidProof;
        bytes memory legacy = abi.encodePacked(bytes4(VERIFIER_HASH), abi.encode(invalidProof));
        require(legacy.length == 260, "test no longer models old envelope");
        vm.expectRevert();
        verifier.verifyProof(KEY, hex"", legacy);
    }

    function testWrongVerifierSelectorReverts() public {
        bytes memory proof = envelope(0, uint256(VK_ROOT));
        proof[0] = 0;
        vm.expectRevert(
            abi.encodeWithSelector(
                SP1Verifier.WrongVerifierSelector.selector, bytes4(0x0088a21c), bytes4(VERIFIER_HASH)
            )
        );
        verifier.verifyProof(KEY, hex"", proof);
    }

    function testUnsuccessfulGuestExitCannotVerify() public {
        bytes memory proof = envelope(1, uint256(VK_ROOT));
        vm.expectRevert(SP1Verifier.InvalidExitCode.selector);
        verifier.verifyProof(KEY, hex"", proof);
    }

    function testWrongRecursionVkRootCannotVerify() public {
        bytes memory proof = envelope(0, uint256(VK_ROOT) + 1);
        vm.expectRevert(SP1Verifier.InvalidVkRoot.selector);
        verifier.verifyProof(KEY, hex"", proof);
    }

    function testCanonicalEnvelopeWithInvalidPairingReverts() public {
        bytes memory proof = envelope(0, uint256(VK_ROOT));
        vm.expectRevert(Verifier.ProofInvalid.selector);
        verifier.verifyProof(KEY, hex"00010203", proof);
    }

    function testProgramKeyOutsideScalarFieldReverts() public {
        bytes memory proof = envelope(0, uint256(VK_ROOT));
        vm.expectRevert(Verifier.PublicInputNotInField.selector);
        verifier.verifyProof(bytes32(type(uint256).max), hex"", proof);
    }
}

contract RealVerifierGateRejectionTest is GateFixture {
    function testRealVerifierRejectsInvalidPairingWithoutConsumingAuthorization() public {
        SP1Verifier realVerifier = new SP1Verifier();
        gate.registerProgram(2, address(realVerifier), address(realVerifier).codehash, bytes32(uint256(77)), 2);
        gate.registerPolicy(ISSUER, 2, 2, SOURCE, 1, keccak256("real verifier test policy"));
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        RequestHash.Request memory r = request();
        r.reservationId = bytes32(uint256(55));
        r.policyVersion = 2;
        reserve(r);
        RequestHash.Permit memory p = permit(r);
        bytes memory hsig = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory isig = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        uint256[8] memory invalidProof;
        bytes memory proof = abi.encodePacked(
            bytes4(realVerifier.VERIFIER_HASH()),
            abi.encode(uint256(0), uint256(realVerifier.VK_ROOT()), uint256(0), invalidProof)
        );
        bytes memory values = evidence(r);
        vm.expectRevert(Verifier.ProofInvalid.selector);
        gate.issue(r, hsig, p, isig, values, proof);
        assertUnused(r);
        assertPool(r.token, r.amount, 0);
    }
}
