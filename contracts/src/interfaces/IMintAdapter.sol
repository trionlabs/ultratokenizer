// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IMintAdapter {
    function gate() external view returns (address);
    function token() external view returns (address);
    /// One base unit equals one milligram. Must revert unless the exact amount reaches recipient.
    function mint(address recipient, uint256 milligrams) external;
}
