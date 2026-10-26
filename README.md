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

## Repository layout

```
frontend/               Frontend (Vite + React + TS; build output is fully static)
contracts/              FileRegistry v1 / v2 (Solidity) + mainnet deployments (deployments.json)
scripts/
  verify/               Read-only checks of public endpoints and on-chain fees (no tx, no signing)
  poc/                  End-to-end protocol scripts: pack & publish / scan & retrieve / account generation (shared lib)
  p2/                   FileRegistry v1 compile / deploy / interaction; XDM cross-domain funding helper
  p3/                   FileRegistryV2 compile / deploy / semantic selftest / v1→v2 migration
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
```

## Deployed contracts (Auto-EVM mainnet, chainId 870)

| Contract | Address | Status |
|---|---|---|
| FileRegistry v2 | `0x79a22e5dc2e0613d8e9b491a1a51038b9197b185` | Active; register charges a dev fee: `max(0.01 AI3, size × ~1.05e11 wei)`, overpayment is refunded |
| FileRegistry v1 | `0x1751f7534b85417da6e093a2e85b4b7b90ee2e4a` | Frozen, read-only |

Deployment records (tx / block) live in [contracts/deployments.json](contracts/deployments.json); explorer: <https://explorer.auto-evm.mainnet.autonomys.xyz>

## Notes

- **On-chain data is public by default** — anyone can read it. "My files" is index ownership, not access control; do not upload anything you don't want public.
- **Public RPCs are rate-limited** — the scripts throttle and back off; do not hammer public nodes with concurrency.
- **Confirmation policy** — publishes confirm at 12-block depth + canonical check (Autonomys testnet finality lag can reach 15 days; never wait for finalized).
- **Real costs** — the frontend and scripts operate on mainnet and spend real AI3; the contracts are unaudited — verify with small amounts first.

## License

[MIT](LICENSE)
