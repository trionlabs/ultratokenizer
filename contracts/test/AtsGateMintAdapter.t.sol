// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AtsGateMintAdapter} from "../src/AtsGateMintAdapter.sol";
import {GateFixture} from "./IssuanceGate.t.sol";
import {RequestHash} from "../src/RequestHash.sol";

/// Fault injection only. This is not ATS and supplies no provisioning evidence.
contract AtsAdapterTokenModel {
    address private immutable adapter;
    uint8 public decimals = 3;
    uint8 public mode;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(address adapter_) {
        adapter = adapter_;
    }

    function configure(uint8 mode_) external {
        mode = mode_;
    }

    function mint(address recipient, uint256 amount) external {
        require(msg.sender == adapter, "only adapter");
        totalSupply += amount + (mode == 2 ? 1 : 0);
        balanceOf[recipient] += amount - (mode == 1 ? 1 : 0);
        if (mode == 3) balanceOf[adapter] += 1;
        if (mode == 4) decimals = 4;
    }
}

/// Distinct addresses with stable code, not a canonical facet/library graph.
contract AtsAdapterPinModel {
    function marker() external pure returns (uint256) {
        return 1;
    }
}

contract AtsGateMintAdapterTest is GateFixture {
    function pins() private returns (AtsGateMintAdapter.RuntimePin[] memory result) {
        result = new AtsGateMintAdapter.RuntimePin[](15);
        for (uint256 i; i < 15; ++i) {
            address target = address(new AtsAdapterPinModel());
            result[i] = AtsGateMintAdapter.RuntimePin(target, target.codehash);
        }
    }

    function actual()
        private
        returns (AtsGateMintAdapter real, AtsAdapterTokenModel asset, RequestHash.Request memory r)
    {
        real = new AtsGateMintAdapter(address(gate), address(this));
        asset = new AtsAdapterTokenModel(address(real));
        real.initializeToken(address(asset), pins());
        gate.registerRights(ISSUER, 2, address(real), keccak256("ATS mg rights"));
        r = request();
        r.token = address(asset);
        r.rightsVersion = 2;
        r.reservationId = bytes32(uint256(51));
        gate.setBackingCap(ISSUER, address(asset), 2000);
        reserve(r);
    }

    function testAtsAdapterUsesActualGateAndCannotBeCalledByAnotherIssuer() public {
        (AtsGateMintAdapter real, AtsAdapterTokenModel asset, RequestHash.Request memory r) = actual();
        vm.expectRevert(AtsGateMintAdapter.Unauthorized.selector);
        real.mint(holder, 1000);
        issue(r, 0);
        require(asset.totalSupply() == 1000 && asset.balanceOf(holder) == 1000, "inexact mint");
        assertPool(address(asset), 0, 1000);
    }

    function testAtsMintDeltaFaultsRollBackSupplyAndEveryGateMarker() public {
        (, AtsAdapterTokenModel asset, RequestHash.Request memory r) = actual();
        for (uint8 mode = 1; mode <= 4; ++mode) {
            asset.configure(mode);
            issue(r, AtsGateMintAdapter.InexactMint.selector);
            (,,, uint256 used,,,,,) = gate.reservations(ISSUER, r.reservationId);
            require(
                asset.totalSupply() == 0 && asset.balanceOf(holder) == 0 && asset.decimals() == 3 && used == 0,
                "token or reservation mutation survived"
            );
            require(
                !gate.usedRequests(RequestHash.digest(r)) && !gate.usedClaims(r.claimUsageId)
                    && !gate.usedRequestIds(r.requestId) && !gate.usedHolderNonces(holder, 0)
                    && !gate.usedPermitNonces(ISSUER, 1, 0),
                "consumption survived"
            );
            assertPool(address(asset), 1000, 0);
        }
        asset.configure(0);
        issue(r, 0);
    }

    function testAtsRuntimeSubstitutionRejectsBeforeMintAndPreservesReservation() public {
        (AtsGateMintAdapter real, AtsAdapterTokenModel asset, RequestHash.Request memory r) = actual();
        AtsGateMintAdapter.RuntimePin[] memory enrolled = real.getRuntimePins();
        vm.etch(enrolled[10].target, hex"60006000f3");
        issue(r, AtsGateMintAdapter.RuntimeMismatch.selector);
        require(asset.totalSupply() == 0 && !gate.usedClaims(r.claimUsageId), "substitution minted");
        assertPool(address(asset), 1000, 0);
    }

    function testAtsInitializationRejectsWrongDuplicateOrMissingPins() public {
        AtsGateMintAdapter real = new AtsGateMintAdapter(address(gate), address(this));
        AtsAdapterTokenModel asset = new AtsAdapterTokenModel(address(real));
        AtsGateMintAdapter.RuntimePin[] memory selected = pins();
        bytes32 original = selected[0].codeHash;
        selected[0].codeHash = keccak256("wrong runtime");
        vm.expectRevert(AtsGateMintAdapter.RuntimeMismatch.selector);
        real.initializeToken(address(asset), selected);
        selected[0].codeHash = original;
        selected[1] = selected[0];
        vm.expectRevert(AtsGateMintAdapter.InvalidConfiguration.selector);
        real.initializeToken(address(asset), selected);
        vm.expectRevert(AtsGateMintAdapter.InvalidConfiguration.selector);
        real.initializeToken(address(asset), new AtsGateMintAdapter.RuntimePin[](14));
        require(real.token() == address(0) && real.getRuntimePins().length == 0, "partial initialization");
    }

    function testAtsBindingIsInitializerOnlyAndCannotBeRepeated() public {
        AtsGateMintAdapter real = new AtsGateMintAdapter(address(gate), address(this));
        AtsAdapterTokenModel asset = new AtsAdapterTokenModel(address(real));
        AtsGateMintAdapter.RuntimePin[] memory selected = pins();
        vm.prank(holder);
        vm.expectRevert(AtsGateMintAdapter.Unauthorized.selector);
        real.initializeToken(address(asset), selected);
        real.initializeToken(address(asset), selected);
        vm.expectRevert(AtsGateMintAdapter.AlreadyInitialized.selector);
        real.initializeToken(address(asset), selected);
    }
}
