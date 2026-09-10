// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IssuanceGate} from "../src/IssuanceGate.sol";
import {RequestHash} from "../src/RequestHash.sol";
import {IMintAdapter} from "../src/interfaces/IMintAdapter.sol";
import {ISP1Verifier} from "../src/interfaces/ISP1Verifier.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chainId) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata reason) external;
    function expectRevert() external;
    function etch(address target, bytes calldata code) external;
}

/// Test doubles only. Never register these contracts in a production registry.
contract TestVerifier is ISP1Verifier {
    bytes32 public expectedValues;
    bool public reject;

    function configure(bytes32 hash, bool reject_) external {
        expectedValues = hash;
        reject = reject_;
    }

    function verifyProof(bytes32 key, bytes calldata values, bytes calldata proof) external view {
        require(
            !reject && key == bytes32(uint256(77)) && keccak256(values) == expectedValues
                && keccak256(proof) == keccak256(hex"cafe"),
            "invalid test proof"
        );
    }
}

contract TestAdapter is IMintAdapter {
    address public immutable gate;
    address public constant token = address(0xCAFE);
    mapping(address => uint256) public balances;
    bool public fail;
    bytes public reentry;

    constructor(address gate_) {
        gate = gate_;
    }

    function configure(bool fail_, bytes calldata reentry_) external {
        fail = fail_;
        reentry = reentry_;
    }

    function mint(address recipient, uint256 amount) external {
        require(msg.sender == gate, "only gate");
        balances[recipient] += amount;
        if (reentry.length != 0) {
            (bool ok,) = gate.call(reentry);
            require(!ok, "reentry succeeded");
        }
        require(!fail, "test mint failure");
    }
}

contract Test1271Wallet {
    bytes32 public accepted;

    function setAccepted(bytes32 digest) external {
        accepted = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == accepted ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

abstract contract GateFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant HOLDER_KEY = 101;
    uint256 internal constant ISSUER_KEY = 202;
    bytes32 internal constant ISSUER = bytes32(uint256(1));
    bytes32 internal constant SOURCE = bytes32(uint256(2));
    bytes32 internal constant FINGERPRINT = bytes32(uint256(3));
    bytes32 internal constant RESERVATION = bytes32(uint256(4));
    uint64 internal constant EXPIRY = 2000000000;
    IssuanceGate internal gate;
    TestVerifier internal verifier;
    TestAdapter internal adapter;
    address internal holder;
    address internal issuer;

    function setUp() public {
        vm.warp(1900000000);
        vm.chainId(296);
        holder = vm.addr(HOLDER_KEY);
        issuer = vm.addr(ISSUER_KEY);
        gate = new IssuanceGate(address(this));
        verifier = new TestVerifier();
        adapter = new TestAdapter(address(gate));
        gate.registerIssuerKey(ISSUER, 1, issuer, EXPIRY);
        gate.registerProgram(1, address(verifier), address(verifier).codehash, bytes32(uint256(77)), 2);
        gate.registerSourceKey(SOURCE, 1, FINGERPRINT);
        gate.registerPolicy(ISSUER, 1, 1, SOURCE, 1, keccak256("policy terms"));
        gate.registerRights(ISSUER, 1, address(adapter), keccak256("rights terms"));
        gate.setBackingCap(ISSUER, address(0xCAFE), 2000);
        reserve(request());
        gate.setPaused(false);
    }

    function request() internal view returns (RequestHash.Request memory r) {
        r = RequestHash.Request(
            1,
            "ISSUE",
            bytes32(uint256(5)),
            296,
            address(gate),
            adapter.token(),
            holder,
            1000,
            "XAU_MILLIGRAM",
            ISSUER,
            RESERVATION,
            bytes32(uint256(6)),
            bytes32(uint256(7)),
            1,
            1,
            0,
            EXPIRY
        );
    }

    function permit(RequestHash.Request memory r) internal pure returns (RequestHash.Permit memory) {
        return RequestHash.Permit(RequestHash.digest(r), r.issuerId, 1, r.nonce, r.validUntil);
    }

    function reserve(RequestHash.Request memory r) internal {
        vm.prank(issuer);
        gate.openReservation(
            r.issuerId,
            1,
            r.reservationId,
            r.recipient,
            r.token,
            r.amount,
            r.validUntil,
            RequestHash.digest(r),
            r.claimUsageId
        );
    }

    function assertPool(address token, uint256 pending, uint256 outstanding) internal view {
        (uint256 cap, uint256 actualPending, uint256 actualOutstanding) = gate.backingPools(ISSUER, token);
        require(actualPending == pending && actualOutstanding == outstanding, "wrong pool accounting");
        require(actualPending + actualOutstanding <= cap, "pool exposure exceeds cap");
    }

    function evidence(RequestHash.Request memory r) internal pure returns (bytes memory) {
        return abi.encode(
            IssuanceGate.Evidence(
                2, RequestHash.digest(r), FINGERPRINT, SOURCE, r.claimUsageId, r.claimCommitment, EXPIRY
            )
        );
    }

    function signature(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(key, digest);
        return abi.encodePacked(rr, ss, v);
    }

    function issue(RequestHash.Request memory r, bytes4 expected) internal {
        RequestHash.Permit memory p = permit(r);
        bytes memory values = evidence(r);
        verifier.configure(keccak256(values), false);
        bytes memory hsig = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory isig = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        if (expected == bytes4(keccak256("HtsFailure(int64)"))) {
            vm.expectRevert(abi.encodeWithSelector(expected, int64(7)));
        } else if (expected != bytes4(0)) {
            vm.expectRevert(expected);
        }
        gate.issue(r, hsig, p, isig, values, hex"cafe");
    }

    function assertUnused(RequestHash.Request memory r) internal view {
        require(!gate.usedRequests(RequestHash.digest(r)) && !gate.usedClaims(r.claimUsageId), "consumed on failure");
        require(
            !gate.usedHolderNonces(r.recipient, r.nonce) && !gate.usedPermitNonces(ISSUER, 1, r.nonce),
            "nonce consumed on failure"
        );
        (,,, uint256 used,,,,,) = gate.reservations(ISSUER, RESERVATION);
        require(used == 0 && adapter.balances(holder) == 0, "balance or reservation changed");
        assertPool(adapter.token(), 1000, 0);
    }
}

contract IssuanceGateTest is GateFixture {
    function testValidIssueConsumesAllIdentifiersAndCapacity() public {
        RequestHash.Request memory r = request();
        issue(r, 0);
        require(
            gate.usedRequests(RequestHash.digest(r)) && gate.usedRequestIds(r.requestId)
                && gate.usedClaims(r.claimUsageId),
            "missing replay consumption"
        );
        require(gate.usedHolderNonces(holder, 0) && gate.usedPermitNonces(ISSUER, 1, 0), "missing nonce consumption");
        (,,, uint256 used,,,,,) = gate.reservations(ISSUER, RESERVATION);
        require(used == 1000 && adapter.balances(holder) == 1000, "wrong mint");
        assertPool(adapter.token(), 0, 1000);
    }

    function testRequestAndClaimCannotBeReplayedWithNewReservationOrNonce() public {
        RequestHash.Request memory r = request();
        issue(r, 0);
        issue(r, IssuanceGate.Replay.selector);
        r.requestId = bytes32(uint256(88));
        r.nonce = 1;
        issue(r, IssuanceGate.Replay.selector);
        r.claimUsageId = bytes32(uint256(99));
        issue(r, IssuanceGate.Replay.selector);
        r.reservationId = bytes32(uint256(100));
        reserve(r);
        issue(r, 0);
        (,,, uint256 used,,,,,) = gate.reservations(ISSUER, RESERVATION);
        require(used == 1000, "original reservation was reused");
        assertPool(adapter.token(), 0, 2000);
    }

    function testReservationRejectsBothPartialAndGreaterAmounts() public {
        RequestHash.Request memory r = request();
        r.amount = 999;
        issue(r, IssuanceGate.ReservationMismatch.selector);
        r.amount = 1001;
        issue(r, IssuanceGate.ReservationMismatch.selector);
        assertUnused(r);
    }

    function testMintRevertRollsBackEveryConsumption() public {
        adapter.configure(true, hex"");
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        bytes memory values = evidence(r);
        verifier.configure(keccak256(values), false);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory ps = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        vm.expectRevert();
        gate.issue(r, hs, p, ps, values, hex"cafe");
        assertUnused(r);
        adapter.configure(false, hex"");
        issue(r, 0);
    }

    function testReentrantAdapterCannotIssueAgain() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        adapter.configure(false, abi.encodeCall(gate.issue, (r, hex"", p, hex"", evidence(r), hex"cafe")));
        issue(r, 0);
        require(adapter.balances(holder) == 1000, "double mint");
    }

    function testPauseAndUnsetPolicyFailClosed() public {
        RequestHash.Request memory r = request();
        gate.setPaused(true);
        issue(r, IssuanceGate.Paused.selector);
        gate.setPaused(false);
        r.policyVersion = 9;
        issue(r, IssuanceGate.InactiveRecord.selector);
        assertUnused(r);
    }

    function testIssuerRevocationInvalidatesPreviouslySignedPermit() public {
        gate.revokeIssuerKey(ISSUER, 1);
        issue(request(), IssuanceGate.InactiveRecord.selector);
    }

    function testSourceRevocationFailsClosed() public {
        gate.revokeSourceKey(SOURCE, 1);
        issue(request(), IssuanceGate.InactiveRecord.selector);
    }

    function testProgramRevocationFailsClosed() public {
        gate.revokeProgram(1);
        issue(request(), IssuanceGate.InactiveRecord.selector);
    }

    function testPolicyRevocationFailsClosed() public {
        gate.revokePolicy(ISSUER, 1);
        issue(request(), IssuanceGate.InactiveRecord.selector);
    }

    function testRightsRevocationFailsClosed() public {
        gate.revokeRights(ISSUER, 1);
        issue(request(), IssuanceGate.InactiveRecord.selector);
    }

    function testReservationRevocationFailsClosed() public {
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        issue(request(), IssuanceGate.InactiveRecord.selector);
    }

    function testExpiryIsExclusive() public {
        vm.warp(EXPIRY);
        issue(request(), IssuanceGate.Expired.selector);
    }

    function testDifferentChainAndGateFail() public {
        RequestHash.Request memory r = request();
        r.chainId = 295;
        issue(r, IssuanceGate.InvalidRequest.selector);
        r = request();
        r.gate = address(9);
        issue(r, IssuanceGate.InvalidRequest.selector);
    }

    function testWrongHolderOrIssuerSignatureFails() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        bytes memory values = evidence(r);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory ps = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        vm.expectRevert(IssuanceGate.InvalidSignature.selector);
        gate.issue(r, ps, p, ps, values, hex"cafe");
        vm.expectRevert(IssuanceGate.InvalidSignature.selector);
        gate.issue(r, hs, p, hs, values, hex"cafe");
        assertUnused(r);
    }

    function testPermitBindingExpiryAndNonceReplay() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        p.requestDigest = bytes32(uint256(123));
        vm.expectRevert(IssuanceGate.InvalidPermit.selector);
        gate.issue(r, hs, p, hex"", evidence(r), hex"cafe");
        p = permit(r);
        p.validUntil = EXPIRY + 1;
        vm.expectRevert(IssuanceGate.InvalidPermit.selector);
        gate.issue(r, hs, p, hex"", evidence(r), hex"cafe");
        issue(r, 0);
        r.requestId = bytes32(uint256(10));
        r.claimUsageId = bytes32(uint256(11));
        r.nonce = 1;
        p = permit(r);
        p.nonce = 0;
        hs = signature(HOLDER_KEY, RequestHash.digest(r));
        vm.expectRevert(IssuanceGate.Replay.selector);
        gate.issue(r, hs, p, hex"", evidence(r), hex"cafe");
    }

    function testMalformedAndMismatchedEvidenceFails() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory ps = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        vm.expectRevert(IssuanceGate.InvalidEvidence.selector);
        gate.issue(r, hs, p, ps, abi.encode(uint32(1), FINGERPRINT, bytes32(0)), hex"cafe");
        IssuanceGate.Evidence memory e = abi.decode(evidence(r), (IssuanceGate.Evidence));
        e.sourceId = bytes32(uint256(9));
        vm.expectRevert(IssuanceGate.InvalidEvidence.selector);
        gate.issue(r, hs, p, ps, abi.encode(e), hex"cafe");
        e = abi.decode(evidence(r), (IssuanceGate.Evidence));
        e.claimValidUntil = EXPIRY - 1;
        vm.expectRevert(IssuanceGate.Expired.selector);
        gate.issue(r, hs, p, ps, abi.encode(e), hex"cafe");
        assertUnused(r);
    }

    function testVerifierRejectionAndCodeChangeFailClosed() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        bytes memory values = evidence(r);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory ps = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        verifier.configure(keccak256(values), true);
        vm.expectRevert();
        gate.issue(r, hs, p, ps, values, hex"cafe");
        assertUnused(r);
        vm.etch(address(verifier), hex"00");
        vm.expectRevert(IssuanceGate.InactiveRecord.selector);
        gate.issue(r, hs, p, ps, values, hex"cafe");
    }

    function testRecordsCannotBeOverwrittenOrReactivated() public {
        gate.revokeIssuerKey(ISSUER, 1);
        vm.expectRevert(IssuanceGate.AlreadyRegistered.selector);
        gate.registerIssuerKey(ISSUER, 1, issuer, EXPIRY);
        vm.expectRevert(IssuanceGate.AlreadyRegistered.selector);
        gate.registerProgram(1, address(verifier), address(verifier).codehash, bytes32(uint256(77)), 2);
        vm.expectRevert(IssuanceGate.AlreadyRegistered.selector);
        gate.registerSourceKey(SOURCE, 1, FINGERPRINT);
        vm.expectRevert(IssuanceGate.AlreadyRegistered.selector);
        gate.registerPolicy(ISSUER, 1, 1, SOURCE, 1, bytes32(uint256(9)));
        vm.expectRevert(IssuanceGate.AlreadyRegistered.selector);
        gate.registerRights(ISSUER, 1, address(adapter), bytes32(uint256(9)));
    }

    function testUnauthorizedRegistryAndMintCallsFail() public {
        vm.prank(holder);
        vm.expectRevert(IssuanceGate.Unauthorized.selector);
        gate.setPaused(true);
        vm.prank(holder);
        vm.expectRevert(IssuanceGate.Unauthorized.selector);
        gate.openReservation(
            ISSUER,
            1,
            bytes32(uint256(99)),
            holder,
            address(0xCAFE),
            1000,
            EXPIRY,
            bytes32(uint256(8)),
            bytes32(uint256(9))
        );
        vm.expectRevert();
        adapter.mint(holder, 1000);
    }

    function testFuzzExactCapacity(uint64 amount) public {
        RequestHash.Request memory r = request();
        r.amount = uint256(amount) % 2000 + 1;
        gate.revokeReservation(ISSUER, 1, RESERVATION);
        r.reservationId = bytes32(uint256(55));
        reserve(r);
        issue(r, 0);
        require(adapter.balances(holder) == r.amount, "inexact amount");
        assertPool(adapter.token(), 0, r.amount);
    }

    function testContractHolderUsesLiveERC1271Authorization() public {
        Test1271Wallet wallet = new Test1271Wallet();
        RequestHash.Request memory r = request();
        r.recipient = address(wallet);
        r.reservationId = bytes32(uint256(55));
        reserve(r);
        wallet.setAccepted(RequestHash.digest(r));
        issue(r, 0);
        require(adapter.balances(address(wallet)) == 1000, "wallet mint failed");
        r.requestId = bytes32(uint256(88));
        r.claimUsageId = bytes32(uint256(99));
        r.nonce = 1;
        issue(r, IssuanceGate.InvalidSignature.selector);
    }

    function testContractIssuerUsesLiveERC1271Authorization() public {
        Test1271Wallet wallet = new Test1271Wallet();
        gate.registerIssuerKey(ISSUER, 2, address(wallet), EXPIRY);
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        p.keyVersion = 2;
        bytes memory values = evidence(r);
        verifier.configure(keccak256(values), false);
        wallet.setAccepted(RequestHash.permitDigest(p, r.chainId, r.gate));
        gate.issue(r, signature(HOLDER_KEY, RequestHash.digest(r)), p, hex"", values, hex"cafe");
        require(gate.usedPermitNonces(ISSUER, 2, 0), "wallet permit not consumed");
    }

    function testHighSSignatureIsRejected() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(HOLDER_KEY, RequestHash.digest(r));
        uint256 highS = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(ss);
        bytes memory malleable = abi.encodePacked(rr, bytes32(highS), uint8(v == 27 ? 28 : 27));
        vm.expectRevert(IssuanceGate.InvalidSignature.selector);
        gate.issue(r, malleable, p, hex"", evidence(r), hex"cafe");
    }

    function testPermitExpiryAndKeyExpiryAreLive() public {
        RequestHash.Request memory r = request();
        RequestHash.Permit memory p = permit(r);
        p.validUntil = uint64(block.timestamp);
        bytes memory hs = signature(HOLDER_KEY, RequestHash.digest(r));
        vm.expectRevert(IssuanceGate.Expired.selector);
        gate.issue(r, hs, p, hex"", evidence(r), hex"cafe");
        gate.registerIssuerKey(ISSUER, 2, issuer, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 1);
        p = permit(r);
        p.keyVersion = 2;
        vm.expectRevert(IssuanceGate.Expired.selector);
        gate.issue(r, hs, p, hex"", evidence(r), hex"cafe");
    }

    function testPinnedTypeScriptPermitDigest() public pure {
        RequestHash.Permit memory p = RequestHash.Permit(
            0x996df02433637893ae8b8ef23e2d694dfda258a551b6251339e451179424a237,
            0x2222222222222222222222222222222222222222222222222222222222222222,
            1,
            0,
            2000000000
        );
        require(
            RequestHash.permitDigest(p, 296, address(0x1111111111111111111111111111111111111111))
                == 0x2f1079d780a94b10e20a88bb4e9131678e3d778fa7c2e1cbfc2f660567f69100,
            "TS permit mismatch"
        );
    }

    function testPinnedTypeScriptFixtureDigest() public pure {
        RequestHash.Request memory r = RequestHash.Request(
            1,
            "ISSUE",
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            296,
            address(0x1111111111111111111111111111111111111111),
            address(0x2222222222222222222222222222222222222222),
            address(0x3333333333333333333333333333333333333333),
            1000,
            "XAU_MILLIGRAM",
            bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)),
            bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333)),
            bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444)),
            bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555)),
            1,
            1,
            0,
            2000000000
        );
        require(
            RequestHash.digest(r) == 0x996df02433637893ae8b8ef23e2d694dfda258a551b6251339e451179424a237,
            "TS request mismatch"
        );
    }
}
