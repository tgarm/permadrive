# scripts/poc — P0 PoC (end-to-end round trip)

End-to-end round trip at the protocol layer: **pack → system.remark → indexer lookup →
chain_getBlock retrieval → decode and assemble**, with the round-trip data sha256-identical.

## Verified results (2026-10-25)

- **P0 acceptance passed (own-publish round trip on mainnet)**: 200KB sample (5 nodes) published in a single `utility.batch`
  → block **#10,126,067**, tx `0x307772b5b6f7fb06…`, actual cost **0.4121 AI3**
  → **~100s** after publishing, all 5/5 nodes had object mappings on the indexer
  → chain_getBlock retrieval → assembled **sha256 exactly matches the original file**.
  Artifacts: `out/1792920923287-manifest.json` (retrieval record), `out/retrieved-poc-sample-200000.bin`
- **Offline round trip**: pack↔assemble bit-identical (50K/70K/200K/250K, single-node and multi-chunk)
- **Equivalent to the official pipeline**: repacking the mainnet gateway sample `xl1-mainnet-manifest-v812.json.br`
  under its own name yields an identical root CID; all 4 nodes hit on the mainnet indexer
- **Mainnet third-party retrieval round trip** (no account needed): `batch-scan` captured AutoDrive publish blocks
  (#10,120,359, #10,121,446-47) → `scan-live` assembled 2 complete files (v307/v814 manifests,
  byte counts exactly match metadata.size) → all nodes confirmed DSN-archived by the indexer.
  Output in `out/live-*`

### Engineering notes from the first run (fixed in code since; listed so they are not re-stepped on)

- A block scan hitting zero hashes/empty blocks (fork boundaries) once misjudged "submission failed" →
  the fallback resubmitted the same-nonce tx and got banned by Subspace's `(signer,nonce)` dedup (1012).
  **Whether submission succeeded is judged by the node's response; if the scan fails, check
  `author_pendingExtrinsics`/scan blocks first — do not resubmit**
- `extractRemarkNodes` must recognize both top-level remarks (AutoDrive's per-tx style) and remarks
  nested inside `utility.batch` (our packing style)
- The first-order fee estimate formula matches measurement (0.4121 vs 0.42 AI3)

> **Network status (measured 2026-10-25)**: the official testnet taurus has been retired
> (`rpc.taurus.subspace.foundation` DNS withdrawn) and migrated to **chronos**
> (`rpc.chronos.autonomys.xyz`, continuation of the taurus chain, continuous heights). chronos traits:
> blocks are still produced (~14s/block), but **finality can lag by up to 15 days** (low-participation
> Nakamoto probabilistic confirmation) → the scripts always scan the best chain and confirm publishes
> by a 12-block depth rather than waiting for finalized. Nobody currently publishes on chronos
> (~7,000 blocks sampled); AutoDrive publishing on mainnet is active (hourly bursts). Endpoints can be
> overridden with the `CHAIN_RPC` / `CHAIN_INDEXER` environment variables.

```bash
npm install

# Account (first time): generate an sr25519 mnemonic + address, written to CHAIN_MNEMONIC
# in this directory's .env (gitignored; the same mnemonic works on any Autonomys network)
npm run gen-account
# SS58 prefix: mainnet=6094 (addresses start with su…, use this for mainnet transfers), taurus/chronos=6093 (so…)
# → Back up the mnemonic in .env; funding the mainnet address with ≈0.5 AI3 is enough to run the 200KB sample

# Publish (own files): pack → utility.batch(remark×N) → 12-block confirmation → manifest
npm run publish            # generates a deterministic 200KB sample by default; or npm run publish -- <file path>

# Retrieve: poll the indexer for mappings → extract nodes via chain_getBlock → assemble → compare sha256
npm run retrieve           # defaults to the newest manifest in out/

# Retrieval-path validation without test tokens: scan blocks and assemble files published by
# third parties (AutoDrive et al.)
node scan-live.mjs --blocks 80 [--at height]
node batch-scan.mjs 5000   # batch-scan blocks to locate dag-pb remark activity
```

## Networks and funding

- **Mainnet recommended** (where the publish round trip actually happens):
  `CHAIN_RPC=https://rpc.mainnet.subspace.foundation/ws CHAIN_INDEXER=wss://indexer.mainnet.autonomys.xyz/ws npm run publish`
  — 200KB ≈ 0.42 AI3 (≈$0.002), mainnet finality is normal, the indexer is online, AutoDrive publishing is active.
- chronos testnet (the scripts' default endpoints): the consensus-chain token has no public faucet
  (the official faucet only covers the Auto-EVM side), so it only suits read-only verification; taurus has been retired.

## Design notes

- **Public RPCs are rate-limited**: all chain calls go through the throttling in `lib/rpc.mjs`
  (default ≥1.4–1.6s interval) plus exponential backoff; batch block scans use JSON-RPC batch
  (one POST fetches a batch of blocks). No WS subscriptions. Tunable via
  `RPC_MIN_INTERVAL_MS` / `BATCH_MIN_INTERVAL_MS`.
- **Publish format**: `system.remark(compactAddLength(encodeNode(node)))`, exactly matching the
  AutoDrive backend's `onchainPublisher`; multiple nodes go in one signed `utility.batch`,
  falling back to per-node txs on failure.
- **Confirmation strategy**: chronos finality lags → wait 12 subsequent blocks plus a canonical hash
  check (the same as AutoDrive's confirmationDepth policy); the same applies on mainnet
  (could be strengthened to finalized there).
- **indexer**: `get_object_mappings` queried in batches, falling back to per-hash queries when the
  whole batch misses (the same behavior as the official backend); a mapping returns
  `[hash(blake3 hex), pieceIndex, pieceOffset]`, **without blockNumber** — which block a node lives in
  comes from our own publish record (the manifest); retrieving a stranger's file relies on block
  scanning (demonstrated by scan-live.mjs).
- **Assembly traversal**: level-by-level link-order expansion identical to the official
  file-retriever; a node's `IPLDNodeData.data` is the file bytes; single-node files take the root's
  data directly.

## Outputs

- `out/*-manifest.json` — root CID, node table (CID + blake3), tx/block locations
- `out/retrieved-*` — files assembled from on-chain retrieval (sha256-compared with the original)
- `out/live-*` — third-party files assembled from the chain by the scan
