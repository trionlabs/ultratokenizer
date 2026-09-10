// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BusinessLogicResolver} from "ats/infrastructure/diamond/BusinessLogicResolver.sol";
import {IBusinessLogicResolver} from "ats/infrastructure/diamond/IBusinessLogicResolver.sol";
import {IDiamondCutManager} from "ats/infrastructure/diamond/IDiamondCutManager.sol";
import {ResolverProxy} from "ats/infrastructure/proxy/ResolverProxy.sol";
import {IResolverProxy} from "ats/infrastructure/proxy/IResolverProxy.sol";
import {DEFAULT_ADMIN_ROLE, ROLE_ISSUER} from "ats/constants/roles.sol";
import {IFactory} from "ats/factory/IFactory.sol";
import {IAccessControl} from "ats/facets/accessControl/IAccessControl.sol";
import {IInitializer} from "ats/facets/initializer/IInitializer.sol";
import {ICore} from "ats/facets/core/ICore.sol";
import {ICap} from "ats/facets/cap/ICap.sol";
import {IPartitions} from "ats/facets/partitions/IPartitions.sol";
import {IMint} from "ats/facets/mint/IMint.sol";
import {ITransfer} from "ats/facets/transfer/ITransfer.sol";
import {IBalanceTracker} from "ats/facets/balanceTracker/IBalanceTracker.sol";
import {IAllowance} from "ats/facets/allowance/IAllowance.sol";
import {IControlList} from "ats/facets/controlList/IControlList.sol";

import {AdapterArtifactPin} from "./generated/AdapterArtifactPin.sol";

interface IStaticFacet {
    function getStaticResolverKey() external pure returns (bytes32);
}

interface IAdapterProvisioning {
    struct RuntimePin {
        address target;
        bytes32 codeHash;
    }
    function initializeToken(address token_, RuntimePin[] calldata pins) external;
}

/// Narrow synthetic constructor-only profile. No runtime privileged forwarding or upgrade.
/// User-supplied artifact/runtime pins still require independent provisioning review.
contract AtsGateProfile {
    bytes32 public constant CONFIGURATION = keccak256("Ultratokenizer.SyntheticGoldRight.GateIntegration.v1");
    address public immutable token;
    address public immutable adapter;
    BusinessLogicResolver public immutable resolver;

    constructor(
        address gate,
        IAdapterProvisioning.RuntimePin[] memory facets,
        IAdapterProvisioning.RuntimePin[] memory libraries,
        bytes memory adapterCreation
    ) {
        require(facets.length == 10 && libraries.length == 4, "exact reviewed candidate set required");
        require(keccak256(adapterCreation) == AdapterArtifactPin.CREATION_HASH, "wrong adapter artifact");
        BusinessLogicResolver configured = new BusinessLogicResolver();
        configured.initializeBusinessLogicResolver();
        _register(configured, facets);
        bytes memory creation = bytes.concat(adapterCreation, abi.encode(gate, address(this)));
        address selected;
        assembly { selected := create(0, add(creation, 0x20), mload(creation)) }
        require(selected.code.length != 0, "adapter creation failed");
        address created = _createToken(configured, selected);
        IAdapterProvisioning.RuntimePin[] memory pins = new IAdapterProvisioning.RuntimePin[](15);
        for (uint256 i; i < facets.length; ++i) {
            pins[i] = facets[i];
        }
        for (uint256 i; i < libraries.length; ++i) {
            pins[10 + i] = libraries[i];
        }
        pins[14] = IAdapterProvisioning.RuntimePin(address(configured), address(configured).codehash);
        IAdapterProvisioning(selected).initializeToken(created, pins);
        token = created;
        adapter = selected;
        resolver = configured;
    }

    function _register(BusinessLogicResolver configured, IAdapterProvisioning.RuntimePin[] memory facets) private {
        IBusinessLogicResolver.BusinessLogicRegistryData[] memory entries =
            new IBusinessLogicResolver.BusinessLogicRegistryData[](facets.length);
        IDiamondCutManager.FacetConfiguration[] memory configuration =
            new IDiamondCutManager.FacetConfiguration[](facets.length);
        for (uint256 i; i < facets.length; ++i) {
            require(
                facets[i].target.code.length != 0 && facets[i].target.codehash == facets[i].codeHash,
                "wrong facet runtime"
            );
            bytes32 key = IStaticFacet(facets[i].target).getStaticResolverKey();
            entries[i] = IBusinessLogicResolver.BusinessLogicRegistryData(key, facets[i].target);
            configuration[i] = IDiamondCutManager.FacetConfiguration(key, 1);
        }
        configured.registerBusinessLogics(entries);
        configured.createConfiguration(
            CONFIGURATION, configuration, "Synthetic local gold-right Gate integration; no securities or ISIN claim"
        );
    }

    function _createToken(BusinessLogicResolver configured, address selectedAdapter) private returns (address created) {
        IResolverProxy.Rbac[] memory roles = new IResolverProxy.Rbac[](2);
        address[] memory admins = new address[](1);
        admins[0] = address(this);
        roles[0] = IResolverProxy.Rbac(DEFAULT_ADMIN_ROLE, admins);
        address[] memory issuers = new address[](1);
        issuers[0] = selectedAdapter;
        roles[1] = IResolverProxy.Rbac(ROLE_ISSUER, issuers);
        created = address(new ResolverProxy(IBusinessLogicResolver(address(configured)), CONFIGURATION, 1, roles));
        IInitializer(created).initializeInitializer(10);
        IAccessControl(created).initializeAccessControl();
        ICore(created)
            .initializeCore(
                ICore.ERC20Metadata(
                    ICore.ERC20MetadataInfo("Synthetic Gold-Deposit Right (Gate Integration)", "UTGINT", "", 3),
                    IFactory.SecurityType.DepositToken
                )
            );
        ICap(created).initializeCap(1_000_000, new ICap.PartitionCap[](0));
        IPartitions(created).initializePartitions(false);
        IMint(created).initializeERC1594();
        ITransfer(created).initializeTransfer();
        IBalanceTracker(created).initializeBalanceTracker();
        IAllowance(created).initializeAllowance();
        IControlList(created).initializeControlList(false);
        (bool operational,) = IInitializer(created).setOperationalStatus();
        require(operational, "incomplete selected facet initialization");
    }
}
