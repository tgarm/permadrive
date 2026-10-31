// P4 · PaywallV2 on-chain acceptance runner (automation of the doc/14-style
// runbook: one preflight, three mandatory order paths, one report).
//
//   node acceptance.mjs preflight [--skip-tests]      # read-only preflight (incl. legacy
//                                                     # paywall inventory), zero cost
//   node acceptance.mjs run    --run-id <id> --cap 0.05 [--paths b,c,a] [--price 0.01]
//   node acceptance.mjs resume --run-id <id>          # resume from the journal
//   node acceptance.mjs report --run-id <id>          # recompute report.json + summary.md only
//
// Record directory scripts/p4/out/acceptance/<runId>/ (covered by the .gitignore
// out/ rule — never committed):
//   input.json   frozen inputs (commit, instance addresses, roles, price, cap,
//                pre-run baseline balances)
//   journal.json step state machine planned → submitted → confirmed → checked
//                (plus accumulated spend)
//   report.json  per-path verdict + assertions, txs, gas, money flows (all big
//                integers as decimal strings)
//   summary.md   human-readable conclusion (generated from the same source)
//
// Discipline (runbook §3/§4):
//   - records never contain mnemonics, raw signatures, the data key K, or plaintext
//     key material; K is re-derived on demand via the seller's signature channel
//   - orderId always parsed from the purchase receipt's Purchased event (never
//     read off orderCount)
//   - submitted/unknown steps are reconciled by hash first; never blindly resend
//     (same nonce resubmission hits the temporary ban)
//   - refund assertion: "buyer balance delta + gas = price"; credits/withdrawal
//     assertions always against the immediately-preceding baseline (pits 20/26)
//   - waits are anchored to on-chain timestamps (purchasedAt/deliveredAt), not the
//     local clock; long waits persist nextEligibleAt and exit (code 3) for resume
//   - exit codes: 0 all mandatory paths pass; 1 definite failure; 2 blocked;
//     3 waiting for on-chain time
//
// Path semantics:
//   B test instance: list → purchase → early refund rejected → wait out
//                    deliveryTimeout → refund (full principal back) → seller
//                    credits unchanged → delist (synthetic key, no data delivery)
//   C test instance: list → purchase → markDelivered → refund within grace →
//                    confirm/release rejected afterwards → delist
//   A production:    real encrypted file to the consensus chain + Registry v2 →
//                    list → C purchases → Mailbox pdgrant delivery → C recovers
//                    the manifest on-chain, retrieves + verifies the ciphertext,
//                    decrypts + verifies the plaintext → confirm → withdraw → delist
//   (C before B: C's refund completes immediately inside the grace period, then we
//    wait for B's timeout — never let path C drift past its grace window.)

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { autoEvm, clients, DEPLOYMENTS, loadMnemonic, ai3 } from '../p3/lib/chain.mjs'
import { connectApi, extractRemarkNodes, srPairFromMnemonic, submitAndWaitConfirmed } from '../poc/lib/chain.mjs'
import { assemble, cidToString, makeRemarkPayload, nodeHashHex, packFile, stringToCid } from '../poc/lib/dag.mjs'
import { decodeEventLog, keccak256, parseAbiItem, toHex } from 'viem'
import {
  addSignatureChannel,
  requireChannel,
  startEncryption,
} from '../../frontend/src/lib/fileCrypto.ts'
import { validateManifest } from '../../frontend/src/lib/manifest.ts'
import { REGISTRY_ABI } from '../../frontend/src/lib/registry-abi.ts'
import {
  boxDecryptWithSecretKey,
  boxEncrypt,
  localBoxKeypair,
  parseEnvelope,
} from '../../frontend/src/lib/boxCrypto.ts'
import { aesGcmDecrypt, tryUnwrapWithSignature } from '../../frontend/src/lib/vaultCrypto.ts'
import { fromHex } from '../../frontend/src/lib/bytes.ts'

// ---------- constants & CLI ----------

const ROOT = new URL('../../', import.meta.url).pathname
const OUT_BASE = path.join(ROOT, 'scripts/p4/out/acceptance')
const V2_ARTIFACT = path.join(ROOT, 'contracts/out/PaywallV2.json')
const MAILBOX_ARTIFACT = path.join(ROOT, 'contracts/out/Mailbox.json')
const COMMIT = (() => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}
const hasFlag = (name) => argv.includes(`--${name}`)

const toWei = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n // decimal → wei (no float-to-BigInt precision trap)
const PRICE_DEFAULT = '0.01'

// v1 (legacy) inventory ABI: read-only surface (events + listings/deal/credits)
const V1_ABI = [
  parseAbiItem('function listings(bytes32) view returns (address seller, uint96 price)'),
  parseAbiItem('function deal(bytes32, address) view returns (address buyer, uint96 price, uint8 state, uint64 purchasedAt, uint64 deliveredAt)'),
  parseAbiItem('function credits(address) view returns (uint256)'),
  parseAbiItem('event Listed(address indexed seller, bytes32 indexed key, uint96 price)'),
  parseAbiItem('event Unlisted(address indexed seller, bytes32 indexed key)'),
  parseAbiItem('event Purchased(bytes32 indexed key, address indexed buyer, uint96 price)'),
  parseAbiItem('event Delivered(bytes32 indexed key, address indexed buyer)'),
  parseAbiItem('event Released(bytes32 indexed key, address indexed buyer, uint256 net, uint256 fee)'),
  parseAbiItem('event Refunded(bytes32 indexed key, address indexed buyer, uint256 amount)'),
  parseAbiItem('event Withdrawn(address indexed seller, uint256 amount)'),
]
const STATE_NAME = ['none', 'escrowed', 'delivered', 'released', 'refunded']
const MSG_SENT = parseAbiItem('event MessageSent(uint256 indexed id, address indexed from, address indexed to, string content, uint64 sentAt)')

// Occasional TLS handshake failures on the RPC (pit 18) — uniform small backoff;
// business reverts are never retried
async function withRetry(fn, tries = 4, baseMs = 1500) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (/revert|User rejected|execution reverted/i.test(String(e?.message ?? e))) throw e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i))
    }
  }
  throw last
}

class Exit extends Error {
  constructor(code, msg) {
    super(msg)
    this.code = code
  }
}

// ---------- record dir / journal / report ----------

let RUN = null // { id, dir, input, journal }

function jwrite(file, obj) {
  const p = path.join(RUN.dir, file)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
  renameSync(tmp, p) // atomic persist: a crash never leaves a half-written JSON (bigints as decimal strings)
}

function loadRun(id, { forWrite }) {
  const dir = path.join(OUT_BASE, id)
  if (!existsSync(dir)) {
    if (!forWrite) throw new Exit(2, `run directory does not exist: ${dir}`)
    mkdirSync(dir, { recursive: true })
  }
  const input = existsSync(path.join(dir, 'input.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'input.json'), 'utf8'))
    : null
  const journal = existsSync(path.join(dir, 'journal.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'journal.json'), 'utf8'))
    : { runId: id, steps: [], spend: { gas: '0', fees: '0', consensus: '0', escrow: '0' } }
  return { id, dir, input, journal }
}

function step(id) {
  let s = RUN.journal.steps.find((x) => x.id === id)
  if (!s) {
    s = { id, state: 'planned' }
    RUN.journal.steps.push(s)
  }
  return s
}

function syncSpend() {
  RUN.journal.spend = {
    gas: spend.gas.toString(), fees: spend.fees.toString(),
    consensus: spend.consensus.toString(), escrow: spend.escrow.toString(),
  }
}

function setStep(s, state, patch = {}) {
  Object.assign(s, patch, { state, at: new Date().toISOString() })
  syncSpend()
  jwrite('journal.json', RUN.journal)
  console.log(`  [${s.id}] ${state}${s.txHash ? ` tx=${String(s.txHash).slice(0, 18)}…` : ''}${s.note ? ` · ${s.note}` : ''}${s.error ? ` · ✗ ${s.error}` : ''}`)
}

/** Record "submitted" before broadcasting; only mark "checked" after the receipt
 *  verifies — a crash at any point is recoverable. Resume branch: submitted+txHash
 *  is reconciled by receipt first, never resent. */
async function txStep(s, sendFn, { parse } = {}) {
  if (s.state === 'checked') return s.result
  if (s.state === 'submitted' && s.txHash) {
    const rx = await withRetry(() => A.publicClient.waitForTransactionReceipt({ hash: s.txHash }))
    if (rx.status !== 'success') {
      setStep(s, 'unknown', { note: `historical tx status ${rx.status} — verify manually, do not resend` })
      throw new Exit(2, `step ${s.id} outcome unknown (see journal)`)
    }
    spend.gas += rx.gasUsed * rx.effectiveGasPrice
    const result = parse ? parse(rx) : null
    setStep(s, 'checked', { result, note: 'resume: reconciled against the historical tx' })
    return result
  }
  setStep(s, 'submitted')
  try {
    const { hash, receipt, result } = await sendFn()
    if (receipt.status !== 'success') {
      setStep(s, 'unknown', { txHash: hash, note: `receipt ${receipt.status} — verify first, do not resend` })
      throw new Exit(2, `step ${s.id} tx status ${receipt.status} (outcome unknown, see journal)`)
    }
    spend.gas += receipt.gasUsed * receipt.effectiveGasPrice
    const r2 = parse ? parse(receipt) : null
    setStep(s, 'checked', { txHash: hash, result: r2 })
    return r2
  } catch (e) {
    if (e instanceof Exit) throw e
    setStep(s, s.txHash ? 'unknown' : 'failed', { error: String(e?.message ?? e).slice(0, 300) })
    throw e
  }
}

// ---------- signers & contract helpers ----------

const A = clients(0) // seller / owner / treasury / Registry registrant / consensus publisher (same mnemonic)
const C = clients(2) // buyer (separate address; index 1 reserved for the legacy adversarial script)

const bal = (c) => withRetry(() => c.publicClient.getBalance({ address: c.address }))
const gasOf = (rx) => rx.gasUsed * rx.effectiveGasPrice
const gasStr = (rx) => String(rx.gasUsed * rx.effectiveGasPrice)
/** Whether the step runs for the first time in this process (false = resumed —
 *  sequence-sensitive assertions only run for fresh executions) */
const isFresh = (id) => step(id).state !== 'checked'

const abis = JSON.parse(readFileSync(V2_ARTIFACT, 'utf8')).abi
const mailboxAbis = JSON.parse(readFileSync(MAILBOX_ARTIFACT, 'utf8')).abi

const v2write = async (c, addr, fn, args, value = 0n) => {
  const hash = await withRetry(() =>
    c.walletClient.writeContract({ address: addr, abi: abis, functionName: fn, args, chain: autoEvm, ...(value ? { value } : {}) }),
  )
  const receipt = await withRetry(() => c.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 }))
  return { hash, receipt }
}
const v2read = (c, addr, fn, args = []) =>
  withRetry(() => c.publicClient.readContract({ address: addr, abi: abis, functionName: fn, args }))
async function orderOf(c, addr, id) {
  const [seller, buyer, price, feeBps, state, purchasedAt, deliveredAt] = await v2read(c, addr, 'orders', [id])
  return { seller, buyer, price, feeBps: Number(feeBps), state: Number(state), purchasedAt, deliveredAt }
}
function orderIdFromReceipt(rx) {
  for (const log of rx.logs) {
    try {
      const ev = decodeEventLog({ abi: abis, data: log.data, topics: log.topics })
      if (ev.eventName === 'Purchased') return ev.args.orderId
    } catch { /* not our contract's event */ }
  }
  throw new Error('receipt has no Purchased event')
}
function eventsOf(rx, abi) {
  return rx.logs
    .map((l) => {
      try {
        return decodeEventLog({ abi, data: l.data, topics: l.topics })
      } catch {
        return null
      }
    })
    .filter(Boolean)
}
async function expectRevert(label, fn, reason) {
  try {
    await fn()
  } catch (e) {
    const s = String(e?.message ?? e)
    if (new RegExp(reason).test(s)) return
    throw new Error(`${label}: expected revert(${reason}), got: ${s.split('\n')[0].slice(0, 200)}`)
  }
  throw new Error(`${label}: expected revert(${reason}) but the transaction succeeded`)
}

// ---------- spend cap (persisted in the journal, accumulates across resumes) ----------

const spend = { gas: 0n, fees: 0n, consensus: 0n, escrow: 0n }
function restoreSpend() {
  const s = RUN.journal.spend ?? {}
  spend.gas = BigInt(s.gas ?? '0')
  spend.fees = BigInt(s.fees ?? '0')
  spend.consensus = BigInt(s.consensus ?? '0')
  spend.escrow = BigInt(s.escrow ?? '0')
}
function checkCap(nextWei, what) {
  const used = spend.gas + spend.fees + nextWei
  if (used > BigInt(RUN.input.capWei)) {
    throw new Exit(2, `spend cap: ${what} needs ~${ai3(nextWei)}, accumulated ${ai3(used)} > cap ${ai3(BigInt(RUN.input.capWei))} (escrowed peak tracked separately: ${ai3(spend.escrow)})`)
  }
}
function noteEscrow(delta) {
  spend.escrow += delta
  syncSpend()
  jwrite('journal.json', RUN.journal)
}

// ---------- consensus chain (path A only) ----------

const CONSENSUS_RPC = process.env.CHAIN_RPC ?? 'https://rpc.mainnet.subspace.foundation/ws'

// deterministic 1 KiB sample (xorshift64*, same as the PoC; same runId reproduces
// the same plaintext)
function deterministicSample(n) {
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

async function publishRemarkNodes(api, pair, nodeBytesList) {
  const txs = nodeBytesList.map((b) => api.tx.system.remark(makeRemarkPayload(b)))
  const submit = async (tx) => {
    await tx.signAsync(pair, { nonce: (await api.rpc.system.accountNextIndex(pair.address)).toNumber() })
    await api.rpc.author.submitExtrinsic(tx.toHex()) // rejected here; inclusion-scan failure ≠ submission failure
    return submitAndWaitConfirmed(api, tx, { timeoutMs: 8 * 60_000 })
  }
  let inclusions
  try {
    inclusions = [await submit(api.tx.utility.batch(txs))]
  } catch (e) {
    if (/temporarily banned|not found on best chain/.test(String(e.message))) throw e
    console.warn(`  batch rejected (${String(e.message).slice(0, 80)}); falling back to per-tx remarks…`)
    inclusions = []
    for (const tx of txs) inclusions.push(await submit(tx))
  }
  // consensus byte-fee approximation: byteFee × total bytes (pit 2 first-order rule;
  // payment_queryInfo panics on large remarks)
  const byteFee = BigInt((await api.query.transactionFees.transactionByteFee()).toJSON().current)
  const total = nodeBytesList.reduce((a, b) => a + b.length + 120, 0) // +120B ≈ bare per-tx overhead
  spend.consensus += byteFee * BigInt(total)
  return inclusions
}

async function consensusApi() {
  const api = await connectApi(CONSENSUS_RPC)
  const pair = await srPairFromMnemonic(loadMnemonic())
  return { api, pair }
}

/** Seller re-derives K via the signature channel (local HDAccount RFC6979 is
 *  deterministic; the key never touches disk) */
async function unwrapKeyWithSigner(manifest, client) {
  const sigWrap = manifest.encryption?.wrappedKeys?.find((w) => w.mode === 'signature-v1')
  if (!sigWrap) throw new Error('manifest has no signature channel; K cannot be re-derived in Node')
  const sig = await client.account.signMessage({ message: sigWrap.message })
  const key = await tryUnwrapWithSignature(sigWrap, fromHex(sig))
  if (!key) throw new Error('signature-channel unwrap failed')
  return key
}

const signWith = (c) => async (message) => fromHex(await c.account.signMessage({ message }))

// ---------- path C (test instance: refund within grace after delivery) ----------

async function pathC(testAddr, price) {
  const res = { path: 'C', instance: 'test', checks: [] }
  const check = (pass, label, detail = '') => {
    res.checks.push({ pass, label, detail })
    console.log(`    ${pass ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`)
    if (!pass) throw new Exit(1, `path C assertion failed: ${label}`)
  }
  const k = keccak256(toHex(`pd-acceptance-${RUN.id}-C`))

  await txStep(step('C1-list'), async () => {
    checkCap(120_000n * 11n * 10n ** 9n, 'C1 setPrice')
    return v2write(A, testAddr, 'setPrice', [k, price])
  })
  if (isFresh('C6-unlist')) check((await v2read(A, testAddr, 'listingPrice', [A.address, k])) === price, 'C1 listing readback (seller namespace)')

  const c2fresh = isFresh('C2-purchase')
  const orderIdC = BigInt(
    await txStep(
      step('C2-purchase'),
      async () => {
        checkCap(price, 'C2 purchase (escrowed, refundable)')
        return v2write(C, testAddr, 'purchase', [k, A.address, price], price)
      },
      { parse: (rx) => orderIdFromReceipt(rx) },
    ),
  )
  noteEscrow(c2fresh ? price : 0n)
  const o2 = await orderOf(A, testAddr, orderIdC)
  if (c2fresh) check(o2.state === 1 && o2.price === price && o2.seller === A.address && o2.buyer === C.address && o2.feeBps === 1000, `C2 order(${orderIdC}) snapshot complete (Escrowed)`)

  const c3fresh = isFresh('C3-deliver')
  await txStep(step('C3-deliver'), async () => v2write(A, testAddr, 'markDelivered', [orderIdC]))
  if (c3fresh) check((await orderOf(A, testAddr, orderIdC)).state === 2, 'C3 markDelivered: Delivered')

  const c4fresh = isFresh('C4-refund-in-grace')
  const refundGas = c4fresh
    ? await txStep(step('C4-refund-in-grace'), async () => {
        checkCap(120_000n * 11n * 10n ** 9n, 'C4 refund')
        return v2write(C, testAddr, 'refund', [orderIdC])
      }, { parse: gasStr }).then(BigInt)
    : 0n
  if (c4fresh) noteEscrow(-price)
  check((await orderOf(A, testAddr, orderIdC)).state === 4, 'C4 refund within grace: Refunded (history preserved)')
  if (c4fresh) {
    const d0 = BigInt(RUN.journal.balances.C.beforeC4)
    const d1 = BigInt(await bal(C))
    check(d1 - d0 + refundGas === price, 'C4 full refund: buyer balance delta + gas = price', `net ${ai3(d1 - d0 + refundGas)}`)
  }

  await expectRevert('C5a', () => v2write(C, testAddr, 'confirmReceipt', [orderIdC]), 'BadState')
  check(true, 'C5 confirmReceipt after Refunded rejected (terminal states are final)')
  await expectRevert('C5b', () => v2write(A, testAddr, 'release', [orderIdC]), 'BadState')
  check(true, 'C5 seller release after Refunded rejected')

  await txStep(step('C6-unlist'), async () => v2write(A, testAddr, 'setPrice', [k, 0n]))
  check((await v2read(A, testAddr, 'listingPrice', [A.address, k])) === 0n, 'C6 delisted')

  res.orderId = String(orderIdC)
  res.finalState = 'refunded'
  return res
}

// ---------- path B (test instance: refund after undelivered timeout) ----------

async function pathB(testAddr, price) {
  const res = { path: 'B', instance: 'test', checks: [] }
  const check = (pass, label, detail = '') => {
    res.checks.push({ pass, label, detail })
    console.log(`    ${pass ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`)
    if (!pass) throw new Exit(1, `path B assertion failed: ${label}`)
  }
  const k = keccak256(toHex(`pd-acceptance-${RUN.id}-B`))

  const creditsBefore = BigInt(await v2read(A, testAddr, 'credits', [A.address]))
  await txStep(step('B1-list'), async () => {
    checkCap(120_000n * 11n * 10n ** 9n, 'B1 setPrice')
    return v2write(A, testAddr, 'setPrice', [k, price])
  })
  if (isFresh('B6-unlist')) check((await v2read(A, testAddr, 'listingPrice', [A.address, k])) === price, 'B1 listing readback')

  const b2fresh = isFresh('B2-purchase')
  const orderIdB = BigInt(
    await txStep(
      step('B2-purchase'),
      async () => {
        checkCap(price, 'B2 purchase (escrowed, refundable)')
        return v2write(C, testAddr, 'purchase', [k, A.address, price], price)
      },
      { parse: (rx) => orderIdFromReceipt(rx) },
    ),
  )
  if (b2fresh) noteEscrow(price)
  const o = await orderOf(A, testAddr, orderIdB)
  if (b2fresh) {
    check(o.state === 1 && o.price === price && o.seller === A.address && o.buyer === C.address && o.feeBps === 1000, `B2 order(${orderIdB}) snapshot complete (Escrowed)`)
  }
  const tEnd = Number(o.purchasedAt) * 1000 + Number(await v2read(A, testAddr, 'deliveryTimeout')) * 1000 + 5_000

  await expectRevert('B3', () => v2write(C, testAddr, 'refund', [orderIdB]), 'BadState')
  check(true, 'B3 refund before timeout rejected (BadState; simulated failure costs zero txs)')

  await waitUntil(step('B4-wait-timeout'), tEnd)

  const b5fresh = isFresh('B5-refund')
  const refundGas = b5fresh
    ? await txStep(step('B5-refund'), async () => {
        checkCap(120_000n * 11n * 10n ** 9n, 'B5 refund')
        return v2write(C, testAddr, 'refund', [orderIdB])
      }, { parse: gasStr }).then(BigInt)
    : 0n
  if (b5fresh) noteEscrow(-price)
  check((await orderOf(A, testAddr, orderIdB)).state === 4, 'B5 Refunded terminal state')
  if (b5fresh) {
    const b1 = BigInt(RUN.journal.balances.C.beforeB5)
    const b2 = BigInt(await bal(C))
    check(b2 - b1 + refundGas === price, 'B5 full refund: buyer balance delta + gas = price', `net ${ai3(b2 - b1 + refundGas)}`)
  }
  const creditsAfter = BigInt(await v2read(A, testAddr, 'credits', [A.address]))
  check(creditsAfter === creditsBefore, 'seller credits unchanged (timeout refund bypasses settlement)')

  await txStep(step('B6-unlist'), async () => v2write(A, testAddr, 'setPrice', [k, 0n]))
  check((await v2read(A, testAddr, 'listingPrice', [A.address, k])) === 0n, 'B6 delisted')

  res.orderId = String(orderIdB)
  res.finalState = 'refunded'
  return res
}

/** Wait until on-chain time reaches the deadline: 15s progress output; beyond
 *  30min persist nextEligibleAt and exit 3 (resume continues) */
async function waitUntil(s, epochMs) {
  const MAX_INLINE_MS = 30 * 60_000
  const remain = () => epochMs - Date.now()
  if (remain() <= 0) return
  if (remain() > MAX_INLINE_MS) {
    setStep(s, 'submitted', { nextEligibleAt: new Date(epochMs).toISOString(), note: `waiting for on-chain time ~${Math.ceil(remain() / 60_000)} min — exiting, resume continues` })
    await finish({ status: 'waiting' })
    throw new Exit(3, `waiting for on-chain time until ${s.nextEligibleAt} (persisted)`)
  }
  while (remain() > 0) {
    const r = remain()
    console.log(`  … waiting for on-chain time ${Math.ceil(r / 1000)}s (deadline ${new Date(epochMs).toISOString()})`)
    await new Promise((x) => setTimeout(x, Math.min(15_000, r)))
    syncSpend()
    jwrite('journal.json', RUN.journal)
  }
  if (isFresh(s.id)) setStep(s, 'checked', { note: 'on-chain time reached' })
}

// ---------- path A (production instance: real file + real Mailbox delivery) ----------

async function pathA(mainAddr, price) {
  const res = { path: 'A', instance: 'main', checks: [] }
  const check = (pass, label, detail = '') => {
    res.checks.push({ pass, label, detail })
    console.log(`    ${pass ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`)
    if (!pass) throw new Exit(1, `path A assertion failed: ${label}`)
  }
  const artifacts = path.join(RUN.dir, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  const plainName = `pd-accept-${RUN.id}.bin`

  // A1 encrypt: random 32B key K + AES-256-GCM over the whole file; signature
  // channel (determinism self-check, pit 21 rule)
  const s1 = step('A1-encrypt')
  let manifest
  if (s1.state === 'checked') {
    const mPath = path.join(artifacts, 'manifest.json')
    if (!existsSync(mPath)) throw new Exit(2, 'A1 is checked but manifest.json is missing — records corrupted, start a new runId')
    manifest = JSON.parse(readFileSync(mPath, 'utf8'))
    console.log('  [A1] resume: reusing the published manifest (K re-derived via the signature channel, never stored)')
  } else {
    setStep(s1, 'submitted')
    const plain = deterministicSample(1024)
    const session = await startEncryption(new Uint8Array(plain))
    const okDet = await addSignatureChannel(session, A.address, signWith(A))
    requireChannel(session)
    if (!okDet) {
      setStep(s1, 'failed', { error: 'signature channel not reproducible (should not happen for a local HDAccount)' })
      throw new Exit(2, 'signature channel not reproducible — aborting path A')
    }
    writeFileSync(path.join(artifacts, 'cipher.bin'), session.cipher)
    manifest = {
      version: 2,
      network: 'mainnet',
      rootCid: '', // filled after packing (A2)
      file: { name: plainName, size: plain.length, sha256: createHash('sha256').update(plain).digest('hex'), mimeType: 'application/octet-stream' },
      encryption: session.encryption,
      compression: null,
      uploader: { address: A.address },
      nodes: [],
      txs: [],
      submittedAt: new Date().toISOString(),
    }
    setStep(s1, 'checked', { note: `K in session memory only; cipher ${session.cipher.length}B · signature channel deterministic ✓` })
  }

  // A2 content on-chain: the ciphertext as a whole is packed → utility.batch remark → depth confirmation
  const s2 = step('A2-publish-content')
  if (s2.state !== 'checked') {
    setStep(s2, 'submitted')
    const { api, pair } = await consensusApi()
    const packed = await packFile(path.join(artifacts, 'cipher.bin'), plainName)
    manifest.rootCid = cidToString(packed.rootCid)
    manifest.nodes = packed.nodes.map((n) => ({ cid: cidToString(n.cid), blake3: nodeHashHex(n.cid), bytes: n.bytes.length }))
    const inclusions = await publishRemarkNodes(api, pair, packed.nodes.map((n) => n.bytes))
    manifest.txs = inclusions.map(({ txHash, blockHash, height }) => ({ txHash, blockHash, height }))
    console.log(`  content root=${manifest.rootCid} · ${manifest.nodes.length} nodes · block #${manifest.txs[0].height}`)
    await api.disconnect()
    writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)) // resume snapshot
    setStep(s2, 'checked', { note: `root ${manifest.rootCid.slice(0, 20)}… · block #${manifest.txs[0].height}` })
  } else {
    manifest = JSON.parse(readFileSync(path.join(artifacts, 'manifest.json'), 'utf8')) // A2 checked: the snapshot is authoritative
  }

  // A3 manifest re-enters the DSN (${rootCid}.manifest.json fixed name → content-addressed determinism)
  const s3 = step('A3-publish-manifest')
  let manifestCid
  let regHeight
  if (s3.state === 'checked') {
    manifestCid = s3.result.manifestCid
    regHeight = Number(s3.result.height)
  } else {
    setStep(s3, 'submitted')
    const err = validateManifest(manifest)
    if (err) throw new Exit(1, `manifest validation failed: ${err}`)
    const mPath = path.join(artifacts, `${manifest.rootCid}.manifest.json`)
    writeFileSync(mPath, JSON.stringify(manifest)) // same convention as the frontend: single-line JSON.stringify(manifest)
    const { api, pair } = await consensusApi()
    const packed = await packFile(mPath)
    const inclusions = await publishRemarkNodes(api, pair, packed.nodes.map((n) => n.bytes))
    manifestCid = cidToString(packed.rootCid)
    regHeight = inclusions[0].height
    await api.disconnect()
    setStep(s3, 'checked', { result: { manifestCid, height: regHeight }, note: `manifestCid ${manifestCid.slice(0, 20)}… · block #${regHeight}` })
  }

  // A4 Registry v2 registration (dev fee = max(minFee, size×feePerByte); overpay refunded)
  const s4 = step('A4-register')
  const registryAddr = RUN.input.registry
  const [fpb, minFee] = await Promise.all([
    withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: REGISTRY_ABI, functionName: 'feePerByte' })),
    withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: REGISTRY_ABI, functionName: 'minFee' })),
  ])
  const regSize = BigInt(manifest.file.size)
  const quote = regSize * fpb > minFee ? regSize * fpb : minFee
  const feePaid = BigInt(
    await txStep(
      s4,
      async () => {
        checkCap(quote, 'A4 register (dev fee)')
        const hash = await withRetry(() =>
          A.walletClient.writeContract({
            address: registryAddr, abi: REGISTRY_ABI, functionName: 'register',
            args: [manifestCid, regHeight, manifest.file.name, regSize],
            value: quote, chain: autoEvm,
          }),
        )
        const receipt = await withRetry(() => A.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 }))
        return { hash, receipt }
      },
      { parse: (rx) => String(eventsOf(rx, REGISTRY_ABI).find((e) => e.eventName === 'FeePaid')?.args?.amount ?? 0n) },
    ),
  )
  spend.fees += feePaid
  check(feePaid === quote, 'A4 FeePaid = quote (max(minFee, size×feePerByte))', ai3(quote))

  // A5 list on the production instance
  const keyA = keccak256(toHex(manifestCid))
  await txStep(step('A5-list'), async () => {
    checkCap(120_000n * 11n * 10n ** 9n, 'A5 setPrice')
    return v2write(A, mainAddr, 'setPrice', [keyA, price])
  })
  const a5fresh = isFresh('A16-unlist') // A16 checked ⇒ already delisted, the readback must be 0
  if (a5fresh) check((await v2read(A, mainAddr, 'listingPrice', [A.address, keyA])) === price, 'A5 production listing readback')

  // A6 buyer announces the encryption public key (idempotent: zero tx when already registered)
  await txStep(step('A6-announce-buyer'), async () => {
    const kpC = await localBoxKeypair(signWith(C), C.address)
    const pub64 = Buffer.from(kpC.publicKey).toString('base64')
    const onchain = await withRetry(() => C.publicClient.readContract({ address: RUN.input.mailbox, abi: mailboxAbis, functionName: 'keys', args: [C.address] }))
    if (onchain === pub64) return { hash: null, receipt: { status: 'success', gasUsed: 0n, effectiveGasPrice: 0n } }
    checkCap(80_000n * 11n * 10n ** 9n, 'A6 announce')
    const hash = await withRetry(() =>
      C.walletClient.writeContract({ address: RUN.input.mailbox, abi: mailboxAbis, functionName: 'announceEncryptionKey', args: [pub64], chain: autoEvm }),
    )
    const receipt = await withRetry(() => C.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 }))
    return { hash, receipt }
  })

  // A7 cross-address purchase (never a self-trade substitute; orderId parsed from
  // the receipt + purchase block recorded for the inbox scan)
  const a7fresh = isFresh('A7-purchase')
  const s7 = step('A7-purchase')
  await txStep(
    s7,
    async () => {
      checkCap(price, 'A7 purchase (escrowed)')
      return v2write(C, mainAddr, 'purchase', [keyA, A.address, price], price)
    },
    { parse: (rx) => ({ orderId: String(orderIdFromReceipt(rx)), block: Number(rx.blockNumber) }) },
  )
  const orderIdA = BigInt(s7.result.orderId)
  if (a7fresh) noteEscrow(price)
  const oA = await orderOf(A, mainAddr, orderIdA)
  if (a7fresh) {
    check(oA.state === 1 && oA.seller === A.address && oA.buyer === C.address, `A7 order(${orderIdA}) Escrowed, cross-address snapshot correct`)
    check(oA.price === price && oA.feeBps === 1000, 'A7 price/feeBps snapshot correct')
  }

  // A8 pdgrant delivery: unwrap K → wrap to the buyer's public key → v2 bindings
  // (chainId/paywall/orderId/buyer/seller) → Mailbox send
  await txStep(step('A8-send-grant'), async () => {
    const K = await unwrapKeyWithSigner(manifest, A)
    const kpC = await localBoxKeypair(signWith(C), C.address)
    const inner = boxEncrypt(kpC.publicKey, K)
    const grant = {
      type: 'pdgrant',
      manifestCid,
      wrappedK: JSON.stringify(inner),
      v: 2,
      chainId: 870,
      paywall: mainAddr,
      orderId: String(orderIdA),
      buyer: C.address.toLowerCase(),
      seller: A.address.toLowerCase(),
    }
    checkCap(120_000n * 11n * 10n ** 9n, 'A8 mailbox send')
    const hash = await withRetry(() =>
      A.walletClient.writeContract({
        address: RUN.input.mailbox, abi: mailboxAbis, functionName: 'send',
        args: [C.address, JSON.stringify(grant)], chain: autoEvm, // message body = the pdgrant JSON (envelope nested inside)
      }),
    )
    const receipt = await withRetry(() => A.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 }))
    return { hash, receipt }
  })

  // A9 markDelivered
  const a9fresh = isFresh('A9-deliver')
  await txStep(step('A9-deliver'), async () => v2write(A, mainAddr, 'markDelivered', [orderIdA]))
  if (a9fresh) check((await orderOf(A, mainAddr, orderIdA)).state === 2, 'A9 markDelivered: Delivered')

  // A10 buyer receives: decrypt the pdgrant + R05 v2 binding validation
  // (mismatched/forged candidates are always skipped)
  const s10 = step('A10-receive-grant')
  let Kbuyer
  {
    setStep(s10, 'submitted')
    const kpC = await localBoxKeypair(signWith(C), C.address)
    const fromBlock = Math.max(RUN.input.mailboxDeployBlock, s7.result.block - 4)
    const latest = Number(await withRetry(() => C.publicClient.getBlockNumber()))
    const logs = []
    for (let start = fromBlock; start <= latest; start += 10_000) {
      const part = await withRetry(() =>
        C.publicClient.getLogs({
          address: RUN.input.mailbox, event: MSG_SENT, args: { to: C.address },
          fromBlock: BigInt(start), toBlock: BigInt(Math.min(start + 9_999, latest)),
        }),
      )
      logs.push(...part)
    }
    let found = null
    for (const l of logs.reverse()) {
      if (l.args.from?.toLowerCase() !== A.address.toLowerCase()) continue
      let g
      try {
        g = JSON.parse(new TextDecoder().decode(boxDecryptWithSecretKey(parseEnvelope(l.args.content), kpC.secretKey)))
      } catch {
        continue // someone else's ciphertext / not JSON, skip
      }
      if (g?.type !== 'pdgrant' || g.manifestCid !== manifestCid) continue
      if (g.v !== 2 || g.chainId !== 870 || String(g.paywall).toLowerCase() !== mainAddr.toLowerCase()) continue
      if (String(g.orderId) !== String(orderIdA) || String(g.buyer).toLowerCase() !== C.address.toLowerCase() || String(g.seller).toLowerCase() !== A.address.toLowerCase()) continue
      found = g
      break
    }
    if (!found) {
      setStep(s10, 'failed', { error: 'no pdgrant with fully matching v2 bindings in the inbox' })
      throw new Exit(1, 'A10 no bound pdgrant found')
    }
    Kbuyer = boxDecryptWithSecretKey(parseEnvelope(found.wrappedK), kpC.secretKey)
    setStep(s10, 'checked', { note: `pdgrant v2 binding validation passed (orderId ${orderIdA})` })
  }

  // A11 buyer recovers the manifest from the Registry entry via the height hint
  // (no dependency on the seller's local state)
  const s11 = step('A11-recover-manifest')
  let manifestBuyer
  {
    setStep(s11, 'submitted')
    const entries = await withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: REGISTRY_ABI, functionName: 'entries', args: [A.address] }))
    const entry = entries.find((e) => e.manifestCid === manifestCid)
    if (!entry) {
      setStep(s11, 'failed', { error: `Registry entries(A) has no ${manifestCid}` })
      throw new Exit(1, 'A11 directory entry missing')
    }
    const api = await connectApi(CONSENSUS_RPC)
    let recovered = null
    for (let h = Number(entry.height); h <= Number(entry.height) + 3; h++) {
      const bh = await api.rpc.chain.getBlockHash(h)
      if (bh.toHex() === '0x' + '0'.repeat(64)) continue
      const { found } = await extractRemarkNodes(api, bh.toHex())
      if (!found.get(manifestCid)) continue
      const { bytes } = assemble(stringToCid(manifestCid), (cid) => found.get(cidToString(cid))?.bytes)
      recovered = JSON.parse(new TextDecoder().decode(bytes))
      break
    }
    await api.disconnect()
    if (!recovered) {
      setStep(s11, 'failed', { error: `blocks [${entry.height}, ${Number(entry.height) + 3}] did not hit the manifest root` })
      throw new Exit(1, 'A11 manifest recovery failed')
    }
    const err = validateManifest(recovered)
    if (err) {
      setStep(s11, 'failed', { error: `recovered manifest invalid: ${err}` })
      throw new Exit(1, 'A11 manifest validation failed')
    }
    manifestBuyer = recovered
    setStep(s11, 'checked', { note: `height hint ${entry.height} · v${recovered.version} · ${recovered.nodes.length} nodes` })
  }

  // A12 buyer retrieves the ciphertext on-chain + R09 integrity gate
  // (cipherSha256/cipherSize first)
  const s12 = step('A12-retrieve-cipher')
  let cipher
  {
    setStep(s12, 'submitted')
    const api = await connectApi(CONSENSUS_RPC)
    const wanted = new Set(manifestBuyer.nodes.map((n) => n.cid))
    const bytesByCid = new Map()
    for (const { blockHash } of manifestBuyer.txs) {
      let hash = blockHash
      for (let hop = 0; hop < 4 && wanted.size > bytesByCid.size; hop++) {
        const { found } = await extractRemarkNodes(api, hash)
        for (const [cid, ent] of found) if (wanted.has(cid)) bytesByCid.set(cid, ent.bytes)
        if (wanted.size === bytesByCid.size) break
        hash = (await api.rpc.chain.getBlock(hash)).block.header.parentHash.toHex()
      }
      if (wanted.size === bytesByCid.size) break
    }
    await api.disconnect()
    const missing = [...wanted].filter((cid) => !bytesByCid.has(cid))
    if (missing.length > 0) {
      setStep(s12, 'failed', { error: `missing nodes on-chain: ${missing.join(', ')}` })
      throw new Exit(1, 'A12 on-chain retrieval incomplete')
    }
    const { bytes } = assemble(stringToCid(manifestBuyer.rootCid), (cid) => bytesByCid.get(cidToString(cid)))
    cipher = new Uint8Array(bytes)
    const cipherSha = createHash('sha256').update(cipher).digest('hex')
    check(cipherSha === manifestBuyer.encryption.cipherSha256 && cipher.length === manifestBuyer.encryption.cipherSize, 'A12 ciphertext integrity gate (cipherSha256/cipherSize)')
    setStep(s12, 'checked', { note: `${cipher.length}B ciphertext` })
  }

  // A13 decrypt + verify plaintext (buyer K comes from the pdgrant; plaintext
  // sha256 must equal manifest.file.sha256)
  {
    const s13 = step('A13-decrypt-verify')
    setStep(s13, 'submitted')
    const plain = await aesGcmDecrypt(Kbuyer, fromHex(manifestBuyer.encryption.iv), cipher)
    const sha = createHash('sha256').update(plain).digest('hex')
    check(sha === manifestBuyer.file.sha256, 'A13 plaintext sha256 matches (decrypt + integrity)', `${sha.slice(0, 16)}…`)
    setStep(s13, 'checked', {})
  }

  // A14 confirm receipt → Released (event net/fee checked against the snapshot feeBps)
  const a14fresh = isFresh('A14-confirm')
  const settle = await txStep(
    step('A14-confirm'),
    async () => {
      checkCap(120_000n * 11n * 10n ** 9n, 'A14 confirmReceipt')
      return v2write(C, mainAddr, 'confirmReceipt', [orderIdA])
    },
    { parse: (rx) => {
      const ev = eventsOf(rx, abis).find((e) => e.eventName === 'Released')
      return { net: String(ev?.args?.net ?? 0n), fee: String(ev?.args?.fee ?? 0n) }
    } },
  )
  if (a14fresh) noteEscrow(-price)
  const expectedFee = (price * BigInt(oA.feeBps)) / 10_000n
  check((await orderOf(A, mainAddr, orderIdA)).state === 3, 'A14 Released terminal state')
  check(BigInt(settle.fee) === expectedFee && BigInt(settle.net) === price - expectedFee, 'A14 Released event net/fee per the snapshot feeBps rule', `fee ${ai3(expectedFee)} · net ${ai3(price - expectedFee)}`)
  if (a14fresh) spend.fees += expectedFee // fee → treasury(=A): self-paid self-received, net loss 0, but tracked as non-refundable

  // A15 withdraw: against the total credits taken immediately before (must not
  // mask historic credits)
  {
    const s15 = step('A15-withdraw')
    if (s15.state === 'checked') {
      console.log('  [A15] resume: withdrawal already completed, skipping')
    } else {
      const creditsBefore = BigInt(await v2read(A, mainAddr, 'credits', [A.address]))
      if (creditsBefore === 0n) {
        setStep(s15, 'checked', { note: 'credits are 0 (or already withdrawn) — withdrawal skipped, noted in the report' })
      } else {
        const a0 = BigInt(await bal(A))
        const wdGas = await txStep(s15, async () => {
          checkCap(80_000n * 11n * 10n ** 9n, 'A15 withdraw')
          return v2write(A, mainAddr, 'withdraw', [])
        }, { parse: gasStr }).then(BigInt)
        const a1 = BigInt(await bal(A))
        check(a1 - a0 + wdGas === creditsBefore, 'A15 balance delta + gas = pre-withdraw credits', `credits ${ai3(creditsBefore)}`)
      }
    }
  }

  // A16 delist (the order is already Released; unaffected)
  await txStep(step('A16-unlist'), async () => v2write(A, mainAddr, 'setPrice', [keyA, 0n]))
  check((await v2read(A, mainAddr, 'listingPrice', [A.address, keyA])) === 0n, 'A16 delisted')

  res.orderId = String(orderIdA)
  res.manifestCid = manifestCid
  res.finalState = 'released'
  return res
}

// ---------- legacy instance read-only inventory (release-gate prerequisite) ----------

async function scanLogs(client, address, eventName, fromBlock, toBlock) {
  const event = V1_ABI.find((x) => x.type === 'event' && x.name === eventName)
  const out = []
  const fails = []
  for (let start = fromBlock; start <= toBlock; start += 10_000) {
    const to = Math.min(start + 9_999, toBlock)
    for (let t = 0; t < 5; t++) {
      try {
        out.push(...(await client.getLogs({ address, event, fromBlock: BigInt(start), toBlock: BigInt(to) })))
        break
      } catch (e) {
        if (t === 4) fails.push(`${eventName}@${start}-${to}: ${String(e.message).slice(0, 80)}`)
        else await new Promise((r) => setTimeout(r, 1500 * 2 ** t))
      }
    }
  }
  return { logs: out, fails }
}

async function inventoryLegacy(instance, label) {
  const { address } = instance
  const from = Number(instance.blockNumber)
  const head = Number(await withRetry(() => A.publicClient.getBlockNumber()))
  const headHash = String((await withRetry(() => A.publicClient.getBlock({ blockNumber: BigInt(head) }))).hash)
  console.log(`  [${label}] ${address} · range [${from}, ${head}] (frozen at block ${head})`)

  const names = ['Listed', 'Unlisted', 'Purchased', 'Delivered', 'Released', 'Refunded', 'Withdrawn']
  const fails = []
  const by = {}
  for (const n of names) {
    const r = await scanLogs(A.publicClient, address, n, from, head)
    by[n] = r.logs
    fails.push(...r.fails)
    console.log(`    ${n} × ${r.logs.length}`)
  }
  if (fails.length > 0) console.warn(`    ⚠ range scan failures (after backoff retries): ${fails.join(' | ')}`)

  // (key,buyer) pairs → current deal state; the address universe comes from all
  // log fields (covers sellers/buyers/treasury)
  const pairs = new Set()
  for (const n of ['Purchased', 'Delivered', 'Released', 'Refunded']) {
    for (const l of by[n]) pairs.add(`${l.args.key}|${l.args.buyer}`)
  }
  const orders = []
  for (const kb of pairs) {
    const key = kb.slice(0, 66)
    const buyer = kb.slice(67)
    // human-readable ABI multi-returns decode as an unnamed array in viem (pit 26
    // family) — destructure positionally
    const [dBuyer, dPrice, dState, dPurchasedAt, dDeliveredAt] = await withRetry(() =>
      A.publicClient.readContract({ address, abi: V1_ABI, functionName: 'deal', args: [key, buyer] }),
    )
    const st = STATE_NAME[Number(dState)]
    if (st === 'none') continue
    const [lSeller] = await withRetry(() =>
      A.publicClient.readContract({ address, abi: V1_ABI, functionName: 'listings', args: [key] }),
    )
    const deadline = st === 'escrowed'
      ? Number(dPurchasedAt) + Number(instance.deliveryTimeout ?? 0)
      : st === 'delivered'
        ? Number(dDeliveredAt) + Number(instance.gracePeriod ?? 0)
        : null
    orders.push({
      key, buyer, price: String(dPrice), state: st,
      purchasedAt: Number(dPurchasedAt), deliveredAt: Number(dDeliveredAt),
      currentListingSeller: String(lSeller), currentListingPrice: null, // listings' second return (price) intentionally not shown, to avoid misreading it as the deal price
      action: deadline == null ? `terminal (${st})` : deadline <= Math.floor(Date.now() / 1000) ? 'refund-now (buyer can refund)' : `refund-at ${new Date(deadline * 1000).toISOString()}`,
    })
  }

  const addrSet = new Set(['0x0000000000000000000000000000000000000000'])
  if (instance.treasury) addrSet.add(String(instance.treasury).toLowerCase())
  for (const n of names) {
    for (const l of by[n]) {
      for (const v of Object.values(l.args)) {
        if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) addrSet.add(v.toLowerCase())
      }
    }
  }
  const credits = {}
  for (const a of addrSet) {
    const c = await withRetry(() => A.publicClient.readContract({ address, abi: V1_ABI, functionName: 'credits', args: [a] }))
    if (c > 0n) credits[a] = String(c)
  }

  const contractBal = await withRetry(() => A.publicClient.getBalance({ address }))
  let escrow = 0n
  for (const o of orders) if (o.state === 'escrowed' || o.state === 'delivered') escrow += BigInt(o.price)
  const creditsSum = Object.values(credits).reduce((acc, v) => acc + BigInt(v), 0n)

  return {
    label, address, fromBlock: from, toBlock: head, headHash,
    logCounts: Object.fromEntries(names.map((n) => [n, by[n].length])),
    logFailures: fails,
    activeOrders: orders.filter((o) => o.state === 'escrowed' || o.state === 'delivered'),
    terminalOrders: orders.filter((o) => o.state === 'released' || o.state === 'refunded'),
    credits, contractBalance: String(contractBal), escrowSum: String(escrow), creditsSum: String(creditsSum),
    reconciliationDiff: String(BigInt(contractBal) - escrow - creditsSum),
    caveat: 'v1 has no seller snapshot: currentListingSeller is only the current listing holder and cannot prove the deal seller; refunded/released orders are excluded from the escrow balance.',
  }
}

// ---------- preflight ----------

const OFFLINE_TESTS = [
  ['paywall-v2-test', 'scripts/p4/paywall-v2-test.mjs'],
  ['file-crypto-selftest', 'scripts/p4/file-crypto-selftest.mjs'],
  ['vault-crypto-selftest', 'scripts/p3/vault-crypto-selftest.mjs'],
  ['paywall-guard-test', 'scripts/verify/paywall-guard-test.mjs'],
  ['publish-error-test', 'scripts/verify/publish-error-test.mjs'],
  ['mailbox-store-test', 'scripts/verify/mailbox-store-test.mjs'],
  ['rpc-pacer-test', 'scripts/verify/rpc-pacer-test.mjs'],
]

async function preflight() {
  console.log('=== PaywallV2 on-chain acceptance · read-only preflight (zero cost) ===')
  const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
  const chainId = await withRetry(() => A.publicClient.getChainId())
  const report = { kind: 'preflight', commit: COMMIT, chainId, at: new Date().toISOString() }

  if (chainId !== 870) throw new Exit(2, `chainId ${chainId} ≠ 870 — stopping (no tx will be sent)`)

  // 1. legacy paywall inventory on both instances (read-only, precedes any fund
  // disposition)
  report.blocks = {}
  for (const [key, label] of [['auto-evm-mainnet-paywall', 'v1-main'], ['auto-evm-mainnet-paywall-test', 'v1-test']]) {
    if (!deployments[key]) {
      report.blocks[label] = { error: 'instance missing from deployments.json' }
      continue
    }
    report.blocks[label] = await inventoryLegacy(deployments[key], label)
  }

  // 2. v2 deployment status (undeployed → recorded as such; expected before deployment)
  report.v2 = {}
  const artifact = JSON.parse(readFileSync(V2_ARTIFACT, 'utf8'))
  const { patchImmutablesMulti } = await import('../p3/lib/chain.mjs')
  for (const key of ['auto-evm-mainnet-paywall-v2', 'auto-evm-mainnet-paywall-v2-test']) {
    const d = deployments[key]
    if (!d) {
      report.v2[key] = { deployed: false, note: 'not deployed (expected; deployment is a separate step)' }
      continue
    }
    const expected = patchImmutablesMulti(artifact, {
      treasury: d.treasury, deliveryTimeout: BigInt(d.deliveryTimeout), gracePeriod: BigInt(d.gracePeriod),
    })
    const code = await withRetry(() => A.publicClient.getCode({ address: d.address }))
    const [treasury, feeBps, dt, gp] = await Promise.all(
      ['treasury', 'feeBps', 'deliveryTimeout', 'gracePeriod'].map((f) => withRetry(() => A.publicClient.readContract({ address: d.address, abi: artifact.abi, functionName: f }))),
    )
    report.v2[key] = {
      deployed: true, address: d.address, txHash: d.txHash, blockNumber: d.blockNumber, codeMatch: code === expected,
      readback: { treasury: String(treasury), feeBps: Number(feeBps), deliveryTimeout: Number(dt), gracePeriod: Number(gp) },
      orderCount: String(await withRetry(() => A.publicClient.readContract({ address: d.address, abi: artifact.abi, functionName: 'orderCount' }))),
    }
  }

  // 3. role balances & gas estimate
  const [balA, balC, gasPrice] = await Promise.all([bal(A), bal(C), withRetry(() => A.publicClient.getGasPrice())])
  report.roles = {
    A: { address: A.address, balance: String(balA) },
    C: { address: C.address, balance: String(balC) },
    gasPrice: String(gasPrice),
    perTxEstimate: `${ai3(150_000n * gasPrice)}/tx (150k gas upper bound)`,
  }

  // 4. Mailbox announcement status (A/C)
  const mailbox = deployments['auto-evm-mainnet-mailbox']
  report.mailbox = { address: mailbox?.address, deployBlock: mailbox?.blockNumber }
  if (mailbox) {
    for (const [n, c] of [['A', A], ['C', C]]) {
      const k = await withRetry(() => c.publicClient.readContract({ address: mailbox.address, abi: mailboxAbis, functionName: 'keys', args: [c.address] }))
      report.mailbox[`${n}Announced`] = k !== ''
    }
  }

  // 5. offline test evidence (--skip-tests to skip)
  if (!hasFlag('skip-tests')) {
    report.offlineTests = {}
    for (const [name, rel] of OFFLINE_TESTS) {
      const p = path.join(ROOT, rel)
      if (!existsSync(p)) {
        report.offlineTests[name] = { exit: null, note: 'script missing' }
        continue
      }
      const t0 = Date.now()
      const r = spawnSync('node', [p], { cwd: path.dirname(p), encoding: 'utf8', timeout: 300_000 })
      report.offlineTests[name] = { exit: r.status, ms: Date.now() - t0, tail: (r.stdout ?? '').split('\n').filter(Boolean).slice(-1).join('').slice(0, 160) }
      console.log(`  offline ${name}: exit=${r.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    }
  }

  mkdirSync(OUT_BASE, { recursive: true })
  const outFile = path.join(OUT_BASE, `preflight-${report.at.slice(0, 19).replace(/[:T]/g, '-')}.json`)
  writeFileSync(outFile, JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
  console.log(`\npreflight report: ${outFile}`)

  for (const b of Object.values(report.blocks)) {
    if (!b.activeOrders) continue
    console.log(`\n[${b.label}] active orders ${b.activeOrders.length} · terminal ${b.terminalOrders.length} · reconciliation diff ${b.reconciliationDiff} wei`)
    if (b.reconciliationDiff !== '0') console.warn(`  ⚠ balance reconciliation off (${b.reconciliationDiff} wei) — must be explained/disposed before deployment`)
    for (const o of b.activeOrders) console.log(`  · ${o.state} buyer=${o.buyer} price=${ai3(BigInt(o.price))} → ${o.action}`)
  }
  const v2main = report.v2['auto-evm-mainnet-paywall-v2']
  console.log(`\nv2 production instance: ${v2main?.deployed ? `${v2main.address} (code ${v2main.codeMatch ? 'identical ✓' : 'MISMATCH ✗'})` : 'not deployed (expected)'}`)
  const testsFailed = Object.entries(report.offlineTests ?? {}).filter(([, r]) => r.exit !== 0)
  if (testsFailed.length > 0) {
    console.warn(`\n✗ offline tests not all green: ${testsFailed.map(([n, r]) => `${n}(exit ${r.exit})`).join(', ')} — preflight failed, deployment forbidden`)
    process.exitCode = 1
  } else {
    console.log('offline tests: all passed (or skipped via --skip-tests)')
  }
}

// ---------- report / summary ----------

async function finish({ status } = {}) {
  const steps = RUN.journal.steps
  const failed = steps.filter((s) => s.state === 'failed' || s.state === 'unknown')
  const report = {
    kind: 'acceptance', runId: RUN.id, commit: RUN.input.commit, chainId: 870,
    instances: RUN.input.instances, price: RUN.input.price, cap: RUN.input.cap, capWei: String(RUN.input.capWei),
    startedAt: RUN.input.startedAt, finishedAt: new Date().toISOString(),
    spend: {
      gas: String(spend.gas), fees: String(spend.fees),
      consensusApprox: String(spend.consensus), escrowOutstanding: String(spend.escrow),
    },
    balancesAtFinish: {
      A: String(await bal(A)), C: String(await bal(C)),
      credits_v2_main: String(await v2read(A, RUN.input.instances.main, 'credits', [A.address])),
      credits_v2_test: String(await v2read(A, RUN.input.instances.test, 'credits', [A.address])),
    },
    steps: steps.map(({ id, state, txHash, note, error, nextEligibleAt }) => ({ id, state, txHash, note, error, nextEligibleAt })),
    failedSteps: failed.map((s) => ({ id: s.id, error: s.error ?? s.note })),
    ordersCreated: steps
      .filter((s) => ['B2-purchase', 'C2-purchase', 'A7-purchase'].includes(s.id))
      .map((s) => ({ step: s.id, orderId: s.result?.orderId ?? s.result })),
    status: status ?? (failed.length > 0 ? 'failed' : 'passed'),
  }
  jwrite('report.json', report)

  const exitCode = status === 'waiting' ? 3 : failed.length > 0 ? 1 : 0
  const lines = [
    `# PaywallV2 on-chain acceptance · ${RUN.id}`, '',
    `- commit: \`${report.commit}\` · chainId ${report.chainId}`,
    `- instances: main \`${RUN.input.instances.main}\` · test \`${RUN.input.instances.test}\``,
    `- spend: gas ${ai3(spend.gas)} · fees ${ai3(spend.fees)} · consensus ≈${ai3(spend.consensus)} · escrow outstanding ${ai3(spend.escrow)}`,
    `- orders: ${report.ordersCreated.map((o) => `${o.step}→#${o.orderId}`).join(' · ') || '(none)'}`, '',
    '| step | state | tx | note |', '|---|---|---|---|',
    ...steps.map((s) => `| ${s.id} | ${s.state} | ${s.txHash ? String(s.txHash).slice(0, 18) + '…' : ''} | ${s.note ?? s.error ?? ''} |`),
    '', `**Verdict: ${report.status.toUpperCase()}** (suggested exit code ${exitCode})`,
  ]
  writeFileSync(path.join(RUN.dir, 'summary.md'), lines.join('\n') + '\n')
  return { report, exitCode }
}

// ---------- run / resume ----------

async function runOrResume(resumeMode) {
  const runId = flag('run-id')
  if (!runId) throw new Exit(2, 'run/resume requires --run-id (the runbook demands an explicit runId + spend cap before any writes)')
  RUN = loadRun(runId, { forWrite: true })

  const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
  const mainD = deployments['auto-evm-mainnet-paywall-v2']
  const testD = deployments['auto-evm-mainnet-paywall-v2-test']
  if (!mainD || !testD) throw new Exit(2, 'PaywallV2 not deployed (deployments.json lacks the v2 keys) — run the deployment step first')

  if (!RUN.input) {
    if (resumeMode) throw new Exit(2, `runId ${runId} has no input.json; cannot resume`)
    const [balA, balC, creditsMain0, creditsTest0, contractMain, contractTest] = await Promise.all([
      bal(A), bal(C),
      v2read(A, mainD.address, 'credits', [A.address]), v2read(A, testD.address, 'credits', [A.address]),
      A.publicClient.getBalance({ address: mainD.address }), A.publicClient.getBalance({ address: testD.address }),
    ])
    RUN.input = {
      runId, commit: COMMIT, chainId: 870, startedAt: new Date().toISOString(),
      instances: { main: mainD.address, test: testD.address },
      registry: deployments['auto-evm-mainnet-v2'].address,
      mailbox: deployments['auto-evm-mainnet-mailbox'].address,
      mailboxDeployBlock: Number(deployments['auto-evm-mainnet-mailbox'].blockNumber),
      roles: { A: A.address, C: C.address },
      price: flag('price', PRICE_DEFAULT),
      cap: flag('cap', '0.05'),
      capWei: String(toWei(flag('cap', '0.05'))),
      baseline: {
        balanceA: String(balA), balanceC: String(balC),
        creditsMain: String(creditsMain0), creditsTest: String(creditsTest0),
        contractMain: String(contractMain), contractTest: String(contractTest),
      },
    }
    console.log(`run ${runId} initialized: price=${RUN.input.price} AI3 · cap=${RUN.input.cap} AI3 · A=${A.address} · C=${C.address}`)
  } else if (!resumeMode) {
    throw new Exit(2, `runId ${runId} already has input.json — pick a new runId or use resume (the runbook forbids overwriting old records)`)
  }
  RUN.journal.runId = runId
  restoreSpend()
  jwrite('journal.json', RUN.journal)

  // write gate: both v2 instances live on-chain with timeout params matching the
  // deployment records (a failed preflight forbids writes)
  const [dtMain, dtTest] = [Number(await v2read(A, RUN.input.instances.main, 'deliveryTimeout')), Number(await v2read(A, RUN.input.instances.test, 'deliveryTimeout'))]
  if (dtMain !== 259_200 || dtTest !== 300) throw new Exit(2, `v2 instance params mismatch the deployment records (main ${dtMain}s / test ${dtTest}s) — stopping`)

  // buyer gas gate: the runner never auto-funds (read-only checks must not move
  // funds); an underfunded buyer blocks with explicit funding instructions
  const balC = await bal(C)
  const minC = price * 3n + 10n ** 16n // headroom for 3 escrowed purchases + 0.01 AI3 gas
  if (balC < minC) {
    throw new Exit(2, `buyer C balance ${ai3(balC)} < minimum ${ai3(minC)} (${ai3(price)}×3 escrowed + gas headroom) — fund from A first, e.g. A.walletClient.sendTransaction({ to: '${C.address}', value: 10n ** 17n })`)
  }

  const price = toWei(RUN.input.price)
  const paths = resumeMode
    ? [...new Set(RUN.journal.steps.map((s) => s.id[0].toLowerCase()))].filter((p) => 'bca'.includes(p))
    : (flag('paths', 'b,c,a')).split(',').map((s) => s.trim().toLowerCase())
  const queue = paths.filter((p) => ['b', 'c', 'a'].includes(p))
  if (queue.length === 0) throw new Exit(2, 'no valid paths (choose from b,c,a)')
  const results = []

  // per-path prelude: snapshot the buyer balance baseline (for the refund
  // assertions) — only when the asserting step has not run yet, so a resume never
  // overwrites the historical baseline with today's balance
  RUN.journal.balances = RUN.journal.balances ?? {}
  RUN.journal.balances.C = RUN.journal.balances.C ?? {}
  if (queue.includes('c')) {
    if (isFresh('C4-refund-in-grace')) {
      RUN.journal.balances.C.beforeC4 = String(await bal(C))
      jwrite('journal.json', RUN.journal)
    }
    results.push(await pathC(RUN.input.instances.test, price))
  }
  if (queue.includes('b')) {
    if (isFresh('B5-refund')) {
      RUN.journal.balances.C.beforeB5 = String(await bal(C))
      jwrite('journal.json', RUN.journal)
    }
    results.push(await pathB(RUN.input.instances.test, price))
  }
  if (queue.includes('a')) results.push(await pathA(RUN.input.instances.main, price))

  const { report, exitCode } = await finish({ status: 'passed' })
  console.log(`\n═══ acceptance run ${runId} finished: ${results.map((r) => `path ${r.path} ${r.finalState}`).join(' · ')} ═══`)
  console.log(`report: ${path.join(RUN.dir, 'report.json')} · ${path.join(RUN.dir, 'summary.md')}`)
  process.exitCode = exitCode
}

// ---------- main ----------

try {
  if (cmd === 'preflight') await preflight()
  else if (cmd === 'run') await runOrResume(false)
  else if (cmd === 'resume') await runOrResume(true)
  else if (cmd === 'report') {
    RUN = loadRun(flag('run-id'), { forWrite: false })
    if (!RUN.input) throw new Exit(2, 'this runId has no input.json')
    restoreSpend()
    const { exitCode } = await finish({ status: null })
    process.exitCode = exitCode
    console.log('report/summary recomputed')
  } else {
    console.log('usage: node acceptance.mjs preflight | run --run-id <id> --cap <AI3> [--paths b,c,a] [--price 0.01] | resume --run-id <id> | report --run-id <id>')
    process.exitCode = 2
  }
} catch (e) {
  if (e instanceof Exit) {
    console.error(`\n✗ ${e.message}`)
    process.exitCode = e.code
  } else {
    console.error('\n✗ unexpected error:', e)
    process.exitCode = 1
  }
}
