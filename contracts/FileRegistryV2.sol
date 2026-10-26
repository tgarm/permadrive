// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FileRegistryV2 — PermaDrive on-chain registry custody + dev fee
/// @notice Builds on v1 (FileRegistry.sol) by making register payable:
///         fee = max(minFee, size × feePerByte) (≈5% of the consensus-chain storage
///         fee estimate). Overpayment is refunded to the payer; the fee is forwarded
///         directly to the treasury (no escrow). The FeePaid event is the on-chain
///         ledger for a future retroactive token airdrop.
///         All other semantics match v1: msg.sender is the namespace; the registry is
///         an index of attribution, not proof of ownership; skipping the fee does not
///         affect the ability to fetch the data directly from the chain itself.
/// @dev The only privileged surface: owner may adjust feePerByte/minFee (the contract
///      cannot read consensus-chain fee rates, so they must be followed manually),
///      bounded by the MAX_FEE_PER_BYTE hard cap; no upgrades, no pauses, no blacklists.
contract FileRegistryV2 {
    struct Entry {
        string manifestCid; // DAG root CID of the manifest file (bafkr…)
        uint32 height; // consensus-chain block height of the remark carrying this manifest file (a locator hint, not a commitment)
        string name; // original file name (shown in the listing on recovery)
        uint64 size; // original file size in bytes (display + fee input)
        uint64 registeredAt; // block timestamp of the chain hosting this contract
        uint96 feePaid; // dev fee paid for this registration (wei); always ≤ msg.value, so overflow cannot happen in practice
    }

    error NotFound();
    error DuplicateEntry();
    error InsufficientFee(uint256 required, uint256 provided);
    error NotOwner();
    error FeeRateTooHigh();

    event Registered(
        address indexed owner, string manifestCid, uint32 height, string name, uint64 size, uint256 feePaid
    );
    /// Payment ledger for a future token airdrop: summing amount by payer yields the snapshot
    event FeePaid(address indexed payer, bytes32 indexed manifestCidKey, uint256 amount);
    event Removed(address indexed owner, string manifestCid);
    event FeeUpdated(uint256 feePerByte, uint256 minFee);

    address public immutable treasury;
    address public owner;
    /// wei/byte. Initial value ≈ 5% of the consensus transactionByteFee (2.1049e12 shannon/byte →
    /// 2.1049e12 wei/byte → ×0.05); the owner follows the consensus-chain rate manually
    uint256 public feePerByte;
    /// Fee floor for a single registration, so tiny files are not billed dust amounts
    uint256 public minFee;
    /// Hard fee-rate cap (~190x the initial value): ceiling on how far the owner can raise fees, preventing large unilateral increases
    uint256 public constant MAX_FEE_PER_BYTE = 2e13;

    // owner → registry; owner → keccak(manifestCid) → index+1 (0 = not registered)
    mapping(address => Entry[]) private _entries;
    mapping(address => mapping(bytes32 => uint256)) private _indexOf;

    constructor(address treasury_, uint256 feePerByte_, uint256 minFee_) {
        treasury = treasury_;
        owner = msg.sender;
        require(feePerByte_ > 0 && feePerByte_ <= MAX_FEE_PER_BYTE);
        require(minFee_ > 0);
        feePerByte = feePerByte_;
        minFee = minFee_;
    }

    /// Same formula as inside register; the frontend displays this fee and passes it as msg.value
    function quote(uint64 size) public view returns (uint256) {
        uint256 bySize = uint256(size) * feePerByte;
        return bySize < minFee ? minFee : bySize;
    }

    function register(string calldata manifestCid, uint32 height, string calldata name, uint64 size)
        external
        payable
    {
        uint256 fee = quote(size);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);
        bytes32 key = keccak256(bytes(manifestCid));
        if (_indexOf[msg.sender][key] != 0) revert DuplicateEntry();
        _entries[msg.sender].push(Entry(manifestCid, height, name, size, uint64(block.timestamp), uint96(fee)));
        _indexOf[msg.sender][key] = _entries[msg.sender].length;
        emit Registered(msg.sender, manifestCid, height, name, size, fee);
        emit FeePaid(msg.sender, key, fee);

        // Checks-effects-interactions: account for everything first, then refund the
        // overpayment and forward the fee to the treasury. The treasury is the project
        // address fixed at deployment; a callback can only re-enter register (an extra
        // paid registration — harmless).
        (bool refundOk, ) = msg.sender.call{value: msg.value - fee}("");
        require(refundOk);
        (bool feeOk, ) = treasury.call{value: fee}("");
        require(feeOk);
    }

    function remove(string calldata manifestCid) external {
        bytes32 key = keccak256(bytes(manifestCid));
        uint256 pos = _indexOf[msg.sender][key];
        if (pos == 0) revert NotFound();
        Entry[] storage list = _entries[msg.sender];
        uint256 index = pos - 1;
        uint256 lastIndex = list.length - 1;
        if (index != lastIndex) {
            list[index] = list[lastIndex];
            _indexOf[msg.sender][keccak256(bytes(list[index].manifestCid))] = index + 1;
        }
        _indexOf[msg.sender][key] = 0;
        list.pop();
        emit Removed(msg.sender, manifestCid);
    }

    function setFee(uint256 feePerByte_, uint256 minFee_) external {
        if (msg.sender != owner) revert NotOwner();
        if (feePerByte_ == 0 || feePerByte_ > MAX_FEE_PER_BYTE) revert FeeRateTooHigh();
        if (minFee_ == 0) revert FeeRateTooHigh();
        feePerByte = feePerByte_;
        minFee = minFee_;
        emit FeeUpdated(feePerByte_, minFee_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    function count(address owner_) external view returns (uint256) {
        return _entries[owner_].length;
    }

    function entry(address owner_, uint256 index) external view returns (Entry memory) {
        return _entries[owner_][index];
    }

    function entries(address owner_) external view returns (Entry[] memory) {
        return _entries[owner_];
    }
}
