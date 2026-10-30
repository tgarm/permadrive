// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Paywall — the PermaDrive paid-download escrow. Digital-goods mode:
///         buying grants the file (no DRM; leak tracing / per-buyer copies are
///         left for later).
/// @notice Payment and delivery are bound: buyer funds sit in escrow until the
///         seller is paid out on confirmation, or the buyer is refunded when
///         delivery never happens. Every state transition is triggered by an
///         interested party (no keeper, no automatic transfers). The dev fee
///         is taken only at confirmReceipt (Released) → refunds are always
///         full. key = keccak256(manifestCid), the same digest the registry
///         uses; on-chain data is public, so the file key travels as ciphertext
///         over the Mailbox message channel (pdgrant) — this contract only
///         carries funds and state.
/// @dev Seller earnings settle into a pull-style credits ledger (a failed push
///      to an arbitrary address can never wedge the contract); refunds push to
///      the buyer themselves (msg.sender). Single-step transferOwnership, no
///      upgradeability, no pause.
contract Paywall {
    enum State { None, Escrowed, Delivered, Released, Refunded }

    struct Listing {
        address seller;
        uint96 price; // 0 = not listed
    }

    struct Deal {
        address buyer;
        uint96 price; // snapshot at purchase (later price edits don't affect escrowed deals)
        State state;
        uint64 purchasedAt;
        uint64 deliveredAt;
    }

    error NotSeller();
    error NotBuyer();
    error NotListed();
    error AlreadyPaid();
    error InsufficientPayment(uint256 required, uint256 provided);
    error BadState();
    error NothingToWithdraw();
    error FeeTooHigh();
    error ZeroPrice();
    error NotOwner();

    event Listed(address indexed seller, bytes32 indexed key, uint96 price);
    event Unlisted(address indexed seller, bytes32 indexed key);
    event Purchased(bytes32 indexed key, address indexed buyer, uint96 price);
    event Delivered(bytes32 indexed key, address indexed buyer);
    event Released(bytes32 indexed key, address indexed buyer, uint256 net, uint256 fee);
    event Refunded(bytes32 indexed key, address indexed buyer, uint256 amount);
    event Withdrawn(address indexed seller, uint256 amount);
    event FeeUpdated(uint256 feeBps);

    address public immutable treasury;
    address public owner;
    /// dev fee in basis points (price×feeBps/1e4); default 1000 = 10%
    uint256 public feeBps;
    /// fee basis-point hard cap (20%) against unilateral raises
    uint256 public constant MAX_FEE_BPS = 2000;
    /// delivery timeout (a buyer may refund once Escrowed exceeds it)
    uint64 public immutable deliveryTimeout;
    /// grace period (within it after delivery the buyer can still refund; after it the seller can release)
    uint64 public immutable gracePeriod;

    mapping(bytes32 => Listing) public listings;
    /// deal = keccak256(key, buyer) — one deal per buyer
    mapping(bytes32 => Deal) private _deals;
    mapping(address => uint256) public credits;

    constructor(address treasury_, uint64 deliveryTimeout_, uint64 gracePeriod_) {
        require(deliveryTimeout_ > 0 && gracePeriod_ > 0);
        treasury = treasury_;
        owner = msg.sender;
        feeBps = 1000;
        deliveryTimeout = deliveryTimeout_;
        gracePeriod = gracePeriod_;
    }

    // ---- seller ----

    function setPrice(bytes32 key, uint96 price) external {
        if (price == 0) {
            if (listings[key].seller == address(0)) revert NotListed();
            if (listings[key].seller != msg.sender) revert NotSeller();
            delete listings[key];
            emit Unlisted(msg.sender, key);
            return;
        }
        listings[key] = Listing(msg.sender, price);
        emit Listed(msg.sender, key, price);
    }

    function markDelivered(bytes32 key, address buyer) external {
        Deal storage d = _deals[dealId(key, buyer)];
        if (listings[key].seller != msg.sender) revert NotSeller();
        if (d.state != State.Escrowed) revert BadState();
        d.state = State.Delivered;
        d.deliveredAt = uint64(block.timestamp);
        emit Delivered(key, buyer);
    }

    /// After the grace period the seller releases funds
    function release(bytes32 key, address buyer) external {
        Deal storage d = _deals[dealId(key, buyer)];
        if (listings[key].seller != msg.sender) revert NotSeller();
        if (d.state != State.Delivered) revert BadState();
        if (block.timestamp < d.deliveredAt + gracePeriod) revert BadState();
        _settle(key, d, buyer);
    }

    function withdraw() external {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }

    // ---- buyer ----

    function purchase(bytes32 key) external payable {
        Listing memory l = listings[key];
        if (l.seller == address(0) || l.price == 0) revert NotListed();
        if (msg.value < l.price) revert InsufficientPayment(l.price, msg.value);
        bytes32 id = dealId(key, msg.sender);
        // one deal per buyer; only the terminal Refunded state allows re-ordering
        // (buying again after a refund is a normal expectation)
        if (_deals[id].state != State.None && _deals[id].state != State.Refunded) revert AlreadyPaid();
        _deals[id] = Deal(msg.sender, l.price, State.Escrowed, uint64(block.timestamp), 0);
        emit Purchased(key, msg.sender, l.price);
        // checks-effects-interactions: overpayment is refunded immediately
        (bool refundOk, ) = msg.sender.call{value: msg.value - l.price}("");
        require(refundOk);
    }

    /// Buyer confirmation (allowed from Escrowed or Delivered — the buyer may release at will)
    function confirmReceipt(bytes32 key) external {
        Deal storage d = _deals[dealId(key, msg.sender)];
        if (d.state != State.Escrowed && d.state != State.Delivered) revert BadState();
        _settle(key, d, msg.sender);
    }

    /// Buyer refund: never delivered past the timeout (Escrowed ≥ deliveryTimeout)
    /// or within the grace period after delivery (Delivered < gracePeriod) → full refund
    function refund(bytes32 key) external {
        Deal storage d = _deals[dealId(key, msg.sender)];
        if (d.state == State.Escrowed) {
            if (block.timestamp < d.purchasedAt + deliveryTimeout) revert BadState();
        } else if (d.state == State.Delivered) {
            if (block.timestamp >= d.deliveredAt + gracePeriod) revert BadState();
        } else {
            revert BadState();
        }
        uint256 amount = d.price;
        d.state = State.Refunded;
        emit Refunded(key, msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }

    // ---- owner / views ----

    function setFeeBps(uint256 feeBps_) external {
        if (msg.sender != owner) revert NotOwner();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    function dealId(bytes32 key, address buyer) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(key, buyer));
    }

    function deal(bytes32 key, address buyer) external view returns (Deal memory) {
        return _deals[dealId(key, buyer)];
    }

    /// Released settlement: the fee goes straight to treasury, the net amount into credits (pull)
    function _settle(bytes32 key, Deal storage d, address buyer) private {
        d.state = State.Released;
        uint256 price = d.price;
        uint256 fee = (price * feeBps) / 1e4;
        uint256 net = price - fee;
        credits[listings[key].seller] += net;
        emit Released(key, buyer, net, fee);
        if (fee > 0) {
            (bool feeOk, ) = treasury.call{value: fee}("");
            require(feeOk);
        }
    }
}
