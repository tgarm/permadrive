// Offline tests for the incremental directory reconciliation: the RegistryRecord
// as the per-entry "already reconciled" marker, incremental skipping, one
// failure not aborting the run, retries only re-processing failures, and no
// resurrection of locally deleted files (recovery goes through a fresh browser
// / cleared site). Pure dependency injection — no network, no cost.
//   node directory-sync-test.mjs

import assert from 'node:assert/strict'

const { syncDirectoryFromRegistry } = await import('../../frontend/src/lib/directorySync.ts')

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const ADDR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const manifestFor = (entry) => ({
  version: 2,
  network: 'mainnet',
  rootCid: 'root-' + entry.manifestCid,
  file: { name: entry.name, size: 1, sha256: 'ab'.repeat(32), mimeType: 'text/plain' },
  encryption: null,
  nodes: [],
  txs: [{ txHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32), height: entry.height }],
  compression: null,
  uploader: { address: '' },
  submittedAt: new Date().toISOString(),
  recovery: { manifestCid: entry.manifestCid },
})

// fake deps: entries/manifests/records injectable; recover fails per recoverErrorFor
function makeDeps({ entries = [], manifests = [], records = [], address = ADDR, recoverErrorFor = null } = {}) {
  const localManifests = manifests.map((m) => structuredClone(m))
  const localRecords = records.map((r) => structuredClone(r))
  const calls = { recover: [], putManifest: [], putRecord: [], progress: [] }
  const deps = {
    address,
    fetchEntries: async () => entries,
    listManifests: async () => localManifests,
    listRegistryRecords: async () => localRecords,
    putManifest: async (m) => {
      calls.putManifest.push(m)
      localManifests.push(m)
    },
    putRegistryRecord: async (r) => {
      calls.putRecord.push(r)
      localRecords.push(r)
    },
    recover: async (entry) => {
      calls.recover.push(entry.manifestCid)
      if (recoverErrorFor?.(entry)) throw new Error('scan boom: ' + entry.name)
      return manifestFor(entry)
    },
  }
  return { deps, calls, localManifests, localRecords }
}

const entry = (cid, height, name = 'file-' + cid) => ({ manifestCid: cid, height, name })
const record = (manifestCid, height = 100, address = ADDR) => ({ rootCid: 'root-' + manifestCid, manifestCid, height, evmAddress: address, syncedAt: 1 })

// ---- 1. empty registry: empty=true, zero scans zero writes ----
{
  const { deps, calls } = makeDeps({ entries: [] })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.empty === true && r.total === 0 && r.recovered === 0, '1 empty registry: empty=true')
  ok(calls.recover.length === 0 && calls.putManifest.length === 0 && calls.putRecord.length === 0, '1 empty registry: zero scans and writes')
}

// ---- 2. every entry already reconciled (record hit): all skipped, zero scans ----
{
  const entries = [entry('cid-a', 101), entry('cid-b', 102)]
  const records = [record('cid-a', 101), record('cid-b', 102)]
  const { deps, calls } = makeDeps({ entries, records })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.skipped === 2 && r.recovered === 0 && r.failed.length === 0, '2 fully reconciled: all skipped')
  ok(calls.recover.length === 0, '2 reconciled entries: zero block scans (only new ones are queried)')
}

// ---- 3. new entry: recovered + putManifest + putRegistryRecord (address/height/cid correct) ----
{
  const entries = [entry('cid-new', 200)]
  const { deps, calls } = makeDeps({ entries, records: [record('cid-old', 100)] })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.recovered === 1 && r.skipped === 0 && r.failed.length === 0, '3 new entry recovered (unrelated records do not count as skipped)')
  ok(calls.recover[0] === 'cid-new', '3 only unreconciled entries are scanned')
  ok(calls.putRecord[0].evmAddress === ADDR && calls.putRecord[0].height === 200 && calls.putRecord[0].manifestCid === 'cid-new', '3 record fields correct')
  ok(calls.putManifest[0].rootCid === 'root-cid-new', '3 manifest stored')
}

// ---- 4. local manifest hit without a record: legacy rootCid ----
{
  const entries = [entry('cid-legacy', 150)]
  const manifests = [{ version: 2, rootCid: 'cid-legacy', file: { name: 'old.bin' }, recovery: undefined }]
  const { deps, calls } = makeDeps({ entries, manifests })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.skipped === 1 && calls.recover.length === 0, '4 legacy local manifest (rootCid=manifestCid) hit and skipped')
}

// ---- 5. recovery.manifestCid hit without a record (covers "registered but the record write was interrupted") ----
{
  const entries = [entry('cid-recovery-envelope', 160)]
  const manifests = [{ version: 2, rootCid: 'root-content', recovery: { manifestCid: 'cid-recovery-envelope' } }]
  const { deps, calls } = makeDeps({ entries, manifests })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.skipped === 1 && calls.recover.length === 0, '5 new-format recovery.manifestCid hit and skipped')
}

// ---- 6. address isolation: another address's records do not reconcile this one ----
{
  const entries = [entry('cid-other', 120)]
  const records = [record('cid-other', 120, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')]
  const { deps, calls } = makeDeps({ entries, records })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.recovered === 1 && calls.recover.length === 1, '6 other-address records do not count (case-insensitive comparison)')
  const lower = makeDeps({ entries, records: [record('cid-other', 120, ADDR.toLowerCase())] })
  const r2 = await syncDirectoryFromRegistry(lower.deps)
  ok(r2.skipped === 1 && lower.calls.recover.length === 0, '6 lowercase-address record hit')
}

// ---- 7. one failure does not abort the run: later entries still recover ----
{
  const entries = [entry('cid-ok-1', 201), entry('cid-bad', 202), entry('cid-ok-2', 203)]
  const { deps, calls } = makeDeps({ entries, recoverErrorFor: (e) => e.manifestCid === 'cid-bad' })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.recovered === 2 && r.failed.length === 1, '7 failure does not abort later entries (fixes the old abort-on-first-error)')
  ok(r.failed[0].name === 'file-cid-bad' && /scan boom/.test(r.failed[0].message), '7 failed entry carries name and reason')
  ok(calls.recover.length === 3, '7 all three entries attempted')
}

// ---- 8. retry only re-processes failures: successes already have records ----
{
  const entries = [entry('cid-ok', 201), entry('cid-bad', 202)]
  const { deps, calls } = makeDeps({ entries, recoverErrorFor: (e) => e.manifestCid === 'cid-bad' })
  const first = await syncDirectoryFromRegistry(deps)
  ok(first.recovered === 1 && first.failed.length === 1, '8 first run: 1 ok, 1 failed')
  const second = await syncDirectoryFromRegistry(deps)
  ok(second.recovered === 0 && second.skipped === 1 && second.failed.length === 1, '8 retry skips reconciled, rescans only the failure')
  ok(calls.recover.filter((c) => c === 'cid-bad').length === 2 && calls.recover.filter((c) => c === 'cid-ok').length === 1, '8 the failed entry is retried, the success is never scanned again')
}

// ---- 9. no resurrection of locally deleted files (record kept → skip; recovery = fresh browser / cleared site) ----
{
  const entries = [entry('cid-deleted', 300)]
  const records = [record('cid-deleted', 300)] // manifest deleted locally, record kept
  const { deps, calls } = makeDeps({ entries, records })
  const r = await syncDirectoryFromRegistry(deps)
  ok(r.skipped === 1 && calls.recover.length === 0 && calls.putManifest.length === 0, '9 deleted files are not resurrected (same for automatic and "Refresh")')
}

// ---- 10. progress callback: per-entry index/total/entry ----
{
  const entries = [entry('cid-p1', 401, 'alpha.txt'), entry('cid-p2', 402, 'beta.txt')]
  const { deps } = makeDeps({ entries })
  const seen = []
  await syncDirectoryFromRegistry(deps, (p) => seen.push(`${p.index}/${p.total}:${p.entry.name}@${p.entry.height}`))
  ok(seen.join('|') === '0/2:alpha.txt@401|1/2:beta.txt@402', '10 progress callback sequence correct')
}

console.log(`\n${passed} assertions passed`)
if (process.exitCode) console.error('FAILED')
