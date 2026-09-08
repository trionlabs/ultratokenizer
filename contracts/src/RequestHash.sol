// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library RequestHash {
    struct Request {
        uint8 schemaVersion;
        string action;
        bytes32 requestId;
        uint256 chainId;
        address gate;
        address token;
        address recipient;
        uint256 amount;
        string unit;
        bytes32 issuerId;
        bytes32 reservationId;
        bytes32 claimCommitment;
        bytes32 claimUsageId;
        uint64 policyVersion;
        uint64 rightsVersion;
        uint256 nonce;
        uint64 validUntil;
    }

    struct Permit {
        bytes32 requestDigest;
        bytes32 issuerId;
        uint64 keyVersion;
        uint256 nonce;
        uint64 validUntil;
    }

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant REQUEST_TYPEHASH = keccak256(
        "IssuanceRequest(uint8 schemaVersion,string action,bytes32 requestId,address token,address recipient,uint256 amount,string unit,bytes32 issuerId,bytes32 reservationId,bytes32 claimCommitment,bytes32 claimUsageId,uint64 policyVersion,uint64 rightsVersion,uint256 nonce,uint64 validUntil)"
    );
    bytes32 internal constant PERMIT_TYPEHASH = keccak256(
        "IssuerPermit(bytes32 requestDigest,bytes32 issuerId,uint64 keyVersion,uint256 nonce,uint64 validUntil)"
    );

    function domain(uint256 chainId, address gate) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ultratokenizer"), keccak256("1"), chainId, gate));
    }

    function digest(Request memory r) internal pure returns (bytes32) {
        bytes32 body = keccak256(
            abi.encode(
                REQUEST_TYPEHASH,
                r.schemaVersion,
                keccak256(bytes(r.action)),
                r.requestId,
                r.token,
                r.recipient,
                r.amount,
                keccak256(bytes(r.unit)),
                r.issuerId,
                r.reservationId,
                r.claimCommitment,
                r.claimUsageId,
                r.policyVersion,
                r.rightsVersion,
                r.nonce,
                r.validUntil
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain(r.chainId, r.gate), body));
    }

    function permitDigest(Permit memory p, uint256 chainId, address gate) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"1901",
                domain(chainId, gate),
                keccak256(abi.encode(PERMIT_TYPEHASH, p.requestDigest, p.issuerId, p.keyVersion, p.nonce, p.validUntil))
            )
        );
    }
}
