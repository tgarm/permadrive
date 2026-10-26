// PoC · publish side: file → IPLD pack → system.remark (utility.batch, falling back to per-node
//         txs on failure) → confirmationDepth confirmation (the target chain's finality may lag for
//         a long time; see lib/chain.mjs).
// Usage: node publish.mjs [file path] [--size bytes]
//   With no file given, generates a deterministic pseudo-random sample (xorshift, reproducible).
// Output: out/<timestamp>-manifest.json (root CID, node table, tx/block locations)

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import { Keyring } from '@polkadot/api'
import { connectApi, submitAndWaitConfirmed } from './lib/chain.mjs'
import { packFile, makeRemarkPayload, cidToString, nodeHashHex } from './lib/dag.mjs'

const argv = process.argv.slice(2)
const sizeArgIdx = argv.indexOf('--size')
const size = sizeArgIdx >= 0 ? Number(argv[sizeArgIdx + 1]) : 200_000
const filePath = argv.find((a) => !a.startsWith('--') && a !== String(size))
const OUT_DIR = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT_DIR, { recursive: true })

const loadMnemonic = () => {
  if (process.env.CHAIN_MNEMONIC) return process.env.CHAIN_MNEMONIC
  const envFile = new URL('./.env', import.meta.url).pathname
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*CHAIN_MNEMONIC\s*=\s*"?([^"\n]+?)"?\s*$/)
      if (m) return m[1]
    }
  }
  console.error('missing CHAIN_MNEMONIC: run `npm run gen-account` first, then fund the address')
  process.exit(1)
}

// Deterministic pseudo-random sample (xorshift64*); re-running with the same parameters yields the same file
const makeSample = (n) => {
  const buf = Buffer.alloc(n)
  let s = 0x2545f4914f6cdd1dn
  const mask = (x) => BigInt.asUintN(64, x)
  for (let i = 0; i < n; i++) {
    s = mask(s ^ (s << 13n))
    s = mask(s ^ (s >> 7n))
    s = mask(s ^ (s << 17n))
    buf[i] = Number((s * 0x2545f4914f6cdd1dn) & 0xffn)
  }
  return buf
}

const target = filePath ?? `${OUT_DIR}poc-sample-${size}.bin`
if (!filePath) {
  writeFileSync(target, makeSample(size))
  console.log(`sample file: ${target} (${size} bytes, deterministic)`)
}
const original = readFileSync(target)
const sha256 = createHash('sha256').update(original).digest('hex')
console.log(`original sha256: ${sha256}`)

// ---- Pack ----
console.log('\n[1/3] packing with auto-dag-data …')
const { rootCid, nodes, totalSize } = await packFile(target)
console.log(`  root CID: ${cidToString(rootCid)}`)
console.log(`  nodes: ${nodes.length}, file size: ${totalSize}`)
for (const n of nodes) console.log(`    ${cidToString(n.cid)}  ${(n.bytes.length / 1024).toFixed(1)} KiB`)

// ---- Connect, account, balance ----
console.log('\n[2/3] connecting chain …')
const api = await connectApi()
const { cryptoWaitReady } = await import('@polkadot/util-crypto')
await cryptoWaitReady()
const keyring = new Keyring({ type: 'sr25519' })
const pair = keyring.addFromMnemonic(loadMnemonic())
const chainName = (await api.rpc.system.chain()).toString()
const { data: account } = await api.query.system.account(pair.address)
console.log('  signer:', pair.address)
console.log('  chain:', chainName)
console.log('  balance:', account.free.toHuman())
if (account.free.isZero()) {
  console.error('  ✗ balance is zero — fund the account first (see scripts/poc/README.md)')
  process.exit(1)
}

// First-order fee approximation: byteFee × total bytes (payment_queryInfo panics on large remarks)
const byteFee = (await api.query.transactionFees.transactionByteFee()).toJSON()
const totalBytes = nodes.reduce((a, n) => a + n.bytes.length, 0)
const feeEst =
  Number((BigInt(byteFee.current) * BigInt(totalBytes)) * 1000n / 10n ** 18n) / 1000
console.log(`  ~fee ≈ ${feeEst.toFixed(4)} AI3 (byteFee × ${totalBytes} B)`)

// ---- Build remarks and submit: prefer utility.batch (one signature), fall back to per-node txs ----
// Note: the fallback only triggers when the node rejects the submission; a failed inclusion-block
// scan ≠ a failed submission (the tx may already be in the pool; blindly resubmitting the same
// nonce hits the (signer,nonce) dedup → temporarily banned)
console.log('\n[3/3] publishing …')
const remarkTxs = () => nodes.map((n) => api.tx.system.remark(makeRemarkPayload(n.bytes)))
const inclusions = []
const submitTx = async (tx) => {
  await tx.signAsync(pair, { nonce: (await api.rpc.system.accountNextIndex(pair.address)).toNumber() })
  await api.rpc.author.submitExtrinsic(tx.toHex()) // throws here on rejection
  return submitAndWaitConfirmed(api, tx)
}
try {
  inclusions.push(await submitTx(api.tx.utility.batch(remarkTxs())))
} catch (e) {
  if (/temporarily banned|not found on best chain/.test(e.message)) throw e
  console.warn(`  batch rejected (${e.message}); falling back to individual remarks …`)
  for (const t of remarkTxs()) inclusions.push(await submitTx(t))
}
for (const inc of inclusions)
  console.log(`  ✓ tx ${inc.txHash} confirmed (12+ blocks) in block #${inc.height}`)

const manifest = {
  network: chainName,
  rpc: process.env.CHAIN_RPC ?? 'https://rpc.chronos.autonomys.xyz/ws',
  indexer: process.env.CHAIN_INDEXER ?? 'wss://indexer.taurus.autonomys.xyz/ws',
  file: { name: target.split('/').pop(), size: totalSize, sha256 },
  rootCid: cidToString(rootCid),
  nodes: nodes.map((n) => ({
    cid: cidToString(n.cid),
    blake3: nodeHashHex(n.cid),
    bytes: n.bytes.length,
  })),
  txs: inclusions.map(({ txHash, blockHash, height }) => ({ txHash, blockHash, height })),
  submittedAt: new Date().toISOString(),
}
const manifestPath = `${OUT_DIR}${Date.now()}-manifest.json`
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
console.log(`\nmanifest: ${manifestPath}`)
console.log('next: npm run retrieve -- ' + manifestPath)
await api.disconnect()
