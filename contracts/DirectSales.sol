// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DirectSales — PermaDrive direct sales: pay-and-split, no escrow, no
///  refunds, positive/negative ratings.
/// @notice Essential differences from Paywall/PaywallV2 (escrow model; v1 is
///  frozen read-only, v2 deployment was paused):
///  1. No escrow: purchase splits the payment precisely to seller / treasury
///     (platform fee) / optional providerPayout (service share) in the same
///     transaction; any failed transfer reverts the whole purchase — there is
///     no Escrowed/Refunded/confirmReceipt/release, the platform offers no
///     refunds.
///  2. Immutable revisions: repricing, changing the service or the file always
///     produces a NEW revision (monotonically increasing, never overwritten);
///     purchase must name expectedRevision (the current revision number), so a
///     swap between viewing and signing is rejected.
///  3. Service delivery: provider mode (deliveryMode=1) requires an EIP-712
///     provider attestation bound to the specific revision (chainId/contract/
///     seller/fileKey/revision/quote/providerPayout/providerBps/termsHash/
///     expiry); after expiry or revocation NEW purchases are blocked while
///     delivery authority for already-paid orders is preserved. This version
///     implements EOA signatures only (ecrecover); ERC-1271 (smart-contract
///     wallet services) is deliberately out of scope for v1.
///  4. Ratings: only actual buyers on this contract can rate (except
///     seller==buyer), with NO delivery precondition — an undelivered buyer
///     may leave a negative rating. Primary key seller+fileKey+buyer: one vote
///     per buyer, changing a vote subtracts the old one before adding the new.
///     Product totals are shared across revisions; the service dimension is
///     split per the order's snapshot provider.
///  5. Global listing log (append-only, must ship in the first deployment —
///     it cannot be added later): every listingId is appended to listingLog
///     the first time it goes on sale, enabling tail-reverse-paged market
///     feeds in a future share page.
/// @dev fileKey = keccak256(manifestCid), same derivation as FileRegistryV2 /
///      Paywall. Key delivery never touches contract funds or state: the
///      seller (or the order's snapshot provider) sends the buyer a pdgrant v3
///      message (bound to chainId/sales/orderId/buyer/seller/provider) through
///      the end-to-end encrypted Mailbox; markKeySent is an optional state
///      registration only, NOT a precondition for the buyer to decrypt and
///      download. No upgrade, no pause; the external call surface is the three
///      transfers inside purchase (with a reentrancy lock + CEI ordering).
contract DirectSales {
    enum State { Paid, KeySent }
    /// deliveryMode: 0 = seller delivers themselves (the only mode open in
    /// phase one, provider=0); 1 = a service delivers (must hold a valid
    /// EIP-712 provider attestation)
    enum DeliveryMode { Seller, Provider }

    struct Revision {
        uint96 price; // quote (wei); > 0 — delisting goes through delist, never a 0 price
        uint64 attestationExpiry; // provider-mode attestation expiry; always 0 (unchecked) in Seller mode
        uint16 platformBps; // platform-fee snapshot (contract rate at revision creation; later rate changes don't affect this quote)
        uint16 providerBps; // service share snapshot
        uint8 deliveryMode; // DeliveryMode
        address seller;
        address provider; // 0 = no service (Seller mode)
        address providerPayout; // service payout address (always 0 in Seller mode)
        bytes32 fileKey; // keccak256(manifestCid)
        bytes32 termsHash; // service terms digest (mutable off-chain URLs stay out of the contract; only the hash is locked)
        bool revoked; // provider has revoked (blocks NEW purchases; does not affect already-paid orders)
    }

    struct Order {
        uint256 revision; // revision at purchase (order snapshot: independent of the current listing)
        uint96 price;
        uint16 platformBps; // snapshot at purchase
        uint16 providerBps;
        State state;
        uint64 purchasedAt;
        address buyer;
        address seller;
        address provider; // snapshot provider: delivery authority and share split read the ORDER, not the current listing
        address providerPayout;
        bytes32 fileKey;
    }

    struct Vote {
        int8 choice; // 1 = positive, -1 = negative, 0 = not rated
        uint256 orderId; // order backing the vote (service dimension split per that order's snapshot provider)
    }

    error NotListed();
    error BadPrice();
    error BadMode();
    error BpsTooHigh(uint16 bps, uint16 max);
    error BpsSumTooHigh(uint16 platform, uint16 provider);
    error PriceTooHigh(uint96 listed, uint96 maxPrice);
    error BpsTooHighPlatform(uint16 listed, uint16 maxPlatform);
    error BpsTooHighProvider(uint16 listed, uint16 maxProvider);
    error ExactPaymentRequired(uint256 price, uint256 provided);
    error NotCurrentRevision(uint256 expected, uint256 current);
    error AttestationExpired();
    error ProviderRevoked();
    error BadAttestation();
    error BadState();
    error NotOrderSellerOrProvider();
    error NotBuyer();
    error SelfRating();
    error NotPurchased();
    error NotProvider();
    error NotOwner();
    error Reentrant();
    error TransferFailed();

    event Revised(
        bytes32 indexed listingId,
        address indexed seller,
        uint256 indexed revision,
        uint96 price,
        address provider,
        uint16 providerBps,
        uint8 deliveryMode,
        bytes32 termsHash,
        uint64 attestationExpiry
    );
    event Unlisted(bytes32 indexed listingId, address indexed seller);
    event Purchased(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        bytes32 listingId,
        uint256 revision,
        bytes32 fileKey,
        address provider,
        uint96 price,
        uint16 platformBps,
        uint16 providerBps
    );
    event KeySent(uint256 indexed orderId, address indexed sender);
    event Rated(bytes32 indexed listingId, address indexed buyer, uint256 indexed orderId, bool positive, uint64 up, uint64 down);
    event ProviderRevocation(bytes32 indexed listingId, uint256 indexed revision);
    event PlatformBpsUpdated(uint16 platformBps);

    /// hard cap on platform fee basis points (20%), same idea as the Paywall family MAX_FEE_BPS
    uint256 public constant MAX_PLATFORM_BPS = 2000;
    /// hard cap on the service share (50%) — an explicit service-fee cap policy:
    /// seller and service negotiate freely, but extreme terms are rejected outright by the contract
    uint256 public constant MAX_PROVIDER_BPS = 5000;

    address public immutable treasury;
    address public owner;
    /// platform fee in basis points (price×platformBps/1e4); default 1000 = 10%.
    /// Rate changes only affect NEW revisions created afterwards (quote
    /// snapshots); existing revisions and already-paid orders are unaffected
    uint16 public platformBps;

    /// listingId = listingIdOf(seller, fileKey) => current purchasable revision (0 = not listed / delisted)
    mapping(bytes32 => uint256) public currentRevision;
    /// revision counter per listing (immutable revisions, monotonically increasing)
    mapping(bytes32 => uint256) public revisionCount;
    mapping(bytes32 => mapping(uint256 => Revision)) private _revisions;
    /// independent increasing orderId (terminal states are never overwritten;
    /// repeat purchases by the same buyer create new orders, ratings still count one vote)
    mapping(uint256 => Order) private _orders;
    uint256 public orderCount;

    // ---- global listing log (append-only; enables tail-reverse-paged market feeds) ----
    mapping(uint256 => bytes32) public listingLog;
    uint256 public listingCount;

    // ---- ratings (primary key seller+fileKey+buyer = listingId+buyer) ----
    mapping(bytes32 => mapping(address => Vote)) public votes;
    /// product totals (shared across revisions)
    mapping(bytes32 => uint64) public productUp;
    mapping(bytes32 => uint64) public productDown;
    /// service dimension (split per the order's snapshot provider; a pre-switch
    /// rating never impersonates the new service's reputation)
    mapping(bytes32 => mapping(address => uint64)) public serviceUp;
    mapping(bytes32 => mapping(address => uint64)) public serviceDown;
    /// count of distinct buyer addresses (seller self-purchases excluded)
    mapping(bytes32 => uint64) public buyerCount;
    mapping(bytes32 => mapping(address => bool)) private _buyerSeen;

    /// minimal reentrancy lock (defense in depth; purchase is already ordered checks-effects-interactions)
    uint256 private _locked = 1;

    modifier noReentry() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address treasury_) {
        treasury = treasury_;
        owner = msg.sender;
        platformBps = 1000;
    }

    // ---- views ----

    function listingIdOf(address seller, bytes32 fileKey) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(seller, fileKey));
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("PermaDrive DirectSales")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("ProviderAttestation(address seller,bytes32 fileKey,uint256 revision,uint96 price,address providerPayout,uint16 providerBps,bytes32 termsHash,uint64 expiry)");

    /// Named-field reads (public struct getters return unnamed tuples; these
    /// explicit functions give the frontend a stable access surface).
    function revisionOf(bytes32 listingId, uint256 revision)
        external
        view
        returns (
            uint96 price,
            uint64 attestationExpiry,
            uint16 platformBps_,
            uint16 providerBps,
            uint8 deliveryMode,
            address seller,
            address provider,
            address providerPayout,
            bytes32 fileKey,
            bytes32 termsHash,
            bool revoked
        )
    {
        Revision storage r = _revisions[listingId][revision];
        return (r.price, r.attestationExpiry, r.platformBps, r.providerBps, r.deliveryMode, r.seller, r.provider, r.providerPayout, r.fileKey, r.termsHash, r.revoked);
    }

    function orderOf(uint256 orderId)
        external
        view
        returns (
            uint256 revision,
            uint96 price,
            uint16 platformBps_,
            uint16 providerBps,
            uint8 state,
            uint64 purchasedAt,
            address buyer,
            address seller,
            address provider,
            address providerPayout,
            bytes32 fileKey
        )
    {
        Order storage o = _orders[orderId];
        return (o.revision, o.price, o.platformBps, o.providerBps, uint8(o.state), o.purchasedAt, o.buyer, o.seller, o.provider, o.providerPayout, o.fileKey);
    }

    /// Product rating totals: up/down/distinct buyers (unrated listings show 0/0/0 — no synthetic default praise)
    function ratingOf(bytes32 listingId) external view returns (uint64 up, uint64 down, uint64 buyers) {
        return (productUp[listingId], productDown[listingId], buyerCount[listingId]);
    }

    function serviceRatingOf(bytes32 listingId, address provider) external view returns (uint64 up, uint64 down) {
        return (serviceUp[listingId][provider], serviceDown[listingId][provider]);
    }

    function voteOf(bytes32 listingId, address buyer) external view returns (int8 choice, uint256 orderId) {
        Vote storage v = votes[listingId][buyer];
        return (v.choice, v.orderId);
    }

    // ---- seller ----

    /// New revision (list / reprice / change service / change file). Seller mode
    /// (phase one): the three provider params must be zero. Provider mode:
    /// verifies the EIP-712 provider attestation (EOA ecrecover; ERC-1271 is
    /// not implemented in this version). The first time a listingId goes on
    /// sale it is appended to the global listingLog.
    function createRevision(
        bytes32 fileKey,
        uint96 price,
        address provider,
        address providerPayout,
        uint16 providerBps,
        uint8 deliveryMode,
        bytes32 termsHash,
        uint64 attestationExpiry,
        bytes calldata attestation
    ) external noReentry {
        if (price == 0) revert BadPrice();
        if (deliveryMode == uint8(DeliveryMode.Seller)) {
            if (provider != address(0) || providerPayout != address(0) || providerBps != 0) revert BadMode();
        } else if (deliveryMode == uint8(DeliveryMode.Provider)) {
            if (provider == address(0) || providerPayout == address(0)) revert BadMode();
            if (providerBps > MAX_PROVIDER_BPS) revert BpsTooHigh(providerBps, uint16(MAX_PROVIDER_BPS));
            if (block.timestamp >= attestationExpiry) revert AttestationExpired();
            _verifyAttestation(msg.sender, fileKey, price, provider, providerPayout, providerBps, termsHash, attestationExpiry, attestation);
        } else {
            revert BadMode();
        }
        if (platformBps + providerBps > 10000) revert BpsSumTooHigh(platformBps, providerBps);

        bytes32 lid = listingIdOf(msg.sender, fileKey);
        uint256 rid = ++revisionCount[lid];
        Revision storage r = _revisions[lid][rid];
        r.price = price;
        r.attestationExpiry = deliveryMode == uint8(DeliveryMode.Provider) ? attestationExpiry : 0;
        r.platformBps = platformBps; // quote snapshot: a later platform rate change never affects existing quotes
        r.providerBps = providerBps;
        r.deliveryMode = deliveryMode;
        r.seller = msg.sender;
        r.provider = provider;
        r.providerPayout = providerPayout;
        r.fileKey = fileKey;
        if (rid == 1) {
            listingLog[listingCount] = lid;
            listingCount++;
        }
        currentRevision[lid] = rid;
        emit Revised(lid, msg.sender, rid, price, provider, providerBps, deliveryMode, termsHash, r.attestationExpiry);
    }

    /// Delist: clears the current-revision pointer (new purchases rejected);
    /// historical revisions and orders are unaffected. Relisting =
    /// createRevision with a new revision (listingLog is NOT appended again).
    function delist(bytes32 fileKey) external {
        bytes32 lid = listingIdOf(msg.sender, fileKey);
        if (currentRevision[lid] == 0) revert NotListed();
        delete currentRevision[lid];
        emit Unlisted(lid, msg.sender);
    }

    /// Optional state registration: only the order's snapshot seller or provider
    /// may register (the seller is the fallback after a service goes stale).
    /// KeySent only means the authorized party published a delivery record — it
    /// does NOT mean the buyer has verified the key; skipping registration never
    /// blocks the buyer from decrypting and downloading.
    function markKeySent(uint256 orderId) external {
        Order storage o = _orders[orderId];
        if (o.buyer == address(0)) revert NotPurchased();
        if (msg.sender != o.seller && msg.sender != o.provider) revert NotOrderSellerOrProvider();
        if (o.state != State.Paid) revert BadState();
        o.state = State.KeySent;
        emit KeySent(orderId, msg.sender);
    }

    // ---- buyer ----

    /// Direct purchase: msg.value must EQUAL the quote exactly (no overpayment
    /// refund path — keeps the external call surface minimal);
    /// expectedRevision/maxPrice/maxPlatformBps/maxProviderBps give triple
    /// slippage protection. The split completes in the same transaction; any
    /// failed transfer reverts the whole purchase (a rejecting recipient blocks
    /// that listing from selling; the frontend surfaces the failure and the
    /// seller switches payout addresses via a new revision).
    function purchase(bytes32 listingId, uint256 expectedRevision, uint96 maxPrice, uint16 maxPlatformBps, uint16 maxProviderBps) external payable noReentry {
        uint256 rid = currentRevision[listingId];
        if (rid == 0) revert NotListed();
        if (rid != expectedRevision) revert NotCurrentRevision(expectedRevision, rid);
        Revision storage r = _revisions[listingId][rid];
        if (r.price > maxPrice) revert PriceTooHigh(r.price, maxPrice);
        if (r.platformBps > maxPlatformBps) revert BpsTooHighPlatform(r.platformBps, maxPlatformBps);
        if (r.providerBps > maxProviderBps) revert BpsTooHighProvider(r.providerBps, maxProviderBps);
        if (r.provider != address(0)) {
            if (r.revoked) revert ProviderRevoked();
            if (block.timestamp >= r.attestationExpiry) revert AttestationExpired();
        }
        if (msg.value != uint256(r.price)) revert ExactPaymentRequired(uint256(r.price), msg.value);

        // effects (all storage writes happen before any external call — CEI)
        uint256 id = ++orderCount;
        Order storage o = _orders[id];
        o.revision = rid;
        o.price = r.price;
        o.platformBps = r.platformBps;
        o.providerBps = r.providerBps;
        o.state = State.Paid;
        o.purchasedAt = uint64(block.timestamp);
        o.buyer = msg.sender;
        o.seller = r.seller;
        o.provider = r.provider;
        o.providerPayout = r.providerPayout;
        o.fileKey = r.fileKey;
        // seller self-purchases don't count toward distinct buyers (and can never be rated, see rate)
        if (msg.sender != r.seller && !_buyerSeen[listingId][msg.sender]) {
            _buyerSeen[listingId][msg.sender] = true;
            buyerCount[listingId]++;
        }
        uint256 platformFee = (uint256(r.price) * r.platformBps) / 10000;
        uint256 providerFee = (uint256(r.price) * r.providerBps) / 10000;
        uint256 sellerNet = uint256(r.price) - platformFee - providerFee;
        emit Purchased(id, msg.sender, r.seller, listingId, rid, r.fileKey, r.provider, r.price, r.platformBps, r.providerBps);

        // interactions: immediate three-way split (any failure reverts the whole purchase — no partial splits)
        if (platformFee > 0) {
            (bool okTreasury, ) = treasury.call{value: platformFee}("");
            if (!okTreasury) revert TransferFailed();
        }
        if (providerFee > 0) {
            (bool okProvider, ) = r.providerPayout.call{value: providerFee}("");
            if (!okProvider) revert TransferFailed();
        }
        (bool okSeller, ) = r.seller.call{value: sellerNet}("");
        if (!okSeller) revert TransferFailed();
    }

    /// Rate (positive/negative, changeable): actual buyers only; seller==buyer
    /// can never rate; NO delivery precondition (an undelivered buyer may leave
    /// a negative rating). Changing a vote subtracts the old one before adding
    /// the new (including cross-service migration), so votes cannot be stacked.
    /// Resubmitting the same vote is an idempotent no-op. Gas is paid by the
    /// rater (the UI states this up front).
    function rate(uint256 orderId, bool positive) external {
        Order storage o = _orders[orderId];
        if (o.buyer == address(0)) revert NotPurchased();
        if (o.buyer != msg.sender) revert NotBuyer();
        if (o.buyer == o.seller) revert SelfRating();
        bytes32 lid = listingIdOf(o.seller, o.fileKey);
        Vote storage v = votes[lid][msg.sender];
        int8 newChoice = positive ? int8(1) : int8(-1);
        if (v.choice == newChoice) return; // idempotent: resubmitting the same vote doesn't touch counters
        // subtract the old vote: product totals + the service dimension of the OLD order's snapshot provider
        if (v.choice == 1) {
            productUp[lid]--;
            serviceUp[lid][_orders[v.orderId].provider]--;
        } else if (v.choice == -1) {
            productDown[lid]--;
            serviceDown[lid][_orders[v.orderId].provider]--;
        }
        // add the new vote: product totals + the service dimension of the CURRENT order's snapshot provider (a cross-service vote change migrates)
        if (positive) {
            productUp[lid]++;
            serviceUp[lid][o.provider]++;
        } else {
            productDown[lid]++;
            serviceDown[lid][o.provider]++;
        }
        v.choice = newChoice;
        v.orderId = orderId;
        emit Rated(lid, msg.sender, orderId, positive, productUp[lid], productDown[lid]);
    }

    // ---- service ----

    /// Provider revocation: only the current revision's snapshot provider may
    /// revoke — blocks NEW purchases of this listing; delivery authority for
    /// already-paid orders is preserved (the provider can still markKeySent
    /// existing orders). A service cannot unilaterally change the payout
    /// recipient to hijack an existing listing — changing the share/payout =
    /// the seller opens a new revision + a new attestation.
    function revoke(bytes32 listingId) external {
        uint256 rid = currentRevision[listingId];
        if (rid == 0) revert NotListed();
        Revision storage r = _revisions[listingId][rid];
        if (msg.sender != r.provider) revert NotProvider();
        if (!r.revoked) {
            r.revoked = true;
            emit ProviderRevocation(listingId, rid);
        }
    }

    // ---- owner ----

    function setPlatformBps(uint16 platformBps_) external {
        if (msg.sender != owner) revert NotOwner();
        if (platformBps_ > MAX_PLATFORM_BPS) revert BpsTooHigh(platformBps_, uint16(MAX_PLATFORM_BPS));
        platformBps = platformBps_;
        emit PlatformBpsUpdated(platformBps_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    /// EIP-712 provider attestation verification: the domain binds chainId +
    /// this contract (signatures from the wrong chain/contract are invalid);
    /// the struct binds seller/fileKey/revision/quote/providerPayout/
    /// providerBps/termsHash/expiry. The seller cannot accept an order on the
    /// service's behalf (recovered must equal the provider itself).
    function _verifyAttestation(
        address seller,
        bytes32 fileKey,
        uint96 price,
        address provider,
        address providerPayout,
        uint16 providerBps,
        bytes32 termsHash,
        uint64 expiry,
        bytes calldata attestation
    ) private view {
        if (attestation.length != 65) revert BadAttestation();
        uint256 rid = revisionCount[listingIdOf(seller, fileKey)] + 1; // the revision this call will create
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(ATTESTATION_TYPEHASH, seller, fileKey, rid, price, providerPayout, providerBps, termsHash, expiry))
            )
        );
        address recovered = ecrecover(digest, uint8(attestation[64]), bytes32(attestation[0:32]), bytes32(attestation[32:64]));
        // recovered == 0 (invalid signature) can never equal provider (the caller already requires provider != 0)
        if (recovered != provider) revert BadAttestation();
    }
}
