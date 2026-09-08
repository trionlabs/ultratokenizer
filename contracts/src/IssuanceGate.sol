// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RequestHash} from "./RequestHash.sol";
import {SignatureCheck} from "./SignatureCheck.sol";
import {ISP1Verifier} from "./interfaces/ISP1Verifier.sol";
import {IMintAdapter} from "./interfaces/IMintAdapter.sol";

/// Non-upgradeable issuance gate. Registry entries are append-only; revocation is permanent.
contract IssuanceGate {
    struct IssuerKey {
        address signer;
        uint64 validUntil;
        bool revoked;
    }

    struct Program {
        address verifier;
        bytes32 codeHash;
        bytes32 vkey;
        uint32 profile;
        bool revoked;
    }

    struct SourceKey {
        bytes32 fingerprint;
        bool revoked;
    }

    struct Policy {
        uint64 programVersion;
        bytes32 sourceId;
        uint64 sourceKeyVersion;
        bytes32 termsHash;
        bool revoked;
    }

    struct Rights {
        address token;
        address adapter;
        bytes32 adapterCodeHash;
        bytes32 termsHash;
        bool revoked;
    }

    struct Reservation {
        address recipient;
        address token;
        uint256 capacity;
        uint256 used;
        uint64 validUntil;
        bool revoked;
    }

    struct Evidence {
        uint32 profileVersion;
        bytes32 requestDigest;
        bytes32 signerFingerprint;
        bytes32 sourceId;
        bytes32 claimUsageId;
        bytes32 claimCommitment;
        uint64 claimValidUntil;
    }

    address public immutable governor;
    bool public paused = true;
    bool private entered;
    mapping(bytes32 => mapping(uint64 => IssuerKey)) public issuerKeys;
    mapping(uint64 => Program) public programs;
    mapping(bytes32 => mapping(uint64 => SourceKey)) public sourceKeys;
    mapping(bytes32 => mapping(uint64 => Policy)) public policies;
    mapping(bytes32 => mapping(uint64 => Rights)) public rights;
    mapping(bytes32 => mapping(bytes32 => Reservation)) public reservations;
    mapping(bytes32 => bool) public usedRequests;
    mapping(bytes32 => bool) public usedRequestIds;
    mapping(bytes32 => bool) public usedClaims;
    mapping(address => mapping(uint256 => bool)) public usedHolderNonces;
    mapping(bytes32 => mapping(uint64 => mapping(uint256 => bool))) public usedPermitNonces;

    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyRegistered();
    error InactiveRecord();
    error InvalidRequest();
    error InvalidSignature();
    error InvalidPermit();
    error InvalidEvidence();
    error Expired();
    error Replay();
    error CapacityExceeded();
    error Paused();
    error Reentrant();

    event PausedChanged(bool paused);
    event IssuerKeyRegistered(bytes32 indexed issuerId, uint64 indexed version, address signer, uint64 validUntil);
    event ProgramRegistered(uint64 indexed version, address verifier, bytes32 codeHash, bytes32 vkey, uint32 profile);
    event SourceKeyRegistered(bytes32 indexed sourceId, uint64 indexed version, bytes32 fingerprint);
    event PolicyRegistered(
        bytes32 indexed issuerId,
        uint64 indexed version,
        uint64 programVersion,
        bytes32 sourceId,
        uint64 sourceKeyVersion,
        bytes32 termsHash
    );
    event RightsRegistered(
        bytes32 indexed issuerId,
        uint64 indexed version,
        address token,
        address adapter,
        bytes32 adapterCodeHash,
        bytes32 termsHash
    );
    event Revoked(bytes32 indexed kind, bytes32 indexed identity, uint64 indexed version);
    event ReservationOpened(
        bytes32 indexed issuerId,
        bytes32 indexed reservationId,
        address recipient,
        address token,
        uint256 capacity,
        uint64 validUntil,
        uint64 keyVersion
    );
    event ReservationRevoked(bytes32 indexed issuerId, bytes32 indexed reservationId);
    event Issued(
        bytes32 indexed requestDigest,
        bytes32 indexed requestId,
        bytes32 indexed claimUsageId,
        bytes32 issuerId,
        bytes32 reservationId,
        address token,
        address recipient,
        uint256 milligrams,
        uint64 policyVersion,
        uint64 rightsVersion,
        bytes32 permitDigest,
        bytes32 publicValuesHash,
        bytes32 programVKey
    );

    constructor(address governor_) {
        if (governor_ == address(0)) revert InvalidConfiguration();
        governor = governor_;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function setPaused(bool value) external onlyGovernor {
        paused = value;
        emit PausedChanged(value);
    }

    function registerIssuerKey(bytes32 issuerId, uint64 version, address signer, uint64 validUntil)
        external
        onlyGovernor
    {
        if (issuerId == 0 || version == 0 || signer == address(0) || validUntil <= block.timestamp) {
            revert InvalidConfiguration();
        }
        if (issuerKeys[issuerId][version].signer != address(0)) revert AlreadyRegistered();
        issuerKeys[issuerId][version] = IssuerKey(signer, validUntil, false);
        emit IssuerKeyRegistered(issuerId, version, signer, validUntil);
    }

    function registerProgram(uint64 version, address verifier, bytes32 vkey, uint32 profile) external onlyGovernor {
        if (version == 0 || verifier.code.length == 0 || vkey == 0 || profile == 0) revert InvalidConfiguration();
        if (programs[version].verifier != address(0)) revert AlreadyRegistered();
        programs[version] = Program(verifier, verifier.codehash, vkey, profile, false);
        emit ProgramRegistered(version, verifier, verifier.codehash, vkey, profile);
    }

    function registerSourceKey(bytes32 sourceId, uint64 version, bytes32 fingerprint) external onlyGovernor {
        if (sourceId == 0 || version == 0 || fingerprint == 0) revert InvalidConfiguration();
        if (sourceKeys[sourceId][version].fingerprint != 0) revert AlreadyRegistered();
        sourceKeys[sourceId][version] = SourceKey(fingerprint, false);
        emit SourceKeyRegistered(sourceId, version, fingerprint);
    }

    function registerPolicy(
        bytes32 issuerId,
        uint64 version,
        uint64 programVersion,
        bytes32 sourceId,
        uint64 sourceKeyVersion,
        bytes32 termsHash
    ) external onlyGovernor {
        if (
            issuerId == 0 || version == 0 || termsHash == 0 || programs[programVersion].verifier == address(0)
                || sourceKeys[sourceId][sourceKeyVersion].fingerprint == 0
        ) revert InvalidConfiguration();
        if (policies[issuerId][version].programVersion != 0) revert AlreadyRegistered();
        policies[issuerId][version] = Policy(programVersion, sourceId, sourceKeyVersion, termsHash, false);
        emit PolicyRegistered(issuerId, version, programVersion, sourceId, sourceKeyVersion, termsHash);
    }

    function registerRights(bytes32 issuerId, uint64 version, address adapter, bytes32 termsHash)
        external
        onlyGovernor
    {
        if (issuerId == 0 || version == 0 || termsHash == 0 || adapter.code.length == 0) {
            revert InvalidConfiguration();
        }
        if (rights[issuerId][version].adapter != address(0)) revert AlreadyRegistered();
        address token = IMintAdapter(adapter).token();
        if (token == address(0) || IMintAdapter(adapter).gate() != address(this)) revert InvalidConfiguration();
        rights[issuerId][version] = Rights(token, adapter, adapter.codehash, termsHash, false);
        emit RightsRegistered(issuerId, version, token, adapter, adapter.codehash, termsHash);
    }

    function revokeIssuerKey(bytes32 issuerId, uint64 version) external onlyGovernor {
        if (issuerKeys[issuerId][version].signer == address(0)) revert InvalidConfiguration();
        issuerKeys[issuerId][version].revoked = true;
        emit Revoked("ISSUER_KEY", issuerId, version);
    }

    function revokeProgram(uint64 version) external onlyGovernor {
        if (programs[version].verifier == address(0)) revert InvalidConfiguration();
        programs[version].revoked = true;
        emit Revoked("PROGRAM", bytes32(0), version);
    }

    function revokeSourceKey(bytes32 sourceId, uint64 version) external onlyGovernor {
        if (sourceKeys[sourceId][version].fingerprint == 0) revert InvalidConfiguration();
        sourceKeys[sourceId][version].revoked = true;
        emit Revoked("SOURCE_KEY", sourceId, version);
    }

    function revokePolicy(bytes32 issuerId, uint64 version) external onlyGovernor {
        if (policies[issuerId][version].programVersion == 0) revert InvalidConfiguration();
        policies[issuerId][version].revoked = true;
        emit Revoked("POLICY", issuerId, version);
    }

    function revokeRights(bytes32 issuerId, uint64 version) external onlyGovernor {
        if (rights[issuerId][version].adapter == address(0)) revert InvalidConfiguration();
        rights[issuerId][version].revoked = true;
        emit Revoked("RIGHTS", issuerId, version);
    }

    /// Issuer-authorized reservation is a custody assertion, not an on-chain observation of physical gold.
    function openReservation(
        bytes32 issuerId,
        uint64 keyVersion,
        bytes32 reservationId,
        address recipient,
        address token,
        uint256 capacity,
        uint64 validUntil
    ) external {
        IssuerKey memory key = _key(issuerId, keyVersion);
        if (msg.sender != key.signer) revert Unauthorized();
        if (
            reservationId == 0 || recipient == address(0) || token == address(0) || capacity == 0
                || validUntil <= block.timestamp || validUntil > key.validUntil
        ) revert InvalidConfiguration();
        if (reservations[issuerId][reservationId].recipient != address(0)) revert AlreadyRegistered();
        reservations[issuerId][reservationId] = Reservation(recipient, token, capacity, 0, validUntil, false);
        emit ReservationOpened(issuerId, reservationId, recipient, token, capacity, validUntil, keyVersion);
    }

    function revokeReservation(bytes32 issuerId, uint64 keyVersion, bytes32 reservationId) external {
        if (msg.sender != governor && msg.sender != _key(issuerId, keyVersion).signer) revert Unauthorized();
        if (reservations[issuerId][reservationId].recipient == address(0)) revert InvalidConfiguration();
        reservations[issuerId][reservationId].revoked = true;
        emit ReservationRevoked(issuerId, reservationId);
    }

    function requestDigest(RequestHash.Request calldata request) external pure returns (bytes32) {
        return RequestHash.digest(request);
    }

    function permitDigest(RequestHash.Permit calldata permit) external view returns (bytes32) {
        return RequestHash.permitDigest(permit, block.chainid, address(this));
    }

    function issue(
        RequestHash.Request calldata request,
        bytes calldata holderSignature,
        RequestHash.Permit calldata permit,
        bytes calldata issuerSignature,
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) external nonReentrant returns (bytes32 digest) {
        if (paused) revert Paused();
        _request(request);
        digest = RequestHash.digest(request);
        if (
            usedRequests[digest] || usedRequestIds[request.requestId] || usedClaims[request.claimUsageId]
                || usedHolderNonces[request.recipient][request.nonce]
        ) revert Replay();
        if (!SignatureCheck.valid(request.recipient, digest, holderSignature)) revert InvalidSignature();
        bytes32 authorization = _permit(request, digest, permit, issuerSignature);
        Rights memory terms = rights[request.issuerId][request.rightsVersion];
        if (
            terms.adapter == address(0) || terms.revoked || terms.token != request.token
                || terms.adapter.codehash != terms.adapterCodeHash
        ) revert InactiveRecord();
        bytes32 programVKey = _evidence(request, digest, publicValues, proofBytes);
        Reservation storage reservation = reservations[request.issuerId][request.reservationId];
        if (reservation.recipient != request.recipient || reservation.token != request.token || reservation.revoked) {
            revert InactiveRecord();
        }
        if (block.timestamp >= reservation.validUntil || request.validUntil > reservation.validUntil) revert Expired();
        if (request.amount > reservation.capacity - reservation.used) revert CapacityExceeded();

        // All accounting and the external mint/transfer share one reverting EVM transaction.
        reservation.used += request.amount;
        usedRequests[digest] = true;
        usedRequestIds[request.requestId] = true;
        usedClaims[request.claimUsageId] = true;
        usedHolderNonces[request.recipient][request.nonce] = true;
        usedPermitNonces[permit.issuerId][permit.keyVersion][permit.nonce] = true;
        IMintAdapter(terms.adapter).mint(request.recipient, request.amount);
        emit Issued(
            digest,
            request.requestId,
            request.claimUsageId,
            request.issuerId,
            request.reservationId,
            request.token,
            request.recipient,
            request.amount,
            request.policyVersion,
            request.rightsVersion,
            authorization,
            keccak256(publicValues),
            programVKey
        );
    }

    function _request(RequestHash.Request calldata r) private view {
        if (
            r.schemaVersion != 1 || keccak256(bytes(r.action)) != keccak256("ISSUE")
                || keccak256(bytes(r.unit)) != keccak256("XAU_MILLIGRAM") || r.chainId != block.chainid
                || r.gate != address(this) || r.token == address(0) || r.recipient == address(0) || r.requestId == 0
                || r.issuerId == 0 || r.reservationId == 0 || r.claimCommitment == 0 || r.claimUsageId == 0
                || r.policyVersion == 0 || r.rightsVersion == 0 || r.amount == 0
                || r.amount > uint256(uint64(type(int64).max))
        ) revert InvalidRequest();
        if (block.timestamp >= r.validUntil) revert Expired();
    }

    function _key(bytes32 issuerId, uint64 version) private view returns (IssuerKey memory key) {
        key = issuerKeys[issuerId][version];
        if (key.signer == address(0) || key.revoked) revert InactiveRecord();
        if (block.timestamp >= key.validUntil) revert Expired();
    }

    function _permit(
        RequestHash.Request calldata request,
        bytes32 digest,
        RequestHash.Permit calldata permit,
        bytes calldata signature
    ) private view returns (bytes32 authorization) {
        if (
            permit.requestDigest != digest || permit.issuerId != request.issuerId
                || permit.validUntil > request.validUntil
        ) revert InvalidPermit();
        IssuerKey memory key = _key(permit.issuerId, permit.keyVersion);
        if (block.timestamp >= permit.validUntil || permit.validUntil > key.validUntil) revert Expired();
        if (usedPermitNonces[permit.issuerId][permit.keyVersion][permit.nonce]) revert Replay();
        authorization = RequestHash.permitDigest(permit, block.chainid, address(this));
        if (!SignatureCheck.valid(key.signer, authorization, signature)) revert InvalidSignature();
    }

    function _evidence(
        RequestHash.Request calldata request,
        bytes32 digest,
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) private view returns (bytes32) {
        Policy memory policy = policies[request.issuerId][request.policyVersion];
        if (policy.programVersion == 0 || policy.revoked) revert InactiveRecord();
        Program memory program = programs[policy.programVersion];
        SourceKey memory source = sourceKeys[policy.sourceId][policy.sourceKeyVersion];
        if (
            program.verifier == address(0) || program.revoked || program.verifier.codehash != program.codeHash
                || source.fingerprint == 0 || source.revoked
        ) revert InactiveRecord();
        if (publicValues.length != 224 || proofBytes.length == 0) revert InvalidEvidence();
        Evidence memory evidence = abi.decode(publicValues, (Evidence));
        if (
            evidence.profileVersion != program.profile || evidence.requestDigest != digest
                || evidence.signerFingerprint != source.fingerprint || evidence.sourceId != policy.sourceId
                || evidence.claimUsageId != request.claimUsageId || evidence.claimCommitment != request.claimCommitment
        ) revert InvalidEvidence();
        if (block.timestamp >= evidence.claimValidUntil || request.validUntil > evidence.claimValidUntil) {
            revert Expired();
        }
        ISP1Verifier(program.verifier).verifyProof(program.vkey, publicValues, proofBytes);
        return program.vkey;
    }
}
