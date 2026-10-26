// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FileRegistry — PermaDrive on-chain registry custody
/// @notice One manifest registry per EVM address. Entries point to manifest files
///         already published to the DSN (the manifest is itself a file; on-chain only
///         its DAG root CID plus a consensus-chain locator hint is stored). The
///         registry is an index of attribution, not proof of ownership — proof of
///         ownership is the Substrate signature of manifest.uploader; anyone may
///         register any CID (permissionless).
/// @dev No owner, no upgrades, no permission model: msg.sender is the namespace
///     ("the signature is the identity").
contract FileRegistry {
    struct Entry {
        string manifestCid; // DAG root CID of the manifest file (bafkr…)
        uint32 height; // consensus-chain block height of the remark carrying this manifest file (a locator hint, not a commitment)
        string name; // original file name (shown in the listing on recovery)
        uint64 size; // original file size in bytes (display)
        uint64 registeredAt; // block timestamp of the chain hosting this contract
    }

    error NotFound();
    error DuplicateEntry();

    event Registered(address indexed owner, string manifestCid, uint32 height, string name, uint64 size);
    event Removed(address indexed owner, string manifestCid);

    // owner → registry; owner → keccak(manifestCid) → index+1 (0 = not registered)
    mapping(address => Entry[]) private _entries;
    mapping(address => mapping(bytes32 => uint256)) private _indexOf;

    function register(string calldata manifestCid, uint32 height, string calldata name, uint64 size) external {
        bytes32 key = keccak256(bytes(manifestCid));
        if (_indexOf[msg.sender][key] != 0) revert DuplicateEntry();
        _entries[msg.sender].push(Entry(manifestCid, height, name, size, uint64(block.timestamp)));
        _indexOf[msg.sender][key] = _entries[msg.sender].length;
        emit Registered(msg.sender, manifestCid, height, name, size);
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

    function count(address owner) external view returns (uint256) {
        return _entries[owner].length;
    }

    function entry(address owner, uint256 index) external view returns (Entry memory) {
        return _entries[owner][index];
    }

    function entries(address owner) external view returns (Entry[] memory) {
        return _entries[owner];
    }
}
