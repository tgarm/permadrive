// Offline tests for file version grouping (2026-11-03): same-owner same-name
// manifests form a version chain ordered by consensus-chain height (multi-batch
// takes the last batch height, ties fall back to submittedAt, txs-less sorts as
// oldest), group ordering follows the latest version's submittedAt descending.
// Pure functions, no network, no storage.
//   node file-versions-test.mjs

import assert from 'node:assert/strict'

const { groupFileVersions, versionHeight } = await import('../../frontend/src/lib/fileVersions.ts')

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const m = (rootCid, name, txHeights, submittedAt, mimeType = 'text/plain') => ({
  rootCid,
  file: { name, size: 100, sha256: 'aa'.repeat(32), mimeType },
  txs: txHeights.map((height) => ({ height })),
  submittedAt,
})

// ---- 1. single file, single version: one group, latest is itself ----
{
  const [g] = groupFileVersions([m('root-a', 'a.txt', [100], '2026-11-03T10:00:00Z')])
  ok(g.name === 'a.txt' && g.versions.length === 1 && g.latest.rootCid === 'root-a', '1 single file forms one group with itself as latest')
}

// ---- 2. same name two versions: height ascending, latest = highest ----
{
  const groups = groupFileVersions([
    m('root-old', 'a.txt', [100], '2026-11-03T09:00:00Z'),
    m('root-new', 'a.txt', [200], '2026-11-03T10:00:00Z'),
  ])
  ok(groups.length === 1, '2 same-name manifests group together')
  ok(groups[0].versions.map((v) => v.rootCid).join(',') === 'root-old,root-new', '2 versions ordered by height ascending')
  ok(groups[0].latest.rootCid === 'root-new', '2 latest is the higher-height version')
}

// ---- 3. version numbering derived from position (v1..vN) ----
{
  const groups = groupFileVersions([
    m('r3', 'a.txt', [300], '2026-11-03T11:00:00Z'),
    m('r1', 'a.txt', [100], '2026-11-03T09:00:00Z'),
    m('r2', 'a.txt', [200], '2026-11-03T10:00:00Z'),
  ])
  ok(groups[0].versions.length === 3, '3 three versions in one group')
  ok(groups[0].versions.map((v) => v.rootCid).join(',') === 'r1,r2,r3', '3 input order shuffled but height order preserved')
}

// ---- 4. multi-batch manifest: version height = max(txs.height) ----
{
  ok(versionHeight(m('r', 'a', [10, 200], '2026-11-03T09:00:00Z')) === 200, '4 versionHeight takes max of tx heights')
  const groups = groupFileVersions([
    m('r-multi', 'a.txt', [10, 200], '2026-11-03T09:00:00Z'), // published in 2 batches, last batch = 200
    m('r-single', 'a.txt', [100], '2026-11-03T10:00:00Z'),
  ])
  ok(groups[0].versions.map((v) => v.rootCid).join(',') === 'r-single,r-multi', '4 multi-batch orders by last batch height (200 > 100)')
  ok(groups[0].latest.rootCid === 'r-multi', '4 multi-batch latest is correct despite earlier submittedAt')
}

// ---- 5. height tie falls back to submittedAt ----
{
  const groups = groupFileVersions([
    m('r-later', 'a.txt', [100], '2026-11-03T10:00:00Z'),
    m('r-earlier', 'a.txt', [100], '2026-11-03T09:00:00Z'),
  ])
  ok(groups[0].versions.map((v) => v.rootCid).join(',') === 'r-earlier,r-later', '5 equal heights fall back to submittedAt')
}

// ---- 6. txs-less manifest sorts as oldest ----
{
  const groups = groupFileVersions([
    m('r-has-tx', 'a.txt', [100], '2026-11-03T09:00:00Z'),
    m('r-no-tx', 'a.txt', [], '2026-11-03T12:00:00Z'), // imported / publishing-in-progress
  ])
  ok(groups[0].versions.map((v) => v.rootCid).join(',') === 'r-no-tx,r-has-tx', '6 txs-less (height 0) sorts as oldest version')
}

// ---- 7. different names never group together ----
{
  const groups = groupFileVersions([
    m('r-a', 'a.txt', [100], '2026-11-03T09:00:00Z'),
    m('r-b', 'b.txt', [100], '2026-11-03T09:00:00Z'),
  ])
  ok(groups.length === 2, '7 different names stay in separate groups')
}

// ---- 8. group order: latest version's submittedAt descending ----
{
  const groups = groupFileVersions([
    m('r-a1', 'a.txt', [100], '2026-11-01T09:00:00Z'),
    m('r-b1', 'b.txt', [100], '2026-11-02T09:00:00Z'),
    m('r-a2', 'a.txt', [200], '2026-11-03T09:00:00Z'),
  ])
  ok(groups.map((g) => g.name).join(',') === 'a.txt,b.txt', '8 groups ordered by latest version time descending (a updated on 11-03)')
}

// ---- 9. encrypted files (null mimeType) group the same way ----
{
  const groups = groupFileVersions([
    m('r-e1', 'secret.txt', [100], '2026-11-03T09:00:00Z', null),
    m('r-e2', 'secret.txt', [200], '2026-11-03T10:00:00Z', null),
  ])
  ok(groups.length === 1 && groups[0].latest.rootCid === 'r-e2', '9 encrypted files (null mimeType) version the same way')
}

// ---- 10. grouping is name-exact: whitespace differs → separate groups ----
{
  const groups = groupFileVersions([
    m('r-x', 'a.txt', [100], '2026-11-03T09:00:00Z'),
    m('r-y', 'a.txt ', [100], '2026-11-03T09:00:00Z'),
  ])
  ok(groups.length === 2, '10 name match is exact (no trim/case-fold)')
}

assert.equal(passed, 15, `expected 15 assertions, got ${passed}`)
console.log(`\nAll ${passed} assertions passed`)
process.exit(0)
