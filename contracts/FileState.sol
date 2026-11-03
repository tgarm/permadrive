// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FileState — PermaDrive directory state layer (hide marks + generic file props).
/// @notice Same namespace convention as FileRegistryV2 (msg.sender is the owner,
///  key = keccak256(manifestCid)): Registry v2 handles "registration + dev fee",
///  this contract only handles directory display state (hide) and per-file
///  attributes. Design motivation: permanent storage has no delete — the app
///  replaces Delete with Hide, and once the hide mark is on-chain, recovery on
///  a new device automatically lands the file in the hidden group.
///  Why a side contract instead of a Registry v3: v2 is deployed and immutable;
///  a v3 migration would require re-paying the dev fee for every entry, or an
///  owner-only free import that would break the purity of the FeePaid airdrop
///  ledger. The side contract needs zero migration and keeps the ledger
///  continuous. When `fileStateAddress` is not configured, the frontend
///  degrades entirely to no-hide behavior (same pattern as paywallV2Address).
/// @dev No funds surface (not payable, no treasury, no owner permissions):
///  state writes produce no consensus-chain storage, so there is no fee to
///  collect — only gas. Permissionless: marking any CID is allowed (same
///  stance as v2 "the registry is an index, not proof of ownership"); entry
///  existence is enforced by the frontend.
///  The generic props layer (setProp/prop/props) is a deliberate reserve:
///  future capabilities such as diff (e.g. diff.kind / diff.base digests) and
///  compression (e.g. a compression parameter digest) can write property slots
///  directly — no new contract deployment needed. propKey = keccak256(human
///  readable name), with the convention maintained in the frontend; value is
///  bytes32 — booleans/small numbers stored directly, long data stored as a
///  32-byte digest (a CID's blake3 multihash digest is exactly 32 bytes);
///  0x0 means cleared.
contract FileState {
    event Hidden(address indexed owner, string manifestCid);
    event Unhidden(address indexed owner, string manifestCid);
    event PropSet(address indexed owner, string manifestCid, bytes32 indexed propKey, bytes32 value);

    /// owner → keccak256(manifestCid) → hidden
    mapping(address => mapping(bytes32 => bool)) private _hidden;
    /// owner → keccak256(manifestCid) → propKey → value (generic props layer, see file header)
    mapping(address => mapping(bytes32 => mapping(bytes32 => bytes32))) private _props;

    /// Set the hide mark. Setting the same value again is an idempotent no-op
    /// (no event), so replays are safe.
    function setHidden(string calldata manifestCid, bool hidden) external {
        bytes32 key = keccak256(bytes(manifestCid));
        if (_hidden[msg.sender][key] == hidden) return;
        _hidden[msg.sender][key] = hidden;
        if (hidden) emit Hidden(msg.sender, manifestCid);
        else emit Unhidden(msg.sender, manifestCid);
    }

    /// Write one property. value == 0x0 means "clear"; writing the same value
    /// again is an idempotent no-op (no event).
    function setProp(string calldata manifestCid, bytes32 propKey, bytes32 value) external {
        bytes32 key = keccak256(bytes(manifestCid));
        if (_props[msg.sender][key][propKey] == value) return;
        _props[msg.sender][key][propKey] = value;
        emit PropSet(msg.sender, manifestCid, propKey, value);
    }

    function isHidden(address owner_, string calldata manifestCid) external view returns (bool) {
        return _hidden[owner_][keccak256(bytes(manifestCid))];
    }

    /// Batch hide query (the frontend fetches the whole hidden set in one call;
    /// CIDs never marked return false)
    function hiddenFlags(address owner_, string[] calldata manifestCids) external view returns (bool[] memory) {
        bool[] memory flags = new bool[](manifestCids.length);
        for (uint256 i = 0; i < manifestCids.length; i++) {
            flags[i] = _hidden[owner_][keccak256(bytes(manifestCids[i]))];
        }
        return flags;
    }

    function prop(address owner_, string calldata manifestCid, bytes32 propKey) external view returns (bytes32) {
        return _props[owner_][keccak256(bytes(manifestCid))][propKey];
    }

    /// Batch-read multiple properties of one file (order matches propKeys;
    /// unset slots return 0x0)
    function props(address owner_, string calldata manifestCid, bytes32[] calldata propKeys)
        external
        view
        returns (bytes32[] memory)
    {
        bytes32 key = keccak256(bytes(manifestCid));
        bytes32[] memory values = new bytes32[](propKeys.length);
        for (uint256 i = 0; i < propKeys.length; i++) {
            values[i] = _props[owner_][key][propKeys[i]];
        }
        return values;
    }
}
