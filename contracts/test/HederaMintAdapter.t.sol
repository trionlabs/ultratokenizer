// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HederaMintAdapter} from "../src/HederaMintAdapter.sol";
import {IHts} from "../src/interfaces/IHts.sol";
import {GateFixture} from "./IssuanceGate.t.sol";
import {RequestHash} from "../src/RequestHash.sol";

/// Local EVM test model only. These tests do not establish native Hedera behavior.
contract TestHtsToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    function mint(address treasury, uint256 amount) external {
        require(msg.sender == address(0x167));
        totalSupply += amount;
        balanceOf[treasury] += amount;
    }

    function transfer(address from, address to, uint256 amount) external {
        require(msg.sender == address(0x167));
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract TestHtsService {
    bool public failMint;
    bool public failTransfer;
    bool public shortTransfer;
    address public treasury;

    function configure(bool mint_, bool transfer_, bool short_) external {
        failMint = mint_;
        failTransfer = transfer_;
        shortTransfer = short_;
    }

    function createFungibleToken(IHts.HederaToken calldata definition, int64 initialSupply, int32 decimals)
        external
        payable
        returns (int64, address)
    {
        require(initialSupply == 0 && decimals == 3, "unexpected supply or units");
        require(definition.treasury == msg.sender && definition.tokenKeys.length == 1, "alternate authority");
        IHts.TokenKey memory supply = definition.tokenKeys[0];
        require(
            supply.keyType == 16 && supply.key.contractId == msg.sender && !supply.key.inheritAccountKey
                && supply.key.delegatableContractId == address(0) && supply.key.ed25519.length == 0
                && supply.key.ECDSA_secp256k1.length == 0,
            "unsafe supply key"
        );
        treasury = msg.sender;
        return (22, address(new TestHtsToken()));
    }

    function mintToken(address token, int64 amount, bytes[] calldata) external returns (int64, int64, int64[] memory) {
        require(msg.sender == treasury, "wrong authority");
        if (failMint) return (7, 0, new int64[](0));
        require(amount > 0, "positive test amount");
        // Positive int64 widens without loss.
        // forge-lint: disable-next-line(unsafe-typecast)
        TestHtsToken(token).mint(treasury, uint256(uint64(amount)));
        uint256 supply = TestHtsToken(token).totalSupply();
        require(supply <= uint256(uint64(type(int64).max)), "test HTS supply bound");
        // Guard above bounds the synthetic supply to positive int64.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (22, int64(uint64(supply)), new int64[](0));
    }

    function transferToken(address token, address from, address to, int64 amount) external returns (int64) {
        require(msg.sender == treasury && from == treasury, "wrong sender");
        require(amount > 0, "positive test amount");
        // Positive int64 widens without loss.
        // forge-lint: disable-next-line(unsafe-typecast)
        TestHtsToken(token).transfer(from, to, uint256(uint64(amount)) - (shortTransfer ? 1 : 0));
        return failTransfer ? int64(7) : int64(22);
    }
}

contract HederaMintAdapterTest is GateFixture {
    function actual() internal returns (HederaMintAdapter real, TestHtsToken asset, RequestHash.Request memory r) {
        TestHtsService implementation = new TestHtsService();
        vm.etch(address(0x167), address(implementation).code);
        real = new HederaMintAdapter(address(gate), address(this));
        address token = real.initializeToken("Test gold", "TGOLD", IHts.Expiry(2000000000, address(0), 0));
        asset = TestHtsToken(token);
        gate.registerRights(ISSUER, 2, address(real), keccak256("mg rights"));
        vm.prank(issuer);
        gate.openReservation(ISSUER, 1, bytes32(uint256(50)), holder, token, 2000, EXPIRY);
        r = request();
        r.token = token;
        r.rightsVersion = 2;
        r.reservationId = bytes32(uint256(50));
    }

    function testHtsCreatesSoleSupplyAuthorityAndMintsExactUnits() public {
        (HederaMintAdapter real, TestHtsToken asset, RequestHash.Request memory r) = actual();
        issue(r, 0);
        require(
            asset.totalSupply() == 1000 && asset.balanceOf(holder) == 1000 && asset.balanceOf(address(real)) == 0,
            "wrong HTS deltas"
        );
        vm.expectRevert(HederaMintAdapter.AlreadyInitialized.selector);
        real.initializeToken("Again", "NO", IHts.Expiry(2000000000, address(0), 0));
        vm.expectRevert(HederaMintAdapter.Unauthorized.selector);
        real.mint(holder, 1);
    }

    function testHtsMintFailureRollsBackGate() public {
        (, TestHtsToken asset, RequestHash.Request memory r) = actual();
        TestHtsService(address(0x167)).configure(true, false, false);
        issue(r, HederaMintAdapter.HtsFailure.selector);
        require(
            asset.totalSupply() == 0 && !gate.usedRequests(RequestHash.digest(r)) && !gate.usedClaims(r.claimUsageId),
            "mint rollback failed"
        );
    }

    function testHtsTransferFailureRollsBackSupplyAndEveryGateMarker() public {
        (, TestHtsToken asset, RequestHash.Request memory r) = actual();
        TestHtsService(address(0x167)).configure(false, true, false);
        issue(r, HederaMintAdapter.HtsFailure.selector);
        (,,, uint256 used,,) = gate.reservations(ISSUER, r.reservationId);
        require(
            asset.totalSupply() == 0 && asset.balanceOf(holder) == 0 && used == 0,
            "token or reservation rollback failed"
        );
        require(
            !gate.usedRequests(RequestHash.digest(r)) && !gate.usedClaims(r.claimUsageId)
                && !gate.usedRequestIds(r.requestId) && !gate.usedHolderNonces(holder, 0)
                && !gate.usedPermitNonces(ISSUER, 1, 0),
            "replay marker rollback failed"
        );
        TestHtsService(address(0x167)).configure(false, false, false);
        issue(r, 0);
    }

    function testHtsShortTransferFailsEvenWhenResponseIsSuccess() public {
        (, TestHtsToken asset, RequestHash.Request memory r) = actual();
        TestHtsService(address(0x167)).configure(false, false, true);
        issue(r, HederaMintAdapter.InexactMint.selector);
        require(asset.totalSupply() == 0, "short transfer mint persisted");
    }

    function testHtsInt64LimitAndUninitializedAdapter() public {
        RequestHash.Request memory r = request();
        r.amount = uint256(uint64(type(int64).max)) + 1;
        issue(r, bytes4(keccak256("InvalidRequest()")));
        HederaMintAdapter real = new HederaMintAdapter(address(gate), address(this));
        vm.prank(address(gate));
        vm.expectRevert(HederaMintAdapter.InvalidConfiguration.selector);
        real.mint(holder, 1);
        vm.expectRevert();
        gate.registerRights(ISSUER, 8, address(real), keccak256("unset token"));
    }
}
