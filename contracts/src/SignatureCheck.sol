// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library SignatureCheck {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function valid(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
            return ok && result.length == 32 && abi.decode(result, (bytes4)) == ERC1271_MAGIC;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) return false;
        return ecrecover(digest, v, r, s) == signer;
    }
}
