// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IssuanceGate} from "../src/IssuanceGate.sol";
import {HederaMintAdapter} from "../src/HederaMintAdapter.sol";
import {MockSp1Verifier} from "./helpers/MockSp1Verifier.sol";
import {RequestHash} from "../src/RequestHash.sol";
import {IHts, IHtsFungible} from "../src/interfaces/IHts.sol";

/// HTS integration harness for HederaMintAdapter.
///
/// By default it runs with zero network access against a faithful local model of the
/// native HTS system contract installed at 0x167 via vm.etch. If HEDERA_RPC_URL or
/// HEDERA_FORK_URL is set, it selects that fork and the real 0x167 precompile is used
/// instead; the mock-only tests are skipped and a single clearly-labeled smoke test
/// exercises the real precompile. The fork path has NOT been validated against a live
/// Hedera endpoint and is provided as scaffolding only.
interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chainId) external;
    function deal(address account, uint256 amount) external;
    function etch(address target, bytes calldata code) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata reason) external;
    function expectRevert() external;
    function envOr(string calldata name, string calldata defaultValue) external pure returns (string memory);
    function createSelectFork(string calldata url) external returns (uint256);
    function skip(bool skipTest) external;
}

/// Local model of a native HTS fungible token. Never a production token; it exists only
/// to reproduce the association, treasury and supply-key semantics of HTS in the EVM.
contract MockHtsToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isAssociated;
    address public treasury;
    address public supplyKey;
    int64 public fee;
    address public feeCollector;

    function init(address treasury_, address supplyKey_) external {
        require(treasury == address(0), "already initialized");
        treasury = treasury_;
        supplyKey = supplyKey_;
        isAssociated[treasury_] = true;
    }

    function associate(address account) external {
        require(msg.sender == address(0x167), "association via HTS only");
        isAssociated[account] = true;
    }

    function setFee(int64 fee_, address collector_) external {
        require(msg.sender == address(0x167), "fee config via HTS only");
        fee = fee_;
        feeCollector = collector_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == address(0x167), "only HTS");
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function transfer(address from, address to, uint256 amount) external {
        require(msg.sender == address(0x167), "only HTS");
        require(isAssociated[to], "recipient not associated");
        require(balanceOf[from] >= amount, "insufficient balance");
        uint256 net = amount;
        if (fee > 0) {
            require(feeCollector != address(0), "fee without collector");
            // fee is a positive int64; widening to uint256 preserves its value.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 feeAmount = uint256(uint64(fee));
            // A fee at or above the amount would underflow; model it as a
            // clean shortfall instead of an arithmetic panic.
            require(feeAmount < amount, "fee exceeds amount");
            net = amount - feeAmount;
            balanceOf[feeCollector] += feeAmount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += net;
    }
}

/// Local model of the HTS system contract at 0x167.
contract MockHtsService {
    int64 internal constant SUCCESS = 22;
    int64 internal constant HTS_FAILURE = 7;

    bool public failCreate;
    bool public failMint;
    bool public failTransfer;
    bool public shortTransfer;
    address public treasury;

    function configure(bool create_, bool mint_, bool transfer_, bool short_) external {
        failCreate = create_;
        failMint = mint_;
        failTransfer = transfer_;
        shortTransfer = short_;
    }

    function createFungibleToken(IHts.HederaToken calldata definition, int64 initialSupply, int32 decimals)
        external
        payable
        returns (int64, address)
    {
        if (failCreate) return (HTS_FAILURE, address(0));
        require(initialSupply == 0 && decimals == 3, "unexpected supply or units");
        require(definition.treasury == msg.sender, "treasury must be caller");
        require(definition.tokenKeys.length == 1, "exactly one supply key");
        IHts.TokenKey memory supply = definition.tokenKeys[0];
        require(supply.keyType == 16, "not a supply key");
        require(supply.key.contractId == msg.sender, "supply key not caller");
        require(
            !supply.key.inheritAccountKey && supply.key.delegatableContractId == address(0)
                && supply.key.ed25519.length == 0 && supply.key.ECDSA_secp256k1.length == 0,
            "supply key not a fixed contract-id key"
        );
        MockHtsToken created = new MockHtsToken();
        created.init(msg.sender, msg.sender);
        treasury = msg.sender;
        return (SUCCESS, address(created));
    }

    function mintToken(address token, int64 amount, bytes[] calldata) external returns (int64, int64, int64[] memory) {
        if (failMint) return (HTS_FAILURE, 0, new int64[](0));
        MockHtsToken t = MockHtsToken(token);
        require(msg.sender == t.supplyKey(), "supply key not authorized");
        require(amount > 0, "positive amount");
        // Positive int64 widens without loss.
        // forge-lint: disable-next-line(unsafe-typecast)
        t.mint(t.treasury(), uint256(uint64(amount)));
        uint256 supply = t.totalSupply();
        require(supply <= uint256(uint64(type(int64).max)), "supply bound");
        // Guard above bounds the supply to positive int64.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (SUCCESS, int64(uint64(supply)), new int64[](0));
    }

    function transferToken(address token, address from, address to, int64 amount) external returns (int64) {
        MockHtsToken t = MockHtsToken(token);
        require(msg.sender == t.treasury() && from == t.treasury(), "unauthorized transfer");
        require(amount > 0, "positive amount");
        if (failTransfer || !t.isAssociated(to)) return HTS_FAILURE;
        // Positive int64 widens without loss.
        // forge-lint: disable-next-line(unsafe-typecast)
        t.transfer(from, to, uint256(uint64(amount)) - (shortTransfer ? 1 : 0));
        return SUCCESS;
    }

    /// Matches the real IHederaTokenService order: (account, token).
    function associateToken(address account, address token) external returns (int64) {
        MockHtsToken(token).associate(account);
        return SUCCESS;
    }

    function setFee(address token, int64 fee, address collector) external returns (int64) {
        MockHtsToken(token).setFee(fee, collector);
        return SUCCESS;
    }
}

contract HtsForkTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant HTS = address(0x167);

    uint256 internal constant HOLDER_KEY = 101;
    uint256 internal constant ISSUER_KEY = 202;
    bytes32 internal constant ISSUER = bytes32(uint256(1));
    bytes32 internal constant SOURCE = bytes32(uint256(2));
    bytes32 internal constant FINGERPRINT = bytes32(uint256(3));
    bytes32 internal constant RESERVATION = bytes32(uint256(4));
    bytes32 internal constant MOCK_VKEY = bytes32(uint256(77));
    uint64 internal constant EXPIRY = 2000000000;

    bool internal forking;
    IssuanceGate internal gate;
    MockSp1Verifier internal verifier;
    HederaMintAdapter internal adapter;
    address internal token;
    address internal holder;
    address internal issuer;

    function setUp() public {
        vm.warp(1900000000);
        vm.chainId(296);
        holder = vm.addr(HOLDER_KEY);
        issuer = vm.addr(ISSUER_KEY);

        string memory forkUrl = vm.envOr("HEDERA_RPC_URL", vm.envOr("HEDERA_FORK_URL", ""));
        if (bytes(forkUrl).length != 0) {
            vm.createSelectFork(forkUrl);
            forking = true;
        } else {
            MockHtsService implementation = new MockHtsService();
            vm.etch(HTS, address(implementation).code);
            forking = false;
        }

        gate = new IssuanceGate(address(this));
        verifier = new MockSp1Verifier(MOCK_VKEY);
        adapter = new HederaMintAdapter(address(gate), address(this));
        token = adapter.initializeToken("Test gold", "TGOLD", IHts.Expiry(2000000000, address(0), 0));

        gate.registerProgram(1, address(verifier), address(verifier).codehash, MOCK_VKEY, 2);
        gate.registerSourceKey(SOURCE, 1, FINGERPRINT);
        gate.registerPolicy(ISSUER, 1, 1, SOURCE, 1, keccak256("policy terms"));
        gate.registerIssuerKey(ISSUER, 1, issuer, EXPIRY);
        gate.registerRights(ISSUER, 1, address(adapter), keccak256("rights terms"));
        gate.setBackingCap(ISSUER, token, 2000);
        RequestHash.Request memory r = request();
        vm.prank(issuer);
        gate.openReservation(ISSUER, 1, RESERVATION, holder, token, 1000, EXPIRY, RequestHash.digest(r), r.claimUsageId);
        gate.setPaused(false);
    }

    /// The deterministic mock tests below cannot run against a real fork; skip them there.
    function _mock() internal {
        if (forking) vm.skip(true);
    }

    function request() internal view returns (RequestHash.Request memory r) {
        r = RequestHash.Request(
            1,
            "ISSUE",
            bytes32(uint256(5)),
            296,
            address(gate),
            token,
            holder,
            1000,
            "XAU_MILLIGRAM",
            ISSUER,
            RESERVATION,
            bytes32(uint256(6)),
            bytes32(uint256(7)),
            1,
            1,
            0,
            EXPIRY
        );
    }

    function permit(RequestHash.Request memory r) internal pure returns (RequestHash.Permit memory) {
        return RequestHash.Permit(RequestHash.digest(r), r.issuerId, 1, r.nonce, r.validUntil);
    }

    function evidence(RequestHash.Request memory r) internal pure returns (bytes memory) {
        return abi.encode(
            IssuanceGate.Evidence(
                2, RequestHash.digest(r), FINGERPRINT, SOURCE, r.claimUsageId, r.claimCommitment, EXPIRY
            )
        );
    }

    function signature(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(key, digest);
        return abi.encodePacked(rr, ss, v);
    }

    function issue(RequestHash.Request memory r, bytes4 expected) internal {
        RequestHash.Permit memory p = permit(r);
        bytes memory values = evidence(r);
        verifier.configure(MOCK_VKEY, keccak256(values), false);
        bytes memory hsig = signature(HOLDER_KEY, RequestHash.digest(r));
        bytes memory isig = signature(ISSUER_KEY, RequestHash.permitDigest(p, r.chainId, r.gate));
        if (expected == HederaMintAdapter.HtsFailure.selector) {
            vm.expectRevert(abi.encodeWithSelector(expected, int64(7)));
        } else if (expected != bytes4(0)) {
            vm.expectRevert(expected);
        }
        gate.issue(r, hsig, p, isig, values, hex"cafe");
    }

    function assertRolledBack(RequestHash.Request memory r) internal view {
        require(
            !gate.usedRequests(RequestHash.digest(r)) && !gate.usedRequestIds(r.requestId)
                && !gate.usedClaims(r.claimUsageId),
            "markers consumed"
        );
        require(
            !gate.usedHolderNonces(holder, r.nonce) && !gate.usedPermitNonces(ISSUER, 1, r.nonce), "nonces consumed"
        );
        (,,, uint256 used,,,,,) = gate.reservations(ISSUER, RESERVATION);
        require(used == 0, "reservation used");
        (, uint256 pending, uint256 outstanding) = gate.backingPools(ISSUER, token);
        require(pending == 1000 && outstanding == 0, "pool accounting persisted");
        MockHtsToken t = MockHtsToken(token);
        require(t.totalSupply() == 0 && t.balanceOf(holder) == 0, "supply persisted");
    }

    function testTokenCreationFixesTreasuryAndSoleSupplyAuthority() public {
        _mock();
        MockHtsToken t = MockHtsToken(token);
        require(t.totalSupply() == 0, "initial supply nonzero");
        require(t.treasury() == address(adapter), "wrong treasury");
        require(t.supplyKey() == address(adapter), "wrong supply key");
        vm.expectRevert(HederaMintAdapter.AlreadyInitialized.selector);
        adapter.initializeToken("Again", "NO", IHts.Expiry(2000000000, address(0), 0));
    }

    function testTreasuryAssociationAndExactMintTransfer() public {
        _mock();
        MockHtsService(HTS).associateToken(holder, token);
        MockHtsToken t = MockHtsToken(token);
        require(t.isAssociated(address(adapter)), "treasury not associated");
        RequestHash.Request memory r = request();
        issue(r, 0);
        require(
            t.totalSupply() == 1000 && t.balanceOf(holder) == 1000 && t.balanceOf(address(adapter)) == 0,
            "wrong HTS deltas"
        );
    }

    function testTransferToUnassociatedRecipientFailsAndRollsBack() public {
        _mock();
        RequestHash.Request memory r = request();
        issue(r, HederaMintAdapter.HtsFailure.selector);
        assertRolledBack(r);
        MockHtsService(HTS).associateToken(holder, token);
        issue(r, 0);
        require(MockHtsToken(token).balanceOf(holder) == 1000, "post-association issue failed");
    }

    function testCustomFeeBreaksExactDeliveryAndRollsBack() public {
        _mock();
        MockHtsService(HTS).associateToken(holder, token);
        MockHtsService(HTS).setFee(token, 1, address(0x9999));
        RequestHash.Request memory r = request();
        issue(r, HederaMintAdapter.InexactMint.selector);
        assertRolledBack(r);
        MockHtsService(HTS).setFee(token, 0, address(0));
        issue(r, 0);
        require(MockHtsToken(token).balanceOf(holder) == 1000, "fee-free retry failed");
    }

    function testShortTransferRollsBack() public {
        _mock();
        MockHtsService(HTS).associateToken(holder, token);
        MockHtsService(HTS).configure(false, false, false, true);
        RequestHash.Request memory r = request();
        issue(r, HederaMintAdapter.InexactMint.selector);
        assertRolledBack(r);
    }

    function testMintFailureRollsBackGateAccounting() public {
        _mock();
        MockHtsService(HTS).associateToken(holder, token);
        MockHtsService(HTS).configure(false, true, false, false);
        RequestHash.Request memory r = request();
        issue(r, HederaMintAdapter.HtsFailure.selector);
        assertRolledBack(r);
    }

    function testTransferFailureRollsBackGateAccounting() public {
        _mock();
        MockHtsService(HTS).associateToken(holder, token);
        MockHtsService(HTS).configure(false, false, true, false);
        RequestHash.Request memory r = request();
        issue(r, HederaMintAdapter.HtsFailure.selector);
        assertRolledBack(r);
    }

    function testOnlyAdapterSupplyKeyCanMint() public {
        _mock();
        MockHtsToken t = MockHtsToken(token);
        require(t.supplyKey() == address(adapter) && t.treasury() == address(adapter), "adapter not sole authority");
        vm.prank(holder);
        vm.expectRevert("supply key not authorized");
        MockHtsService(HTS).mintToken(token, 1, new bytes[](0));
    }

    /// Real-precompile smoke test. Runs only when HEDERA_RPC_URL / HEDERA_FORK_URL is set.
    /// Not validated in this repository; association and fees follow live HTS behavior.
    /// Balance reads use the HTS ERC20 redirect (HIP-218), the same interface the
    /// production adapter relies on for delivery checks.
    function testForkSmokeNativeHtsWithTestVerifier() public {
        if (!forking) vm.skip(true);
        vm.deal(address(this), 1000 ether);
        vm.prank(holder);
        (bool called, bytes memory returned) =
            HTS.call(abi.encodeWithSignature("associateToken(address,address)", holder, token));
        // A precompile call can succeed at EVM level while returning a nonzero
        // HTS response code; require the SUCCESS code (22) explicitly.
        require(called && returned.length == 32 && abi.decode(returned, (int64)) == 22, "real association failed");
        RequestHash.Request memory r = request();
        issue(r, 0);
        require(IHtsFungible(token).balanceOf(holder) == 1000, "real HTS delivery mismatch");
    }
}
