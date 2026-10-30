# PermaDrive

> PermaDrive (permanent + drive) — a wallet-native permanent storage client for the Autonomys Network. Pure frontend + optional EVM contracts, no required backend.

Files are packed into IPLD DAGs in the browser and published directly to the Autonomys consensus chain as `system.remark` extrinsics; the farmer network archives them permanently. No accounts, no API keys, no backend.

## How it works

1. **Pack** — the file is packed into an IPLD DAG (64 KiB nodes) in the browser, byte-compatible with the official AutoDrive backend's `onchainPublisher`
2. **Publish** — nodes are submitted as `system.remark` extrinsics (batched into a single `utility.batch`), paying the on-chain byte fee once for permanent archival by the farmer network
3. **Retrieve** — the object-mapping indexer locates the nodes → `chain_getBlock` fetches them by height → local reassembly with sha256 verification
4. **Register (optional)** — file fingerprints are registered on the FileRegistry contract on Auto-EVM (chainId 870), binding ownership to the wallet address and enabling cross-device recovery

## Features

- **Wallet-native identity** — sign in with a Substrate extension wallet (Talisman / SubWallet / polkadot.js); an EVM wallet handles registry operations on Auto-EVM
- **Permanent storage, pay per use** — pay the on-chain byte fee directly (~2.1 AI3/MB, about half the official AutoDrive price, with no 90-day credit expiry)
- **No required backend** — the build output is fully static and hostable anywhere; all dependencies (RPC, indexer) are permissionless public infrastructure with CORS enabled (browser-direct)
- **Manifest as proof** — a single JSON manifest describes everything needed for retrieval; export / import / share it
- **Cross-device recovery** — on a new device, the same wallet signature recovers the full file index from the on-chain registry and re-downloads the files
- **Encrypted files** — opt-in upload encryption: a random data key encrypts the file (AES-256-GCM) before the standard DAG packing, and the key is wrapped with your EVM wallet signature plus an optional passphrase; downloads decrypt automatically with a passphrase dialog as the fallback. Filenames and sizes stay public; the content is yours only (manifest v2, `pdenc-v1`)
- **On-chain private messages** — end-to-end encrypted mail between addresses (x25519-xsalsa20-poly1305, MetaMask-compatible envelopes or locally derived keypairs). Who talks to whom, when, and ciphertext length are public; only the content is private. Your encryption key is announced automatically when the wallet connects
- **Paid downloads (escrow)** — sell encrypted files for AI3: payment is held in an escrow contract and released on the buyer's confirmation (or refunded on delivery timeout / within the grace period); the file key is delivered as ciphertext over the private-message channel. Digital-goods mode: buying grants the file itself, there is no DRM
- **Versioned notes** — append-only text records; every save publishes a new immutable version and registers it in the on-chain registry (the version chain survives any device; unchanged content re-saving is free under content addressing)
- **Encrypted vault** — a password manager whose entries are AES-256-GCM encrypted as one envelope before publishing; the data key is wrapped twice — by your passphrase (exportable keystore file, the universal recovery path) and by an EVM wallet signature (passphrase-free unlock on new devices). Only ciphertext ever reaches the chain. Full principles, threat model and do-it-yourself verification: [VAULT.md](VAULT.md)

## Repository layout

```
frontend/               Frontend (Vite + React + TS; build output is fully static)
contracts/              FileRegistry v1 / v2 (Solidity) + mainnet deployments (deployments.json)
scripts/
  verify/               Read-only checks of public endpoints and on-chain fees (no tx, no signing)
  poc/                  End-to-end protocol scripts: pack & publish / scan & retrieve / account generation (shared lib)
  p2/                   FileRegistry v1 compile / deploy / interaction; XDM cross-domain funding helper
  p3/                   FileRegistryV2 compile / deploy / semantic selftest / v1→v2 migration; vault crypto format selftest
  p4/                   favicon PNG generator + reproducibility check; file-encryption selftest; Mailbox deploy + selftest; Paywall deploy + full-state-machine selftest
```

## Quick start (frontend)

Requires Node.js 22+.

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # static output → dist/ (deployable to any static host)
```

- Connect an extension wallet, or use "Local key (dev)" with a mnemonic (memory only, lost on refresh)
- Upload: pick a file → confirm the fee → sign → 12-block confirmation → background DSN archiving watch
- Download: nodes are fetched from the chain and reassembled, sha256 verified automatically; manifests can be exported/imported

## Deploy (Vercel)

The repo root ships with a [`vercel.json`](vercel.json) (install/build commands and output directory point at the `frontend/` subdirectory) — after pushing to GitHub, **no dashboard configuration is needed**:

1. Push the code to GitHub
2. Import the repo at [vercel.com/new](https://vercel.com/new) → Deploy (change nothing)
3. Custom domain (optional): Vercel project Settings → Domains, add your domain (e.g. `permadrive.ai3.land`) and add the CNAME record at your DNS provider

The frontend has no routing, no environment variables and no API keys; the build output is fully static — GitHub Pages / IPFS / Cloudflare Pages work equally well (`vite.config.ts` already uses relative asset paths, `base: './'`).

## Scripts

Run `npm install` in each script directory first; the signing account is read from the `CHAIN_MNEMONIC` environment variable or `scripts/poc/.env` (template: `scripts/poc/.env.sample`; generate a fresh account with `npm run gen-account`).

```bash
# Publish / retrieve on the protocol level (see scripts/poc/README.md)
cd scripts/poc
npm install
cp .env.sample .env       # fill in CHAIN_MNEMONIC; fund the address with a little AI3
npm run publish           # pack the default 200KB sample → utility.batch → manifest
npm run retrieve          # indexer + chain_getBlock → reassemble → sha256 check

# Read-only checks (no account needed)
cd ../verify && npm install
node rpc-check.mjs && node indexer-check.mjs && node fee-estimate.mjs

# Contract toolchain (Auto-EVM mainnet; needs CHAIN_MNEMONIC with gas on the EVM side)
cd ../p3 && npm install
npm run compile
npm run selftest          # semantic selftest against the deployed contract (idempotent)
npm run vault-crypto      # offline vault envelope/keystore crypto selftest (no account, no cost)
```

## Deployed contracts (Auto-EVM mainnet, chainId 870)

| Contract | Address | Status |
|---|---|---|
| FileRegistry v2 | `0x79a22e5dc2e0613d8e9b491a1a51038b9197b185` | Active; register charges a dev fee: `max(0.01 AI3, size × ~1.05e11 wei)`, overpayment is refunded |
| Mailbox | `0x3446abe95edc17e4056a28d7c5fb10d579395200` | Active; on-chain private messages — `announceEncryptionKey` + `send` (permissionless, ciphertext ≤ 8 KiB) |
| Paywall v1 | `0xb51be7a5cc1a03fd51892d9db1fc942aa164405a` | **Frozen, read-only** (seller-overwrite flaw, 2026-10-30): existing orders keep refund / confirm-receipt / withdraw entries; new listings and purchases are disabled |
| Paywall v1 (test) | `0x4db00db74769a0e8d38654bbe20144668c105acf` | Frozen, read-only (same flaw) |
| Paywall v2 | see `contracts/deployments.json` after deployment | Order-model redesign: seller-namespace listings (`listingId = keccak256(seller, key)`), immutable order snapshots (seller/price/feeBps) with independent orderIds, `purchase(key, seller, maxPrice)`; an offline adversarial suite (43 assertions, local ganache) covers overwrite, front-running, reprice/delist/relist and fund conservation. Deployment is a deliberate separate step |
| FileRegistry v1 | `0x1751f7534b85417da6e093a2e85b4b7b90ee2e4a` | Frozen, read-only |

Deployment records (tx / block) live in [contracts/deployments.json](contracts/deployments.json); explorer: <https://explorer.auto-evm.mainnet.autonomys.xyz>

## Notes

- **On-chain data is public by default** — anyone can read it. Plain "My files" uploads and Notes publish in the clear (Notes are plaintext by design; private text belongs in the Vault, whose envelope is ciphertext, or in an encrypted-file upload, whose content is ciphertext). File encryption protects the content only — filenames, sizes and ciphertext stay public. Index ownership is not access control; do not publish anything you don't want public.
- **The vault keystore is the only universal recovery path** — wallet-signature unlock depends on reproducible signatures (verified for local EVM keys; most extension wallets work, some may not). Losing both the wallet AND the keystore file means the ciphertext stays on-chain forever but can never be opened.
- **Public RPCs are rate-limited** — the scripts throttle and back off; do not hammer public nodes with concurrency.
- **Confirmation policy** — publishes confirm at 12-block depth + canonical check (Autonomys testnet finality lag can reach 15 days; never wait for finalized).
- **Paywall v1 security note (2026-10-30)** — a design review found that anyone could overwrite an existing listing (the non-zero `setPrice` branch had no ownership check) and that settlements read the *current* listing seller, so an attacker could re-list a paid key, mark it delivered and drain escrowed funds without ever holding the file key. The contract has no upgrade path; v1 is frozen read-only (existing orders keep refund / confirm / withdraw), and `contracts/PaywallV2.sol` fixes the order model (seller namespace, immutable order snapshots, independent orderIds, `maxPrice` bound). The frontend activates v2 once its address is configured in Settings.
- **Publish recovery** — a publish whose confirmation does not finish (timeout / lost response) is never auto-resent; the signed tx hashes and rebuild metadata are persisted locally and the files page offers a hash-based "verify" that rebuilds the manifest without republishing.
- **Real costs** — the frontend and scripts operate on mainnet and spend real AI3; the contracts are unaudited — verify with small amounts first.

## Ecosystem

More from the same family — open-source, pure-frontend tools for Autonomys:

- **[XDM Bridge](https://xdm-bridge.ai3.land/)** — cross-domain AI3 transfers between the consensus chain and Auto EVM · [source](https://github.com/tgarm/ai3-xdm-bridge)
- **[ai3.land](https://ai3.land/)** — the family's landing page

## License

[MIT](LICENSE)
