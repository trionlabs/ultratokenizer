// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IssuanceGate} from "../src/IssuanceGate.sol";
import {HederaMintAdapter} from "../src/HederaMintAdapter.sol";
import {IHts} from "../src/interfaces/IHts.sol";
import {SP1Verifier} from "../src/vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Minimal Foundry cheatcode interface; no production contract depends on it.
interface ScriptVm {
    enum CallerMode {
        None,
        Broadcast,
        RecurrentBroadcast,
        Prank,
        RecurrentPrank
    }

    function startBroadcast() external;
    function stopBroadcast() external;
    function readCallers() external returns (CallerMode mode, address msgSender, address txOrigin);
    function envAddress(string calldata name) external view returns (address);
    function envBytes32(string calldata name) external view returns (bytes32);
    function envUint(string calldata name) external view returns (uint256);
    function envString(string calldata name) external view returns (string memory);
}

/// Provisions a paused Gate and HTS token against the pinned direct SP1 verifier build.
/// A separate governor retains sole registration authority; the script never impersonates it.
/// Program pins must come from independently reviewed artifacts. A nonzero vkey alone does not prove soundness.
contract DeployIssuance {
    ScriptVm internal constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Configuration {
        address governor;
        address initializer;
        address verifier;
        bytes32 verifierCodeHash;
        bytes32 vkey;
        uint32 profile;
        uint64 programVersion;
        bytes32 issuerId;
        uint64 rightsVersion;
        bytes32 termsHash;
        string tokenName;
        string tokenSymbol;
        int64 expirySecond;
        uint256 tokenCreateValue;
    }

    error InvalidConfiguration();
    error VerifierCodeHashMismatch();
    error InitializerMustBroadcast();

    IssuanceGate public gate;
    address public verifier;
    HederaMintAdapter public adapter;
    address public token;
    bytes public programRegistrationCall;
    bytes public rightsRegistrationCall;
    bool public registered;

    function expectedVerifierCodeHash() public pure returns (bytes32) {
        return keccak256(type(SP1Verifier).runtimeCode);
    }

    function configuration() public view returns (Configuration memory c) {
        c.governor = vm.envAddress("GOVERNOR");
        c.initializer = vm.envAddress("INITIALIZER");
        c.verifier = vm.envAddress("SP1_VERIFIER");
        c.verifierCodeHash = vm.envBytes32("SP1_VERIFIER_CODE_HASH");
        c.vkey = vm.envBytes32("SP1_VKEY");
        uint256 profile = vm.envUint("SP1_PROFILE");
        uint256 programVersion = vm.envUint("PROGRAM_VERSION");
        c.issuerId = vm.envBytes32("ISSUER_ID");
        uint256 rightsVersion = vm.envUint("RIGHTS_VERSION");
        c.termsHash = vm.envBytes32("RIGHTS_TERMS_HASH");
        c.tokenName = vm.envString("TOKEN_NAME");
        c.tokenSymbol = vm.envString("TOKEN_SYMBOL");
        uint256 expirySecond = vm.envUint("TOKEN_EXPIRY_SECOND");
        c.tokenCreateValue = vm.envUint("TOKEN_CREATE_VALUE");
        if (
            c.governor == address(0) || c.initializer == address(0) || c.verifier.code.length == 0
                || c.verifierCodeHash == 0 || c.vkey == 0 || profile != 2 || programVersion == 0
                || programVersion > type(uint64).max || c.issuerId == 0 || rightsVersion == 0
                || rightsVersion > type(uint64).max || c.termsHash == 0 || bytes(c.tokenName).length == 0
                || bytes(c.tokenName).length > 100 || bytes(c.tokenSymbol).length == 0
                || bytes(c.tokenSymbol).length > 100 || expirySecond <= block.timestamp
                || expirySecond > uint256(uint64(type(int64).max)) || c.tokenCreateValue == 0
        ) revert InvalidConfiguration();
        if (c.verifier.codehash != c.verifierCodeHash || c.verifierCodeHash != expectedVerifierCodeHash()) {
            revert VerifierCodeHashMismatch();
        }
        // Every narrowing conversion is checked above before forming the deployment configuration.
        // forge-lint: disable-next-line(unsafe-typecast)
        c.profile = uint32(profile);
        // forge-lint: disable-next-line(unsafe-typecast)
        c.programVersion = uint64(programVersion);
        // forge-lint: disable-next-line(unsafe-typecast)
        c.rightsVersion = uint64(rightsVersion);
        // forge-lint: disable-next-line(unsafe-typecast)
        c.expirySecond = int64(uint64(expirySecond));
    }

    function run() external returns (address gate_, address verifier_, address adapter_, address token_) {
        Configuration memory c = configuration();
        registered = false;
        verifier = c.verifier;
        programRegistrationCall = abi.encodeCall(
            IssuanceGate.registerProgram, (c.programVersion, c.verifier, c.verifierCodeHash, c.vkey, c.profile)
        );
        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        if (broadcaster != c.initializer) revert InitializerMustBroadcast();
        gate = new IssuanceGate(c.governor);
        adapter = new HederaMintAdapter(address(gate), c.initializer);
        token = adapter.initializeToken{value: c.tokenCreateValue}(
            c.tokenName, c.tokenSymbol, IHts.Expiry(c.expirySecond, address(0), 0)
        );
        rightsRegistrationCall =
            abi.encodeCall(IssuanceGate.registerRights, (c.issuerId, c.rightsVersion, address(adapter), c.termsHash));
        if (broadcaster == c.governor) {
            gate.registerProgram(c.programVersion, c.verifier, c.verifierCodeHash, c.vkey, c.profile);
            gate.registerRights(c.issuerId, c.rightsVersion, address(adapter), c.termsHash);
            registered = true;
        }
        vm.stopBroadcast();
        // Separate governance must execute the exact recorded registration calls itself.
        // Issuer/source keys, policies, pool ceilings and activation are separate reviewed actions.
        return (address(gate), verifier, address(adapter), token);
    }
}
