# Combined file storage and recovery

New My Files uploads save encrypted content and recovery information in one consensus-chain transaction. The usual wallet sequence is:

1. Sign an EVM message to set up wallet-based unlocking (no transaction or gas).
2. Sign the same message again to check that signatures are reproducible (no transaction or gas).
3. Sign one consensus transaction saving the encrypted file and recovery information, paying their combined storage cost.
4. Sign one Auto-EVM directory registration, paying the service fee and gas.

Each request waits for a separate click explaining its purpose. Unstable message signatures require a backup unlock password. An initial content-only storage estimate is replaced by a combined estimate after key wrapping; review that estimate before approving the storage transaction. Estimates are approximate; check the wallet amount.

**Complete directory registration promptly.** Before registration, locating the recovery document still depends on this browser's site data. Clearing site data, data corruption or switching devices may make the file impossible to find or decrypt. Stored data remains on-chain, but the wallet directory cannot discover it yet. Paid storage fees cannot be refunded. Local browser data is not a backup.

## On-chain format

A recovery document is JSON with this shape:

```json
{
  "format": "pd-recovery-v1",
  "manifest": {
    "version": 2,
    "network": "mainnet",
    "rootCid": "<encrypted content DAG root>",
    "file": { "name": "example.txt", "size": 560, "sha256": "<plaintext hash>", "mimeType": "text/plain" },
    "encryption": { "scheme": "pdenc-v1", "iv": "...", "cipherSha256": "...", "cipherSize": 576, "wrappedKeys": [] },
    "compression": null,
    "uploader": { "address": "..." },
    "nodes": [{ "cid": "...", "blake3": "...", "bytes": 606 }],
    "submittedAt": "<document preparation timestamp>"
  }
}
```

This is a schematic example. Encrypted documents need at least one valid wrapped-key channel. Raw file keys, wallet signatures and passwords are never included. Filenames, sizes, hashes, protected keys and ciphertext remain public metadata.

The document omits transaction locations and its own CID, so it can be prepared before publishing. Its DAG and the encrypted file DAG are published in one `utility.batchAll`. Combined uploads never fall back to separate paid transactions after a capacity rejection. The current 2 MiB file limit is unchanged.

The reader derives transaction hash, block hash and height from the transaction that contains the recovery document. It requires that transaction to contain all recovery-document and content nodes; nodes from another transaction in the same block cannot fill gaps. Incomplete copies are skipped when a complete candidate is available.

A local manifest remains version 2 and adds optional `recovery: {manifestCid}` alongside its actual transaction location. The manifest and deletion of its pending upload task commit in one IndexedDB transaction. Directory and share-link callers derive the document location from this manifest; they do not require a second critical sidecar write.

Old on-chain manifest JSON is still readable. Older clients cannot read the new envelope; readers and delivery services must be updated. Share-link parameters and deployed contracts are unchanged: the directory's manifest CID can now refer to this recovery document. Notes and Vault retain their existing publishing flow.

## Interrupted work

- **Before the storage signature:** no storage payment has occurred. Closing the page may discard the temporary encryption session; select the file again.
- **After signing or broadcasting, before confirmation:** a local task records the signed hash and both DAG plans before broadcasting. Verify the original transaction instead of uploading again.
- **After confirmation, before local completion:** the task survives if the final IndexedDB transaction aborts. Verification reconstructs the manifest without another broadcast.
- **After storage, before directory registration:** reload the same browser, reconnect the EVM account and continue registration. The new format requires no additional consensus signature or storage payment. Keep the browser data until registration finishes.
- **After registration succeeds but its response or local completion is lost:** continuation reads the current wallet directory first and adopts an existing matching entry without another registration request.
- **If all site data is lost before registration:** automatic wallet recovery is not guaranteed. No full-chain scanning fallback is provided.

A directory read cannot prove that a still-pending EVM transaction will never confirm. If its outcome is unknown, wait and check the transaction before trying another write. This is not a cross-chain atomic operation or a promise of gas-free retries.

## Validation status

Offline transport tests use real DAG packing, encryption, recovery parsing and IndexedDB. Browser tests use the real Files/Upload interface and storage with mocked wallets, chain transport, registry and indexer. They cover four explicit confirmations, cancellation and reload before registration, recovery with only the EVM account, and adoption of a successful directory write whose response was lost.

The combined format has not yet completed a live-wallet mainnet acceptance run. Before release, verify a tiny non-sensitive file with the intended wallet, cancel and resume directory registration, then restore on a separate browser and check the downloaded hash. No contract redeployment is needed.

Local verification: TypeScript/Vite builds pass; publish and recovery fault tests pass all 72 assertions; browser regression passes 10 tests with one live public-fixture test skipped because its URL/hash are not configured. These are offline checks, not live-wallet mainnet acceptance.
