// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PaywallV2 — PermaDrive paid-download escrow, v2 (order-model redesign).
/// @notice Differences from v1 (v1 is frozen read-only; fixing the source cannot
///  repair a deployed instance):
///  1. Seller namespace: listingId = keccak256(seller, key) — no address can
///     overwrite someone else's listing or front-run a shared key; several
///     sellers can list the same file (same key) independently.
///  2. Order snapshot: Order immutably stores seller/price/feeBps; permissions
///     and settlement read the order — delisting/relisting/repricing only
///     affects NEW orders, never funds already escrowed.
///  3. Independent increasing orderId: repurchasing after a refund creates a
///     new order; history is never overwritten.
///  4. purchase must name the seller and carry a maxPrice bound, preventing
///     price changes between viewing and signing.
///  5. All events carry orderId (and seller) — history no longer depends on
///     the current listing.
/// @dev key = keccak256(manifestCid), same derivation as FileRegistry's
///      manifestCidKey (v1 Paywall used the same). The file key is still
///      delivered encrypted via an end-to-end encrypted Mailbox message
///      (pdgrant); the contract only carries funds and state. Seller proceeds
///      use pull-style credits; refunds push to the buyer. No upgrade, no
///      pause (same as v1); ETH-moving paths carry a reentrancy lock.
contract PaywallV2 {
    enum State { None, Escrowed, Delivered, Released, Refunded }

    struct Order {
        address seller;
        address buyer;
        uint96 price; // snapshot at purchase (reprice/delist never affects escrowed orders)
        uint16 feeBps; // snapshot at purchase (later owner fee changes don't affect existing orders)
        State state;
        uint64 purchasedAt;
        uint64 deliveredAt;
    }

    error NotSeller();
    error NotBuyer();
    error NotListed();
    error BadState();
    error PriceTooHigh(uint96 listed, uint96 maxPrice);
    error InsufficientPayment(uint256 required, uint256 provided);
    error NothingToWithdraw();
    error FeeTooHigh();
    error NotOwner();
    error Reentrant();

    event Listed(address indexed seller, bytes32 indexed listingId, bytes32 key, uint96 price);
    event Unlisted(address indexed seller, bytes32 indexed listingId, bytes32 key);
    event Purchased(uint256 indexed orderId, address indexed buyer, address indexed seller, bytes32 key, uint96 price);
    event Delivered(uint256 indexed orderId);
    event Released(uint256 indexed orderId, uint256 net, uint256 fee);
    event Refunded(uint256 indexed orderId, uint256 amount);
    event Withdrawn(address indexed seller, uint256 amount);
    event FeeUpdated(uint256 feeBps);

    address public immutable treasury;
    address public owner;
    /// dev fee in basis points (price×feeBps/1e4); default 1000 = 10%, aligned with the storage dev fee
    uint16 public feeBps;
    /// hard cap on fee basis points (20%) against rug pulls
    uint256 public constant MAX_FEE_BPS = 2000;
    /// delivery timeout (buyer may refund once Escrowed exceeds this)
    uint64 public immutable deliveryTimeout;
    /// grace period (buyer may still refund within this after delivery; seller may release after)
    uint64 public immutable gracePeriod;

    /// seller namespace: listingId = listingIdOf(seller, key) => price (0 = not listed)
    mapping(bytes32 => uint96) public listings;
    /// order = independent increasing id; Refunded/Released are terminal — repurchase
    /// creates a new order and never overwrites history
    mapping(uint256 => Order) public orders;
    uint256 public orderCount;
    mapping(address => uint256) public credits;

    /// minimal reentrancy lock (defense in depth; transitions already follow checks-effects-interactions)
    uint256 private _locked = 1;

    modifier noReentry() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address treasury_, uint64 deliveryTimeout_, uint64 gracePeriod_) {
        require(deliveryTimeout_ > 0 && gracePeriod_ > 0);
        treasury = treasury_;
        owner = msg.sender;
        feeBps = 1000;
        deliveryTimeout = deliveryTimeout_;
        gracePeriod = gracePeriod_;
    }

    // ---- views ----

    function listingIdOf(address seller, bytes32 key) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(seller, key));
    }

    function listingPrice(address seller, bytes32 key) external view returns (uint96) {
        return listings[listingIdOf(seller, key)];
    }

    // ---- seller ----

    /// List/reprice/delist (price=0) only touches msg.sender's own namespace.
    /// Delisting an unlisted key is an idempotent no-op (retry-safe). Already-paid
    /// orders are never affected (they read the order snapshot).
    function setPrice(bytes32 key, uint96 price) external {
        bytes32 lid = listingIdOf(msg.sender, key);
        uint96 prev = listings[lid];
        listings[lid] = price;
        if (price == 0) {
            if (prev != 0) emit Unlisted(msg.sender, lid, key);
        } else {
            emit Listed(msg.sender, lid, key, price);
        }
    }

    function markDelivered(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.seller != msg.sender) revert NotSeller();
        if (o.state != State.Escrowed) revert BadState();
        o.state = State.Delivered;
        o.deliveredAt = uint64(block.timestamp);
        emit Delivered(orderId);
    }

    /// Seller release after the grace period (same semantics as v1, permission by
    /// the order's snapshot seller)
    function release(uint256 orderId) external noReentry {
        Order storage o = orders[orderId];
        if (o.seller != msg.sender) revert NotSeller();
        if (o.state != State.Delivered) revert BadState();
        if (block.timestamp < o.deliveredAt + gracePeriod) revert BadState();
        _settle(orderId, o);
    }

    function withdraw() external noReentry {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }

    // ---- buyer ----

    /// Purchase must name the seller (the same key may have several sellers) and
    /// carry a maxPrice bound: if the on-chain price exceeds maxPrice the call
    /// reverts, protecting against price changes between viewing and signing.
    function purchase(bytes32 key, address seller, uint96 maxPrice) external payable noReentry {
        bytes32 lid = listingIdOf(seller, key);
        uint96 price = listings[lid];
        if (price == 0) revert NotListed();
        if (price > maxPrice) revert PriceTooHigh(price, maxPrice);
        if (msg.value < price) revert InsufficientPayment(price, msg.value);
        uint256 id = ++orderCount;
        orders[id] = Order(seller, msg.sender, price, feeBps, State.Escrowed, uint64(block.timestamp), 0);
        emit Purchased(id, msg.sender, seller, key, price);
        // checks-effects-interactions: overpayment is refunded (buyer's own address/contract may receive)
        if (msg.value > price) {
            (bool refundOk, ) = msg.sender.call{value: msg.value - price}("");
            require(refundOk);
        }
    }

    /// Buyer confirms receipt (Escrowed or Delivered — voluntary payout at any
    /// time); settles to the order's snapshot seller regardless of current listing
    function confirmReceipt(uint256 orderId) external noReentry {
        Order storage o = orders[orderId];
        if (o.buyer != msg.sender) revert NotBuyer();
        if (o.state != State.Escrowed && o.state != State.Delivered) revert BadState();
        _settle(orderId, o);
    }

    /// Buyer refund: undelivered timeout (Escrowed ≥ deliveryTimeout) or within
    /// the grace period after delivery (Delivered < gracePeriod) → full refund
    /// (push to self)
    function refund(uint256 orderId) external noReentry {
        Order storage o = orders[orderId];
        if (o.buyer != msg.sender) revert NotBuyer();
        if (o.state == State.Escrowed) {
            if (block.timestamp < o.purchasedAt + deliveryTimeout) revert BadState();
        } else if (o.state == State.Delivered) {
            if (block.timestamp >= o.deliveredAt + gracePeriod) revert BadState();
        } else {
            revert BadState();
        }
        uint256 amount = o.price;
        o.state = State.Refunded;
        emit Refunded(orderId, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }

    // ---- owner ----

    function setFeeBps(uint16 feeBps_) external {
        if (msg.sender != owner) revert NotOwner();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    /// Released settlement: fee (order's snapshot rate) goes straight to treasury,
    /// net proceeds credited to the order's snapshot seller (pull)
    function _settle(uint256 orderId, Order storage o) private {
        o.state = State.Released;
        uint256 price = o.price;
        uint256 fee = (price * o.feeBps) / 1e4;
        uint256 net = price - fee;
        credits[o.seller] += net;
        emit Released(orderId, net, fee);
        if (fee > 0) {
            (bool feeOk, ) = treasury.call{value: fee}("");
            require(feeOk);
        }
    }
}
