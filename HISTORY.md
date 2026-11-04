# PermaDrive — project history

Current product documentation lives in the [README](README.md). This file records how
the project got here: milestones, contract deployment history and security
post-mortems. Contract addresses and transaction hashes are on Auto EVM mainnet
(chainId 870) unless stated otherwise; full deployment records (tx / block / deployer)
live in [contracts/deployments.json](contracts/deployments.json).

## Timeline

- **2026-10-24/25 — protocol validated on mainnet.** Feasibility study of the official
  AutoDrive service layer; the raw publish path (`system.remark` extrinsics carrying
  IPLD nodes) was validated directly against the chain: a 200 KB sample was published
  and retrieved with a matching sha256, third-party published files were recovered the
  same way, and the first full browser end-to-end run published a 1 MB file in a single
  batched extrinsic and reassembled it from chain data with a matching sha256.
- **2026-10-26 — directory layer deployed.** FileRegistry v1 and v2 went live on Auto
  EVM; cross-device recovery closed the loop in a real browser (fresh origin, wallet
  signature only, files re-downloaded and sha256-verified). v2 introduced the dev-fee
  model: `max(0.01 AI3, size × feePerByte)`, anchored to 10% of the on-chain storage
  fee and re-anchored as the storage fee drifts. The static deployments of
  permadrive.ai3.land and the [ai3.land](https://ai3.land/) family page went live.
- **2026-10-27 — versioned notes and the encrypted vault** shipped and were accepted on
  mainnet (envelope encryption: a random data key wrapped twice — by a passphrase
  keystore file and by an EVM wallet signature).
- **2026-10-29 — Mailbox deployed**: event-driven on-chain private messages
  (end-to-end encrypted envelopes, ciphertext ≤ 8 KiB).
- **2026-10-30 — Paywall v1 deployed and frozen within days.** An escrow-based
  paid-download contract; a security review right after deployment found a
  seller-overwrite flaw (post-mortem below) and the product direction moved to direct
  sales. The frontend write path was frozen on 2026-10-31 and the paid-download flow
  was removed entirely the same day.
- **2026-10-31 — DirectSales deployed**: no escrow and no platform refunds — the
  purchase transaction pays the seller and the 10% platform fee in the same
  transaction, with on-chain ratings. Accepted on mainnet the same day (real purchase,
  key delivery over the private-message channel, ratings).
- **2026-10-31 / 2026-11-01 — PublicPublisher deployed** and sharing was accepted on
  mainnet: three-state file sharing, no-wallet share links with integrity-checked
  downloads, and the wallet-free Discover feed built from the `Published` event log.
- **2026-11-02/03 — large files**: the publish budget was calibrated on mainnet to
  ~2 MiB per signature (block limits are tighter than gateway limits); an 8 MiB
  encrypted sample was published in four batches and closed the loop end-to-end —
  recovered from chain, decrypted, sha256-matched on-chain and off, and registered in
  the directory.
- **2026-11-03 — FileState deployed**: per-file hidden flags and generic `bytes32`
  properties on Auto EVM; file versions are grouped by on-chain block heights without
  extra on-chain metadata. Delete was replaced by hide — published data is permanent by
  design, so removal from your file list must not be confused with removal from the
  network (which is impossible).

## Paywall v1 security post-mortem (2026-10-30)

A design review found that anyone could overwrite an existing listing (the non-zero
`setPrice` branch had no ownership check) and that settlements read the *current*
listing seller, so an attacker could re-list a paid key, mark it delivered and drain
escrowed funds without ever holding the file key. The contract has no upgrade path.

No funds were ever at risk: the review happened before any public launch, and a
read-only inventory of both deployed instances (main and test) confirmed zero active
orders, zero escrowed credits and zero balances. The frontend write path was frozen
immediately (the four escrow-write entry points reject unconditionally), the paid-download
UI was removed, and `contracts/PaywallV2.sol` was written to fix the model.

The frontend activates nothing Paywall-related anymore; v1 keeps its refund /
confirm-receipt / withdraw entries for any existing orders (there are none).

## Paywall v2 — designed, not deployed

The redesign removes the overwrite class of bugs entirely: seller-namespace listings
(`listingId = keccak256(seller, key)`, so one seller cannot preempt another), immutable
order snapshots (seller / price / feeBps captured at purchase) with independent order
ids, and `purchase(key, seller, maxPrice)` with a buyer-side price bound. An offline
adversarial suite (43 assertions, local ganache) covers overwrite, front-running,
reprice / delist / relist and fund conservation.

Deployment is deliberately paused: the escrow model was replaced by direct sales
([DirectSales](contracts/DirectSales.sol)), which needs no refunds and no platform
custody at all. PaywallV2 remains a designed, tested fallback.

## PublicPublisher — why the dust price

The original sharing design sold the file to the publisher contract for 1 wei in the
same transaction that emitted the `Published` event. On Auto EVM this is physically
impossible: the domain enforces an account-existence deposit of 1e12 shannon, and any
transfer that would leave a receiver's balance below it is rejected — a fresh contract
receiving 1 wei reverts. The dust price was therefore set to 1e13 shannon (10× the
deposit). The publisher contract refunds 90% in the same transaction, so the effective
cost of publishing is the 1e12 shannon platform fee plus gas.
