// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployIssuance} from "../script/DeployIssuance.s.sol";
import {IssuanceGate} from "../src/IssuanceGate.sol";
import {TestVerifier} from "./IssuanceGate.t.sol";
import {TestHtsService} from "./HederaMintAdapter.t.sol";
import {SP1Verifier} from "../src/vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

interface DeploymentVm {
    function setEnv(string calldata name, string calldata value) external;
    function toString(address value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function etch(address target, bytes calldata code) external;
    function deal(address target, uint256 balance) external;
}

/// Wiring tests use the real verifier and a local HTS model, without claiming proof/native-network acceptance.
contract DeployIssuanceTest {
    DeploymentVm internal constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DeployIssuance internal deployment;
    SP1Verifier internal verifier;

    function setUp() public {
        deployment = new DeployIssuance();
        verifier = new SP1Verifier();
        configureEnvironment();
    }

    function configureEnvironment() internal {
        vm.setEnv("GOVERNOR", vm.toString(tx.origin));
        vm.setEnv("INITIALIZER", vm.toString(tx.origin));
        vm.setEnv("SP1_VERIFIER", vm.toString(address(verifier)));
        vm.setEnv("SP1_VERIFIER_CODE_HASH", vm.toString(address(verifier).codehash));
        vm.setEnv("SP1_VKEY", vm.toString(bytes32(uint256(77))));
        vm.setEnv("SP1_PROFILE", "2");
        vm.setEnv("PROGRAM_VERSION", "1");
        vm.setEnv("ISSUER_ID", vm.toString(bytes32(uint256(1))));
        vm.setEnv("RIGHTS_VERSION", "1");
        vm.setEnv("RIGHTS_TERMS_HASH", vm.toString(keccak256("test terms")));
        vm.setEnv("TOKEN_NAME", "Deployment test");
        vm.setEnv("TOKEN_SYMBOL", "DEPTEST");
        vm.setEnv("TOKEN_EXPIRY_SECOND", "2000000000");
        vm.setEnv("TOKEN_CREATE_VALUE", "1");
    }

    function checkConfigurationRequiresExplicitProgramPins() internal {
        DeployIssuance.Configuration memory c = deployment.configuration();
        require(c.verifier == address(verifier) && c.profile == 2 && c.vkey == bytes32(uint256(77)), "pins changed");
        vm.setEnv("SP1_VKEY", vm.toString(bytes32(0)));
        vm.expectRevert(DeployIssuance.InvalidConfiguration.selector);
        deployment.configuration();
    }

    function checkAbsentProgramKeyCannotUseFallback() internal {
        vm.setEnv("SP1_VKEY", "");
        vm.expectRevert();
        deployment.configuration();
    }

    function checkWrongVerifierCodeHashFailsBeforeDeployment() internal {
        vm.setEnv("SP1_VERIFIER_CODE_HASH", vm.toString(bytes32(uint256(99))));
        vm.expectRevert(DeployIssuance.VerifierCodeHashMismatch.selector);
        deployment.run();
        require(address(deployment.gate()) == address(0), "deployed before checking pins");
    }

    function checkLegacyProfileAndMissingCreationFundingFail() internal {
        vm.setEnv("SP1_PROFILE", "1");
        vm.expectRevert(DeployIssuance.InvalidConfiguration.selector);
        deployment.configuration();
        vm.setEnv("SP1_PROFILE", "2");
        vm.setEnv("TOKEN_CREATE_VALUE", "0");
        vm.expectRevert(DeployIssuance.InvalidConfiguration.selector);
        deployment.configuration();
    }

    function checkAbsentVerifierCodeFails() internal {
        vm.setEnv("SP1_VERIFIER", vm.toString(address(0xBEEF)));
        vm.expectRevert(DeployIssuance.InvalidConfiguration.selector);
        deployment.configuration();
    }

    function checkPinnedTestDoubleCannotReplaceRealVerifier() internal {
        TestVerifier standIn = new TestVerifier();
        vm.setEnv("SP1_VERIFIER", vm.toString(address(standIn)));
        vm.setEnv("SP1_VERIFIER_CODE_HASH", vm.toString(address(standIn).codehash));
        vm.expectRevert(DeployIssuance.VerifierCodeHashMismatch.selector);
        deployment.configuration();
    }

    function installHtsModel() internal {
        TestHtsService model = new TestHtsService();
        vm.etch(address(0x167), address(model).code);
        vm.deal(tx.origin, 10 ether);
        vm.deal(address(deployment), 10 ether);
    }

    function checkConfiguredDeploymentStaysPausedAndUsesSuppliedVerifier() internal {
        installHtsModel();
        (address createdGate, address actualVerifier,,) = deployment.run();
        IssuanceGate g = IssuanceGate(createdGate);
        require(g.paused() && actualVerifier == address(verifier) && deployment.registered(), "wrong deployment");
        (address registeredVerifier, bytes32 codeHash, bytes32 vkey, uint32 profile,) = g.programs(1);
        require(
            registeredVerifier == address(verifier) && codeHash == address(verifier).codehash
                && vkey == bytes32(uint256(77)) && profile == 2,
            "configured pins not retained"
        );
    }

    function checkSeparateGovernorIsNeverImpersonated() internal {
        installHtsModel();
        address separateGovernor = address(0xBEEF);
        vm.setEnv("GOVERNOR", vm.toString(separateGovernor));
        (address createdGate,,,) = deployment.run();
        IssuanceGate g = IssuanceGate(createdGate);
        (address registeredVerifier,,,,) = g.programs(1);
        require(
            g.governor() == separateGovernor && g.paused() && registeredVerifier == address(0)
                && !deployment.registered(),
            "separate governance bypassed"
        );
        require(deployment.programRegistrationCall().length > 4 && deployment.rightsRegistrationCall().length > 4);
    }

    function testDeploymentGuardsAndActualGovernorWiring() public {
        configureEnvironment();
        deployment = new DeployIssuance();
        checkConfigurationRequiresExplicitProgramPins();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkAbsentProgramKeyCannotUseFallback();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkWrongVerifierCodeHashFailsBeforeDeployment();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkLegacyProfileAndMissingCreationFundingFail();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkAbsentVerifierCodeFails();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkPinnedTestDoubleCannotReplaceRealVerifier();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkConfiguredDeploymentStaysPausedAndUsesSuppliedVerifier();
        configureEnvironment();
        deployment = new DeployIssuance();
        checkSeparateGovernorIsNeverImpersonated();
    }
}
