// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Mailbox — the PermaDrive on-chain private-message mailbox
/// @notice The contract's events ARE the mailbox: content is the end-to-end
///         encrypted envelope (x25519-xsalsa20-poly1305, base64). What is
///         publicly visible is only who talks to whom, when, and the
///         ciphertext length — a privacy boundary consistent with the
///         blockchain's openness. The recipient must register an encryption
///         pubkey via announceEncryptionKey first; send is permissionless.
/// @dev No owner, no upgradeability, no pause; messages cannot be deleted
///      (deletion is impossible on-chain; the read state lives locally).
///      Key rotation is out of scope for v1: changing the key makes old mail
///      unreadable, which the documentation calls out.
contract Mailbox {
    error EmptyKey();
    error EmptyContent();
    error ContentTooLarge(uint256 size, uint256 max);
    error SameSenderRecipient();

    /// Encryption pubkey registration (calling again overwrites; v1 cannot rotate old mail)
    event EncryptionKeyAnnounced(address indexed account, string encPubkey);
    /// The message ledger: id increases globally; at is this chain's block timestamp
    event MessageSent(uint256 indexed id, address indexed from, address indexed to, string content, uint64 sentAt);

    /// Per-message ciphertext cap (base64 bytes): guards against accidental huge strings blowing up gas
    uint256 public constant MAX_CONTENT_BYTES = 8192;

    /// address → encryption pubkey (MetaMask eth_getEncryptionPublicKey format or a locally derived x25519 pubkey, both base64)
    mapping(address => string) public keys;
    uint256 public nextId;

    function announceEncryptionKey(string calldata encPubkey) external {
        if (bytes(encPubkey).length == 0) revert EmptyKey();
        keys[msg.sender] = encPubkey;
        emit EncryptionKeyAnnounced(msg.sender, encPubkey);
    }

    function send(address to, string calldata content) external {
        if (to == msg.sender) revert SameSenderRecipient();
        if (bytes(content).length == 0) revert EmptyContent();
        if (bytes(content).length > MAX_CONTENT_BYTES) revert ContentTooLarge(bytes(content).length, MAX_CONTENT_BYTES);
        uint256 id = nextId;
        nextId = id + 1;
        emit MessageSent(id, msg.sender, to, content, uint64(block.timestamp));
    }
}
