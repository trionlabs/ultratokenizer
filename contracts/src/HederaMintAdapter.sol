// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMintAdapter} from "./interfaces/IMintAdapter.sol";
import {IHts, IHtsFungible} from "./interfaces/IHts.sol";

/// Sole supply authority for a newly created, zero-initial-supply HTS token.
/// Fixed unit: decimals=3, one displayed token=one gram, one base unit=one milligram.
contract HederaMintAdapter is IMintAdapter {
    IHts private constant HTS = IHts(address(0x167));
    int64 private constant SUCCESS = 22;
    address public immutable gate;
    address public immutable initializer;
    address public token;
    bool private initializing;

    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyInitialized();
    error HtsFailure(int64 responseCode);
    error AmountOutOfRange();
    error InexactMint();
    event TokenInitialized(address indexed token, address indexed gate, uint8 decimals);

    constructor(address gate_, address initializer_) {
        if (gate_.code.length == 0 || initializer_ == address(0)) revert InvalidConfiguration();
        gate = gate_;
        initializer = initializer_;
    }

    /// One-time provisioning only. No existing token, admin key, external supply key or initial supply accepted.
    /// Caller funds this transaction explicitly when deploying; this repository never submits it automatically.
    function initializeToken(string calldata name, string calldata symbol, IHts.Expiry calldata expiry)
        external
        payable
        returns (address)
    {
        if (msg.sender != initializer) revert Unauthorized();
        if (token != address(0) || initializing) revert AlreadyInitialized();
        if (
            bytes(name).length == 0 || bytes(symbol).length == 0 || bytes(name).length > 100
                || bytes(symbol).length > 100
        ) revert InvalidConfiguration();
        initializing = true;
        IHts.TokenKey[] memory keys = new IHts.TokenKey[](1);
        keys[0] = IHts.TokenKey(16, IHts.KeyValue(false, address(this), new bytes(0), new bytes(0), address(0)));
        IHts.HederaToken memory definition = IHts.HederaToken(
            name, symbol, address(this), "Ultratokenizer; base unit = 1 mg", false, 0, false, keys, expiry
        );
        (int64 code, address created) = HTS.createFungibleToken{value: msg.value}(definition, 0, 3);
        if (code != SUCCESS) revert HtsFailure(code);
        if (created == address(0) || IHtsFungible(created).totalSupply() != 0) revert InvalidConfiguration();
        token = created;
        initializing = false;
        emit TokenInitialized(created, gate, 3);
        return created;
    }

    function mint(address recipient, uint256 milligrams) external {
        if (msg.sender != gate) revert Unauthorized();
        if (token == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidConfiguration();
        }
        if (milligrams == 0 || milligrams > uint256(uint64(type(int64).max))) revert AmountOutOfRange();
        IHtsFungible asset = IHtsFungible(token);
        uint256 oldSupply = asset.totalSupply();
        uint256 oldBalance = asset.balanceOf(recipient);
        uint256 oldTreasury = asset.balanceOf(address(this));
        // The positive milligram amount was bounded by int64.max above.
        // forge-lint: disable-next-line(unsafe-typecast)
        int64 amount = int64(uint64(milligrams));
        (int64 minted, int64 newSupply,) = HTS.mintToken(token, amount, new bytes[](0));
        if (minted != SUCCESS) revert HtsFailure(minted);
        if (newSupply < 0) revert InexactMint();
        // newSupply is nonnegative; widening its uint64 representation preserves its value.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint256(uint64(newSupply)) != oldSupply + milligrams) revert InexactMint();
        int64 transferred = HTS.transferToken(token, address(this), recipient, amount);
        if (transferred != SUCCESS) revert HtsFailure(transferred);
        if (
            asset.totalSupply() != oldSupply + milligrams || asset.balanceOf(recipient) != oldBalance + milligrams
                || asset.balanceOf(address(this)) != oldTreasury
        ) revert InexactMint();
    }
}
