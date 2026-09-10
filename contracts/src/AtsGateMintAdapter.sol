// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMintAdapter} from "./interfaces/IMintAdapter.sol";

interface IAtsFungible {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function mint(address recipient, uint256 amount) external;
}

/// ATS mint adapter. Reviewed provisioning must separately admit the selected
/// token graph, roles, initialization and code identities. Runtime pins only
/// enforce continuity of that admitted code. One base unit is exactly one mg.
contract AtsGateMintAdapter is IMintAdapter {
    struct RuntimePin {
        address target;
        bytes32 codeHash;
    }

    address public immutable override gate;
    address public immutable initializer;
    address public override token;
    bytes32 public tokenCodeHash;
    RuntimePin[] private runtimePins;

    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyInitialized();
    error RuntimeMismatch();
    error AmountOutOfRange();
    error InexactMint();

    event TokenInitialized(address indexed token, address indexed gate, bytes32 runtimePinsHash);

    constructor(address gate_, address initializer_) {
        if (gate_.code.length == 0 || initializer_ == address(0)) revert InvalidConfiguration();
        gate = gate_;
        initializer = initializer_;
    }

    /// Constructor-only provisioner supplies ten facet, four linked-library and
    /// one direct-resolver pins. Artifact review is an external provisioning duty.
    function initializeToken(address token_, RuntimePin[] calldata pins) external {
        if (msg.sender != initializer) revert Unauthorized();
        if (token != address(0)) revert AlreadyInitialized();
        if (token_.code.length == 0 || pins.length != 15) revert InvalidConfiguration();
        IAtsFungible asset = IAtsFungible(token_);
        if (asset.decimals() != 3 || asset.totalSupply() != 0) revert InvalidConfiguration();
        for (uint256 i; i < pins.length; ++i) {
            RuntimePin calldata pin = pins[i];
            if (pin.target.code.length == 0 || pin.codeHash == 0 || pin.target.codehash != pin.codeHash) {
                revert RuntimeMismatch();
            }
            for (uint256 j; j < i; ++j) {
                if (pins[j].target == pin.target) revert InvalidConfiguration();
            }
            runtimePins.push(pin);
        }
        token = token_;
        tokenCodeHash = token_.codehash;
        emit TokenInitialized(token_, gate, keccak256(abi.encode(pins)));
    }

    function getRuntimePins() external view returns (RuntimePin[] memory) {
        return runtimePins;
    }

    function mint(address recipient, uint256 milligrams) external {
        if (msg.sender != gate) revert Unauthorized();
        if (token == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidConfiguration();
        }
        if (milligrams == 0 || milligrams > uint256(uint64(type(int64).max))) revert AmountOutOfRange();
        _checkRuntime();
        IAtsFungible asset = IAtsFungible(token);
        if (asset.decimals() != 3) revert InvalidConfiguration();
        uint256 supplyBefore = asset.totalSupply();
        uint256 recipientBefore = asset.balanceOf(recipient);
        uint256 adapterBefore = asset.balanceOf(address(this));
        asset.mint(recipient, milligrams);
        if (
            asset.totalSupply() != supplyBefore + milligrams
                || asset.balanceOf(recipient) != recipientBefore + milligrams
                || asset.balanceOf(address(this)) != adapterBefore || asset.decimals() != 3
        ) revert InexactMint();
        _checkRuntime();
    }

    function _checkRuntime() private view {
        if (token.codehash != tokenCodeHash) revert RuntimeMismatch();
        for (uint256 i; i < runtimePins.length; ++i) {
            RuntimePin storage pin = runtimePins[i];
            if (pin.target.codehash != pin.codeHash) revert RuntimeMismatch();
        }
    }
}
