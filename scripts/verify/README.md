# scripts/verify — feasibility verification scripts

Read-only verification of Autonomys public endpoints and on-chain fees. Everything is **read-only**
(nothing goes on chain, nothing is signed).

```bash
npm install
node rpc-check.mjs        # mainnet RPC availability + byteFee + recent-block extrinsic census
node indexer-check.mjs    # the public indexer's get_object_mappings response
node fee-estimate.mjs     # publish cost estimate (arg: bytes, default 1MiB)
```

## Known caveats

- Public RPCs are rate-limited: running repeatedly in a row may produce empty responses; wait a few seconds and rerun
- indexer hashes must be **bare hex (no 0x prefix)**; with a 0x prefix everything just returns not found (measured 2026-10-25)
- `indexer-check.mjs`'s default CID is a real AutoDrive file DAG root and currently returns a real mapping
- Requires Node.js ≥ 20
