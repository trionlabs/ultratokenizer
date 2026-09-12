// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IssuanceGate} from "../src/IssuanceGate.sol";
import {RequestHash} from "../src/RequestHash.sol";
import {GateFixture, TestAdapter} from "./IssuanceGate.t.sol";

/// Test-only reconstruction of a legacy registry record. No production mutation path exposes this.
contract LegacyProgramGate is IssuanceGate {
    constructor(address governor_) IssuanceGate(governor_) {}

    function installLegacyProgram(address verifier) external onlyGovernor {
        programs[1] = Program(verifier, verifier.codehash, bytes32(uint256(77)), 1, false);
    }
}

contract ReservationLifecycleTest is GateFixture {
    function testLateLongerReservationCannotReviveAnExpiredSignedRequest() public {
        RequestHash.Request memory r = freshRequest(20, 1000);
        r.validUntil = EXPIRY - 100;
        RequestHash.Permit memory p = permit(r);
        bytes memory values = evidence(r);
        verifier.configure(keccak256(values), false);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory ps = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        (address recipient,,,,,,,,) = gate.reservations(ISSUER, r.reservationId);
        require(recipient == address(0), "reservation already exists");

        vm.warp(r.validUntil);
        vm.expectRevert(IssuanceGate.Expired.selector);
        gate.issue(r, hs, p, ps, values, hex"cafe");
        vm.expectRevert(IssuanceGate.InvalidConfiguration.selector);
        reserve(r);

        // A delayed issuer call can still open a longer-lived reservation. Local
        // expired-unopened closure must not claim this chain capacity is released.
        vm.prank(issuer);
        gate.openReservation(
            ISSUER, 1, r.reservationId, holder, r.token, r.amount, EXPIRY, RequestHash.digest(r), r.claimUsageId
        );
        assertPool(r.token, 2000, 0);
        vm.warp(uint256(r.validUntil) + 1);
        vm.expectRevert(IssuanceGate.Expired.selector);
        gate.issue(r, hs, p, ps, values, hex"cafe");
        require(!gate.usedRequests(RequestHash.digest(r)) && !gate.usedClaims(r.claimUsageId), "expired claim consumed");
        require(adapter.balances(holder) == 0, "expired request minted");
        vm.expectRevert(IssuanceGate.ReservationNotExpired.selector);
        gate.expireReservation(ISSUER, r.reservationId);

        // A changed deadline needs a new holder signature as well as a new permit.
        r.validUntil = EXPIRY;
        vm.expectRevert(IssuanceGate.InvalidSignature.selector);
        gate.issue(r, hs, p, ps, values, hex"cafe");
        gate.revokeReservation(ISSUER, 1, r.reservationId);
        assertPool(r.token, 1000, 0);

        r.reservationId = bytes32(uint256(99));
        reserve(r);
        issue(r, 0);
        require(adapter.balances(holder) == 1000, "fresh request did not mint exactly once");
        assertPool(r.token, 1000, 1000);
    }

    function testRequestCanStillMintImmediatelyBeforeExpiry() public {
        RequestHash.Request memory r = freshRequest(20, 1000);
        r.validUntil = EXPIRY - 100;
        reserve(r);
        vm.warp(uint256(r.validUntil) - 1);
        issue(r, 0);
        require(gate.usedClaims(r.claimUsageId), "live request not consumed");
        assertPool(r.token, 1000, 1000);
    }

    function freshRequest(uint256 id, uint256 amount) internal view returns (RequestHash.Request memory r) {
        r = request();
        r.requestId = bytes32(id);
        r.reservationId = bytes32(id + 1);
        r.claimUsageId = bytes32(id + 2);
        r.nonce = id;
        r.amount = amount;
    }

    function testBackingMustBeConfiguredAndCannotBeBorrowedAcrossTokens() public {
        RequestHash.Request memory r = freshRequest(20, 1000);
        r.token = address(0xBEEF);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        reserve(r);
        assertPool(adapter.token(), 1000, 0);
        gate.setBackingCap(ISSUER, r.token, 1000);
        reserve(r);
        assertPool(r.token, 1000, 0);
        assertPool(adapter.token(), 1000, 0);
    }

    function testIssuerPoolsDoNotShareCeilings() public {
        RequestHash.Request memory r = freshRequest(20, 1000);
        r.issuerId = bytes32(uint256(99));
        gate.registerIssuerKey(r.issuerId, 1, issuer, EXPIRY);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        reserve(r);
        gate.setBackingCap(r.issuerId, r.token, 1000);
        reserve(r);
        (, uint256 pending, uint256 outstanding) = gate.backingPools(r.issuerId, r.token);
        require(pending == 1000 && outstanding == 0, "wrong other-issuer pool");
        assertPool(adapter.token(), 1000, 0);
    }

    function testReservationsCompeteForAggregatePendingCapacity() public {
        RequestHash.Request memory r = freshRequest(20, 1001);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        reserve(r);
        assertPool(r.token, 1000, 0);
        r.amount = 1000;
        reserve(r);
        assertPool(r.token, 2000, 0);
        RequestHash.Request memory third = freshRequest(40, 1);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        reserve(third);
        issue(request(), 0);
        assertPool(r.token, 1000, 1000);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        reserve(third);
    }

    function testOnlyGovernorChangesCapAndCannotDropBelowExposure() public {
        address token = adapter.token();
        vm.prank(issuer);
        vm.expectRevert(IssuanceGate.Unauthorized.selector);
        gate.setBackingCap(ISSUER, token, 3000);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        gate.setBackingCap(ISSUER, token, 999);
        gate.setBackingCap(ISSUER, token, 1000);
        issue(request(), 0);
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        gate.setBackingCap(ISSUER, token, 999);
        assertPool(token, 0, 1000);
        gate.setBackingCap(ISSUER, token, 3000);
        assertPool(token, 0, 1000);
    }

    function testRequestDigestIsBoundEvenForSameRightAndAmount() public {
        RequestHash.Request memory r = request();
        r.nonce = 8;
        issue(r, IssuanceGate.ReservationMismatch.selector);
        r = request();
        r.claimCommitment = bytes32(uint256(99));
        issue(r, IssuanceGate.ReservationMismatch.selector);
        assertUnused(r);
    }

    function testExactCapacityIsCheckedIndependentlyOfRequestDigest() public {
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        for (uint256 i; i < 2; i++) {
            RequestHash.Request memory r = freshRequest(20 + i * 10, 1000);
            uint256 capacity = i == 0 ? 999 : 1001;
            vm.prank(issuer);
            gate.openReservation(
                ISSUER, 1, r.reservationId, holder, r.token, capacity, EXPIRY, RequestHash.digest(r), r.claimUsageId
            );
            issue(r, IssuanceGate.ReservationMismatch.selector);
            require(!gate.usedClaims(r.claimUsageId), "mismatched amount consumed claim");
            assertPool(r.token, capacity, 0);
            gate.revokeReservation(ISSUER, 1, r.reservationId);
        }
        assertPool(adapter.token(), 0, 0);
    }

    function testClaimIdentityIsCheckedIndependentlyOfRequestDigest() public {
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        RequestHash.Request memory r = freshRequest(20, 1000);
        vm.prank(issuer);
        gate.openReservation(
            ISSUER, 1, r.reservationId, holder, r.token, 1000, EXPIRY, RequestHash.digest(r), bytes32(uint256(999))
        );
        issue(r, IssuanceGate.ReservationMismatch.selector);
        assertPool(r.token, 1000, 0);
    }

    function testUnusedExpiryReleasesOnceAndPreservesTerminalReservation() public {
        vm.expectRevert(IssuanceGate.ReservationNotExpired.selector);
        gate.expireReservation(ISSUER, RESERVATION);
        vm.warp(EXPIRY);
        vm.prank(holder);
        gate.expireReservation(ISSUER, RESERVATION);
        gate.expireReservation(ISSUER, RESERVATION);
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        assertPool(adapter.token(), 0, 0);
        (,,, uint256 used,,,,, bool released) = gate.reservations(ISSUER, RESERVATION);
        require(used == 0 && released, "missing terminal release");
        gate.setBackingCap(ISSUER, adapter.token(), 0);
    }

    function testRevocationAndLaterExpiryCannotReleaseTwice() public {
        vm.prank(issuer);
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        vm.warp(EXPIRY);
        gate.expireReservation(ISSUER, RESERVATION);
        assertPool(adapter.token(), 0, 0);
    }

    function testExpiredOrRevokedConsumedReservationKeepsBacking() public {
        RequestHash.Request memory r = request();
        issue(r, 0);
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        vm.warp(EXPIRY);
        gate.expireReservation(ISSUER, RESERVATION);
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        assertPool(r.token, 0, 1000);
        (,,, uint256 used,,,,, bool released) = gate.reservations(ISSUER, RESERVATION);
        require(used == 1000 && !released && gate.usedClaims(r.claimUsageId), "issued liability was reset");
        vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
        gate.setBackingCap(ISSUER, r.token, 999);
    }

    function testSpentClaimCannotOpenAnotherReservation() public {
        issue(request(), 0);
        RequestHash.Request memory r = request();
        r.reservationId = bytes32(uint256(55));
        r.requestId = bytes32(uint256(56));
        r.nonce = 1;
        vm.expectRevert(IssuanceGate.Replay.selector);
        reserve(r);
        assertPool(r.token, 0, 1000);
    }

    function testRegistryRejectsLegacyProfilesAndWrongRuntimePins() public {
        vm.expectRevert(IssuanceGate.InvalidConfiguration.selector);
        gate.registerProgram(2, address(verifier), address(verifier).codehash, bytes32(uint256(77)), 1);
        vm.expectRevert(IssuanceGate.InvalidConfiguration.selector);
        gate.registerProgram(2, address(verifier), bytes32(uint256(999)), bytes32(uint256(77)), 2);
        vm.expectRevert(IssuanceGate.InvalidConfiguration.selector);
        gate.registerProgram(2, address(verifier), address(verifier).codehash, bytes32(uint256(77)), 3);
    }

    function testOwnLegacyPolicyCannotBypassExactProfileRequirement() public {
        LegacyProgramGate legacy = new LegacyProgramGate(address(this));
        gate = legacy;
        adapter = new TestAdapter(address(gate));
        legacy.installLegacyProgram(address(verifier));
        gate.registerIssuerKey(ISSUER, 1, issuer, EXPIRY);
        gate.registerSourceKey(SOURCE, 1, FINGERPRINT);
        gate.registerPolicy(ISSUER, 1, 1, SOURCE, 1, keccak256("old policy"));
        gate.registerRights(ISSUER, 1, address(adapter), keccak256("rights"));
        gate.setBackingCap(ISSUER, adapter.token(), 1000);
        RequestHash.Request memory r = request();
        reserve(r);
        gate.setPaused(false);
        IssuanceGate.Evidence memory e = abi.decode(evidence(r), (IssuanceGate.Evidence));
        e.profileVersion = 1;
        bytes memory values = abi.encode(e);
        verifier.configure(keccak256(values), false);
        RequestHash.Permit memory p = permit(r);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory ps = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        vm.expectRevert(IssuanceGate.InactiveRecord.selector);
        gate.issue(r, hs, p, ps, values, hex"cafe");
        assertUnused(r);
    }

    function testFuzzPendingToOutstandingAndCancellation(uint64 first, uint64 second) public {
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        uint256 a = uint256(first) % 2000 + 1;
        uint256 b = uint256(second) % 2000 + 1;
        RequestHash.Request memory r = freshRequest(20, a);
        RequestHash.Request memory other = freshRequest(40, b);
        reserve(r);
        if (a + b > 2000) {
            vm.expectRevert(IssuanceGate.CapacityExceeded.selector);
            reserve(other);
            issue(r, 0);
            assertPool(r.token, 0, a);
        } else {
            reserve(other);
            issue(r, 0);
            assertPool(r.token, b, a);
            gate.revokeReservation(ISSUER, 1, other.reservationId);
            assertPool(r.token, 0, a);
        }
    }
}
