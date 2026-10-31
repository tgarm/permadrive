// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PublicPublisher — PermaDrive public publishing via dust-price sale.
/// @notice "Public" = selling the file to "the public" (a constant contract
///  address) at 1 wei through the official DirectSales instance: the purchase
///  and the Published event (which carries the file key K) complete atomically
///  in one transaction, so no "received but withheld" intermediate state can
///  exist. Sold means public: the event is the public log (key distribution /
///  public directory / dedup index in one stream).
/// @dev Trust domain (hardened):
///  1. `sales` is construction-time immutable, welded to the official
///     DirectSales instance (main/test each point at their own instance) — a
///     fake sales contract cannot manufacture authoritative-looking Published
///     events (readers only trust events emitted by the configured publisher,
///     filtered by eth_getLogs address).
///  2. Only the listing seller can call (msg.sender == seller) plus a
///     listingId match — publishing is always the seller's own decision;
///     nobody else holds the real K, and a fake K is rejected by the reader's
///     AES-GCM authentication tag.
///  3. Mandatory 1 wei (DUST_PRICE, not parameterized), 32-byte key, CID
///     length cap — triple input clamping.
///  4. purchase with maxPrice = 1 wei plus exact payment clamps the listing
///     price to exactly 1 wei (PriceTooHigh / ExactPaymentRequired as
///     backstops); with platformBps <= 20% the fee divides to 0 and
///     sellerNet = 1 wei is returned to the seller in the same transaction —
///     the contract holds no funds.
///  5. Published event fields (plainSha256/plainSize/key) are publisher
///     claims, not content authenticity — readers must retrieve, decrypt and
///     verify the plaintext digest+size before trusting them. This contract
///     has no rate entry point (the "public buyer" does not rate).
interface IDirectSales {
    function listingIdOf(address seller, bytes32 fileKey) external pure returns (bytes32);
    function purchase(bytes32 listingId, uint256 expectedRevision, uint96 maxPrice, uint16 maxPlatformBps, uint16 maxProviderBps) external payable;
}

contract PublicPublisher {
    /// Public log (key distribution / public directory / dedup index in one).
    /// fileKey indexed -> exact per-file lookup by topic; event fields are
    /// publisher claims.
    event Published(
        bytes32 indexed fileKey,
        address indexed seller,
        string manifestCid,
        bytes key,
        bytes32 plainSha256,
        uint64 plainSize,
        uint64 manifestHeightHint
    );

    error NotListingSeller();
    error ListingMismatch();
    error WrongValue(); // not 1 wei (public = dust price, constant on purpose)
    error BadKeyLength(); // K must be 32 bytes
    error CidTooLong(); // event string length cap

    uint256 public constant DUST_PRICE = 1 wei;
    /// CIDv1 base32 is ~59-63 chars; 128 leaves headroom
    uint256 public constant MAX_CID_LENGTH = 128;
    /// Trust domain: official DirectSales instance welded at construction
    address public immutable sales;

    constructor(address sales_) {
        sales = sales_;
    }

    /// Dust-price sale: called by the seller themself, value = 1 wei returned
    /// in the same transaction. The purchase and the emit complete atomically
    /// — note that once broadcast, K has already propagated with the calldata
    /// even if this transaction reverts (disclosure happens at broadcast
    /// time, not at inclusion; no contract can undo that).
    function publish(
        address seller,
        bytes32 listingId,
        uint256 expectedRevision,
        string calldata manifestCid,
        bytes calldata key,
        bytes32 plainSha256,
        uint64 plainSize,
        uint64 manifestHeightHint
    ) external payable {
        if (msg.sender != seller) revert NotListingSeller();
        if (msg.value != DUST_PRICE) revert WrongValue();
        if (key.length != 32) revert BadKeyLength();
        if (bytes(manifestCid).length > MAX_CID_LENGTH) revert CidTooLong();
        bytes32 fk = keccak256(bytes(manifestCid)); // same derivation as the frontend fileKeyOf (UTF-8)
        if (IDirectSales(sales).listingIdOf(seller, fk) != listingId) revert ListingMismatch();
        // maxPrice = msg.value = 1 wei => PriceTooHigh + ExactPaymentRequired
        // both clamp the listing price to exactly 1 wei; the platform fee
        // divides to 0 and the 1 wei is returned to the seller
        IDirectSales(sales).purchase{value: msg.value}(
            listingId, expectedRevision, uint96(msg.value), type(uint16).max, type(uint16).max
        );
        emit Published(fk, seller, manifestCid, key, plainSha256, plainSize, manifestHeightHint);
    }
}
