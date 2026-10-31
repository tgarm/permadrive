// P4 · DirectSales on-chain acceptance runner — orchestration core (transport-agnostic,
// offline fault-injection testable).
//
// Product direction change (direct sales, 2026-10-31): new sales use direct
// pay-and-split with no refunds and positive/negative ratings; this runner was
// rewritten from the PaywallV2 escrow acceptance into a direct-sales acceptance.
// The escrow refund paths B/C are retired (PaywallV2 deployment is paused; the
// historical scheme lives in the escrow-era records). All of the runner-hardening
// infrastructure carries over unchanged: pre-signed hash persisted before
// broadcast, single submission, budget gates, journal-based resume, per-role
// funds ledger reconciliation, exit-code semantics.
//
// This file contains no endpoints and no key loading: every chain access is injected
// via createRunner(deps) —
//   deps.A / deps.C                 client objects (address + account + publicClient + walletClient)
//   deps.abis / mailboxAbis / registryAbi   the three ABIs (abis = DirectSales)
//   deps.artifactSales              DirectSales build artifact (for on-chain code comparison)
//   deps.deployments                parsed contracts/deployments.json
//   deps.consensus.connect()        → { api, pair } (consensus chain connection + signing pair)
//   deps.consensus.extract(api, hash) → { block, found: Map<cidString, {bytes}> }
//   deps.now() / deps.sleep(ms)     clock and waiting (defaults Date.now / setTimeout)
//   deps.OUT_BASE / deps.ROOT       record directory base / repo root (locates offline tests)
//   deps.COMMIT                     current commit (frozen into input.json)
//   deps.offlineTests / spawnOffline / pollMs / confirmDepth
//
// Thin CLI wrapper: scripts/p4/acceptance.mjs; offline fault-injection tests: acceptance-test.mjs.
//
// Runner-hardening notes (all implemented here, item by item; the infrastructure
// carries over from the escrow era):
//  1. Price parsing/positivity and budget-legality checks run first in runOrResume
//     (the original code hit a TDZ ReferenceError).
//  2. input.json is atomically persisted before any broadcast, freezing runId/commit/
//     chainId/instances/roles/price/cap and the FULL path list; resume verifies each
//     item against the current environment (drift → open a new runId) and always
//     restores paths from the frozen plan (never re-derived from existing steps, so
//     not-yet-started paths cannot be lost).
//  3. Writes are four-phase: prepare (gas estimation, reverts surface here with zero
//     broadcast) → sign (local signing yields the hash) → [hash persisted BEFORE
//     broadcast] → broadcast (never blindly retried) → wait (poll-by-hash, retryable).
//     A lost broadcast response / receipt timeout leaves submitted+txHash; submitted/
//     unknown steps are verified read-only by hash and, if unverifiable, all new writes
//     stop (exit 2). Never resend.
//  4. Consensus publishing performs exactly one author.submitExtrinsic (the wait side,
//     awaitConfirmed, only scans blocks and never resends); submit errors / scan timeouts
//     → unknown halt; no per-tx degradation (unknown results never auto-degrade).
//  5. Full-amount assertion baseline = a snapshot taken immediately before the tx send
//     (balance + block number); the assertion always runs — fresh uses the snapshot,
//     resume recomputes via the historical-block method; if the RPC cannot serve
//     historical balances → pendingVerify and finish refuses "passed" (never skip an
//     assertion and still claim success).
//  6. checkCap = gas + fees + consensus + this write's estimate + open-tx estimates;
//     safe-finish steps (delist etc.) have a separate FINISH_RESERVE whose use is
//     recorded in the report.
//  7. finish enforces strict gates (all mandatory paths complete, assertion evidence
//     present and passing, no planned/submitted/unknown/failed steps, sales contract
//     balance zero, per-role funds ledger reconciled, order ids recorded); preflight
//     turns codeMatch/log-scan gaps/balance diffs/offline tests into hard gates.
//     Inventory reads all pin the same blockNumber to avoid mixed time points.
//
// Funds ledger (journal.flow[actor]): every confirmed tx records { step, out, in }
// (out includes gas plus this tx's value/fee; in is on-chain inflow to that actor);
// fee deltas are tied to txStep's costed transition (idempotent — resume re-entry
// never double-counts). finish reconciles per role:
// "expected = baseline − Σout + Σin" must equal the actual balance exactly.
//
// Record directory <OUT_BASE>/<runId>/ (covered by the .gitignore out/ rule):
//   input.json   frozen inputs (above) + pre-run baseline balances
//   journal.json step state machine planned → submitted → confirmed → checked (failed/
//                unknown semantics per note 3) + spend/assertions/flow/balances
//   report.json  per-path verdict + gates + funds reconciliation (all big integers as
//                decimal strings)
//   summary.md   human-readable conclusion (generated from the same source)
//
// Discipline:
//   - records never contain mnemonics, raw signatures, the data key K, or plaintext key
//     material; K is re-derived on demand via the seller's signature channel
//   - orderId always parsed from the purchase receipt's Purchased event (never read off
//     orderCount)
//   - full-amount assertions "balance delta + gas = expected" anchor to the tight
//     pre-tx baseline
//   - waits anchor to on-chain timestamps, never the local clock; long waits persist
//     nextEligibleAt and exit (code 3) for resume
//   - exit codes: 0 all mandatory paths pass; 1 definite failure; 2 blocked / unknown /
//     incomplete; 3 waiting for on-chain time

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { ai3, patchImmutablesMulti } from '../../p3/lib/chain.mjs'
import { awaitConfirmed } from '../../poc/lib/chain.mjs'
import { assemble, cidToString, makeRemarkPayload, nodeHashHex, packFile, stringToCid } from '../../poc/lib/dag.mjs'
import { decodeEventLog, encodeFunctionData, keccak256, parseAbiItem, toHex } from 'viem'
import {
  addSignatureChannel,
  requireChannel,
  startEncryption,
} from '../../../frontend/src/lib/fileCrypto.ts'
import { validateManifest } from '../../../frontend/src/lib/manifest.ts'
import {
  boxDecryptWithSecretKey,
  boxEncrypt,
  localBoxKeypair,
  parseEnvelope,
  serializeEnvelope,
} from '../../../frontend/src/lib/boxCrypto.ts'
import { aesGcmDecrypt, tryUnwrapWithSignature } from '../../../frontend/src/lib/vaultCrypto.ts'
import { fromHex } from '../../../frontend/src/lib/bytes.ts'

// ---------- constants & utilities ----------

export const PRICE_DEFAULT = '0.01'
export const CAP_DEFAULT = '0.1' // covers the purchases + dev fee + consensus byte fee + safe-finish reserve
export const CHAIN_ID_EXPECTED = 870
// suite marker: a DirectSales-dedicated suite, isolated from the escrow-era run
// records; input.json freezes the suite and resume rejects a mismatch outright
export const SUITE = 'direct-sales-v1'

// Separate safe-finish reserve: 3 writes (worst case) × 150k gas × 30 gwei upper
// bound. Regular writes must not eat into it; only "essential" steps may use it to
// close out funds/state.
const FINISH_RESERVE = 3n * 150_000n * 30n * 10n ** 9n

export const toWei = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n // decimal → wei (avoids float→BigInt precision traps)

// Occasional TLS handshake failures on the public RPC — read-only calls get a
// small backoff-retry; no broadcast-type operation is ever retried here
export function withRetry(fn, tries = 4, baseMs = 1500) {
  let last
  const run = async () => {
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
  return run()
}

export class Exit extends Error {
  constructor(code, msg) {
    super(msg)
    this.code = code
  }
}

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

const PURCHASE_STEP = { D1: 'D1-purchase', A: 'A7-purchase' } // d2 = the rollback path, no deal order

// Fixed Seller-mode args for direct sales (phase one, provider=0; the provider
// delivery path is protocol-covered by direct-sales-test.mjs and out of scope for
// the mainnet acceptance run)
const SELLER_MODE_ARGS = (terms = '0x0000000000000000000000000000000000000000000000000000000000000000') =>
  ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0, 0, terms, 0, '0x']

// listingId = keccak256(abi.encodePacked(seller, fileKey)) (same derivation as DirectSales)
const encodePackedAddr = (addr, bytes32) =>
  keccak256(`0x${addr.slice(2).toLowerCase()}${bytes32.slice(2).toLowerCase().padStart(64, '0')}`)

// ---------- createRunner ----------

export function createRunner(deps) {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 6000
  const confirmDepth = deps.confirmDepth ?? 12
  const OUT_BASE = deps.OUT_BASE

  let RUN = null // { id, dir, input, journal }

  // ---------- record directory / journal / report ----------

  function jwrite(file, obj) {
    const p = path.join(RUN.dir, file)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
    renameSync(tmp, p) // atomic persist: an interruption never leaves a half-written JSON (bigints as decimal strings)
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
    let journal = existsSync(path.join(dir, 'journal.json'))
      ? JSON.parse(readFileSync(path.join(dir, 'journal.json'), 'utf8'))
      : null
    journal ??= { runId: id, steps: [], spend: { gas: '0', fees: '0', consensus: '0', escrow: '0' } }
    journal.assertions ??= {}
    journal.pathResults ??= {}
    journal.balances ??= {}
    journal.flow ??= { A: [], C: [] }
    journal.pendingVerify ??= []
    journal.finishReserveUsed = Boolean(journal.finishReserveUsed)
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

  const isFresh = (id) => step(id).state !== 'checked'

  function syncSpend() {
    RUN.journal.spend = {
      gas: spend.gas.toString(), fees: spend.fees.toString(),
      consensus: spend.consensus.toString(), escrow: spend.escrow.toString(),
    }
  }

  function setStep(s, state, patch = {}) {
    Object.assign(s, patch, { state, at: new Date(now()).toISOString() })
    syncSpend()
    jwrite('journal.json', RUN.journal)
    console.log(`  [${s.id}] ${state}${s.txHash ? ` tx=${String(s.txHash).slice(0, 18)}…` : ''}${s.note ? ` · ${s.note}` : ''}${s.error ? ` · ✗ ${s.error}` : ''}`)
  }

  function pushPendingVerify(id) {
    RUN.journal.pendingVerify ??= []
    if (!RUN.journal.pendingVerify.includes(id)) {
      RUN.journal.pendingVerify.push(id)
      jwrite('journal.json', RUN.journal)
    }
  }

  // ---------- signers & contract helpers ----------

  const A = deps.A
  const C = deps.C
  const abis = deps.abis
  const mailboxAbis = deps.mailboxAbis
  const registryAbi = deps.registryAbi

  const bal = (c) => withRetry(() => c.publicClient.getBalance({ address: c.address }))
  const balAt = (c, blockNumber) => withRetry(() => c.publicClient.getBalance({ address: c.address, blockNumber }))

  const v2read = (c, addr, fn, args = []) =>
    withRetry(() => c.publicClient.readContract({ address: addr, abi: abis, functionName: fn, args }))
  async function orderOf(c, addr, id) {
    const [revision, price, platformBps, providerBps, state, purchasedAt, buyer, seller, provider, providerPayout, fileKey] =
      await v2read(c, addr, 'orderOf', [id])
    return { revision, price, platformBps: Number(platformBps), providerBps: Number(providerBps), state: Number(state), purchasedAt, buyer, seller, provider, providerPayout, fileKey }
  }
  function orderIdFromReceipt(rx) {
    for (const log of rx.logs) {
      try {
        const ev = decodeEventLog({ abi: abis, data: log.data, topics: log.topics })
        if (ev.eventName === 'Purchased') return ev.args.orderId
      } catch { /* not an event of this contract */ }
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

  // ---------- spend cap (persisted in journal, accumulated across resumes) ----------

  const spend = { gas: 0n, fees: 0n, consensus: 0n, escrow: 0n }
  function restoreSpend() {
    const s = RUN.journal.spend ?? {}
    spend.gas = BigInt(s.gas ?? '0')
    spend.fees = BigInt(s.fees ?? '0')
    spend.consensus = BigInt(s.consensus ?? '0')
    spend.escrow = BigInt(s.escrow ?? '0')
  }
  // Reserved cost of open txs (submitted, not yet costed) — the cap must cover their
  // worst case
  function openCost() {
    return RUN.journal.steps
      .filter((s) => s.state === 'submitted' && !s.costed && s.estCost)
      .reduce((a, s) => a + BigInt(s.estCost), 0n)
  }
  // Unified pre-write budget: gas + fees + consensus + this write + open-tx reserve.
  // "essential" (safe-finish steps such as delist) may use FINISH_RESERVE; any use
  // is recorded.
  function checkCap(nextWei, what, { essential = false } = {}) {
    const used = spend.gas + spend.fees + spend.consensus + nextWei + openCost()
    const cap = BigInt(RUN.input.capWei)
    const limit = essential ? cap : cap - FINISH_RESERVE
    if (used > limit) {
      if (essential && used <= cap) RUN.journal.finishReserveUsed = true
      else {
        throw new Exit(2, `spend cap: ${what} needs ~${ai3(nextWei)}, total ${ai3(used)} > ${essential ? 'cap' : 'cap−safe-finish reserve'} ${ai3(limit)} (cap ${ai3(cap)} · escrow peak tracked separately ${ai3(spend.escrow)})`)
      }
    }
  }

  // ---------- four-phase write pipeline ----------
  //
  // opts.pre(c, call) → true: idempotent hit with zero txs (e.g. encryption key already
  // announced), record checked directly.
  // prepare (estimate; reverts surface here with zero broadcast) → sign (local signing
  // yields the hash) → [hash persisted BEFORE broadcast] → broadcast (never retried) →
  // wait (poll by hash, retryable).
  // Any phase failing: not broadcast → failed (safe to retry); broadcast ambiguous →
  // submitted/unknown + hash, read-only verification, all new writes stop if unverifiable.
  // fee/ledger deltas are tied to the costed transition (!s.costed) — resume
  // re-entry verification never double-counts.

  async function txStep(s, c, call, opts = {}) {
    const value = call.value ?? 0n
    if (s.state === 'checked') return s.result

    // idempotent precheck (zero-tx path)
    if (opts.pre && s.state !== 'submitted' && s.state !== 'unknown' && s.state !== 'confirmed') {
      if (await opts.pre(c, call)) {
        setStep(s, 'checked', { result: null, note: 'idempotent hit, zero txs' })
        return null
      }
    }

    // hash already known: read-only verification, never resend
    if (s.txHash) {
      const rx = await verifyByHash(s, c)
      return await finishChecked(s, call, rx, opts)
    }
    if (s.state === 'unknown') {
      setStep(s, 'unknown', { note: 'unknown without a hash — corrupt record, manual verification, no resend' })
      throw new Exit(2, `step ${s.id} outcome unknown (no hash) — stopping all new writes`)
    }
    if (s.state === 'failed') {
      // failed = definitely never broadcast (rejected at prepare/sign) — safe to retry
      console.log(`  [${s.id}] retrying failed step (never broadcast before): ${s.error ?? ''}`)
      setStep(s, 'planned', { error: null, note: 'retry (definitely not broadcast before)' })
    }

    const data = encodeFunctionData({ abi: call.abi, functionName: call.fn, args: call.args })
    let request
    try {
      request = await c.publicClient.prepareTransactionRequest({ account: c.account, to: call.to, data, value })
    } catch (e) {
      const msg = String(e?.message ?? e).split('\n')[0].slice(0, 300)
      setStep(s, 'failed', { error: `prepare (not broadcast): ${msg}` })
      throw new Exit(1, `step ${s.id} failed before sending (not broadcast): ${msg}`)
    }
    const estGasPrice = request.maxFeePerGas ?? request.gasPrice
    const est = value + BigInt(request.gas) * BigInt(estGasPrice)
    checkCap(est, opts.label ?? s.id, { essential: opts.essential })

    let serialized
    try {
      serialized = await c.walletClient.signTransaction({ ...request, account: c.account })
    } catch (e) {
      const msg = String(e?.message ?? e).split('\n')[0].slice(0, 300)
      setStep(s, 'failed', { error: `sign (not broadcast): ${msg}` })
      throw new Exit(1, `step ${s.id} local signing failed (not broadcast): ${msg}`)
    }
    const hash = keccak256(serialized) // the hash is known before broadcast → persist it first
    setStep(s, 'submitted', { txHash: hash, estCost: String(est), note: 'hash persisted before broadcast' })

    try {
      await c.publicClient.sendRawTransaction({ serializedTransaction: serialized })
    } catch (e) {
      // A broadcast response error ≠ definite rejection: the tx may have reached the
      // node. Never resend; resume verifies by hash.
      setStep(s, 'submitted', { error: String(e?.message ?? e).split('\n')[0].slice(0, 200), note: 'broadcast response error — outcome unknown, no resend; resume verifies by hash' })
      throw new Exit(2, `step ${s.id} broadcast outcome unknown (hash recorded, see journal)`)
    }
    let rx
    try {
      rx = await c.publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: opts.timeoutMs ?? 180_000 })
    } catch (e) {
      setStep(s, 'submitted', { error: String(e?.message ?? e).split('\n')[0].slice(0, 200), note: 'receipt wait timed out — no resend; resume verifies by hash' })
      throw new Exit(2, `step ${s.id} receipt wait timed out (hash recorded, see journal)`)
    }
    return await finishChecked(s, call, rx, opts)
  }

  async function verifyByHash(s, c) {
    console.log(`  [${s.id}] ${s.state} → read-only verification by hash ${s.txHash}…`)
    try {
      return await withRetry(() => c.publicClient.waitForTransactionReceipt({ hash: s.txHash, confirmations: 1, timeout: 60_000 }), 2, 3000)
    } catch (e) {
      setStep(s, 'unknown', { note: `receipt not found by hash (may still be in the mempool) — manual verification, no resend: ${String(e?.message ?? e).slice(0, 120)}` })
      throw new Exit(2, `step ${s.id} cannot be verified (unknown) — stopping all new writes`)
    }
  }

  async function finishChecked(s, call, rx, opts) {
    if (rx.status !== 'success') {
      setStep(s, 'unknown', { txHash: s.txHash ?? undefined, note: `on-chain receipt status=${rx.status} — manual verification, no resend` })
      throw new Exit(2, `step ${s.id} tx failed on-chain (unknown, see journal)`)
    }
    const gas = BigInt(rx.gasUsed) * BigInt(rx.effectiveGasPrice)
    if (!s.costed) {
      spend.gas += gas
      if (opts.feesOut) spend.fees += opts.feesOut(rx)
      if (opts.escrow) spend.escrow += opts.escrow(rx)
      if (opts.actor) {
        const out = opts.flowOut ? opts.flowOut(rx) : (call.value ?? 0n) + gas
        const into = opts.credit ? opts.credit(rx) : 0n
        RUN.journal.flow[opts.actor].push({ step: s.id, out: out.toString(), in: into.toString() })
      }
      if (opts.extraCredit) {
        RUN.journal.flow[opts.extraCredit.actor].push({ step: `${s.id}(extra)`, out: '0', in: opts.extraCredit.amount(rx).toString() })
      }
      s.costed = true
      syncSpend()
      jwrite('journal.json', RUN.journal)
    }
    const result = opts.parse ? opts.parse(rx) : null
    setStep(s, 'confirmed', { receipt: { blockNumber: String(rx.blockNumber), gasUsed: String(rx.gasUsed), effectiveGasPrice: String(rx.effectiveGasPrice), status: rx.status } })
    setStep(s, 'checked', { txHash: s.txHash, result })
    return result
  }

  // Assertion-style revert check: read-only simulate (zero gas, zero txs)
  async function expectRevert(label, c, call, reason) {
    try {
      await c.publicClient.simulateContract({
        address: call.to, abi: call.abi, functionName: call.fn, args: call.args,
        account: c.account, ...(call.value ? { value: call.value } : {}),
      })
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (new RegExp(reason).test(msg)) return
      throw new Error(`${label}: expected revert(${reason}), got: ${msg.split('\n')[0].slice(0, 200)}`)
    }
    throw new Error(`${label}: expected revert(${reason}), but the simulation succeeded`)
  }

  // ---------- consensus publishing (path A only; single-submission pipeline) ----------

  async function publishStep(s, entries, label) {
    if (s.state === 'checked') return s.result.inclusions
    if (s.txHash) {
      const { api } = await deps.consensus.connect()
      let inclusion
      try {
        inclusion = await awaitConfirmed(api, s.txHash, { startHeight: s.startHeight, pollMs, timeoutMs: 8 * 60_000, depth: confirmDepth })
      } catch (e) {
        setStep(s, 'unknown', { note: `submitted but inclusion scan found nothing (no resend): ${String(e?.message ?? e).slice(0, 140)}` })
        throw new Exit(2, `consensus publish ${label} (${s.id}) outcome unknown — stopping all new writes`)
      }
      await api.disconnect().catch(() => {})
      setStep(s, 'checked', { result: { inclusions: [{ txHash: s.txHash, ...inclusion }] }, note: `resume: verified by scanning for the historical tx (block #${inclusion.height})` })
      return [{ txHash: s.txHash, ...inclusion }]
    }

    const { api, pair } = await deps.consensus.connect()
    let byteFee
    try {
      const raw = await api.query.transactionFees.transactionByteFee()
      byteFee = BigInt(raw.toJSON().current)
    } catch (e) {
      await api.disconnect().catch(() => {})
      throw new Exit(2, `failed to read the consensus byte fee (nothing submitted): ${String(e?.message ?? e).slice(0, 140)}`)
    }
    const totalBytes = entries.reduce((a, e) => a + e.bytes.length + 120, 0) // +120B ≈ bare per-tx overhead
    const est = byteFee * BigInt(totalBytes)
    checkCap(est, `consensus publish ${label}`)

    const txs = entries.map((e) => api.tx.system.remark(makeRemarkPayload(e.bytes)))
    const batch = api.tx.utility.batch(txs)
    await batch.signAsync(pair, { nonce: (await api.rpc.system.accountNextIndex(pair.address)).toNumber() })
    const txHash = batch.hash.toHex()
    const startHeight = (await api.rpc.chain.getHeader()).number.toNumber()
    setStep(s, 'submitted', { txHash, startHeight, estCost: String(est), note: `single batch submission (${entries.length} nodes ≈${totalBytes}B) — hash persisted before broadcast` })
    if (!s.costed) {
      spend.consensus += est
      s.costed = true
      syncSpend()
      jwrite('journal.json', RUN.journal)
    }
    try {
      await api.rpc.author.submitExtrinsic(batch.toHex()) // exactly once; rejected/errored → never resend
    } catch (e) {
      await api.disconnect().catch(() => {})
      setStep(s, 'submitted', { error: String(e?.message ?? e).split('\n')[0].slice(0, 200), note: 'submit response error — outcome unknown, no resend; resume verifies by scanning' })
      throw new Exit(2, `consensus publish ${label} submission outcome unknown (hash recorded, see journal)`)
    }
    let inclusion
    try {
      inclusion = await awaitConfirmed(api, txHash, { startHeight, pollMs, timeoutMs: 8 * 60_000, depth: confirmDepth })
    } catch (e) {
      await api.disconnect().catch(() => {})
      setStep(s, 'unknown', { note: `submitted but unconfirmed (no resend): ${String(e?.message ?? e).slice(0, 140)}` })
      throw new Exit(2, `consensus publish ${label} submitted but unconfirmed — check author_pendingExtrinsics manually`)
    }
    await api.disconnect()
    setStep(s, 'checked', { result: { inclusions: [{ txHash, ...inclusion }] }, note: `block #${inclusion.height}` })
    return [{ txHash, ...inclusion }]
  }

  // ---------- path assertions (persisted evidence; consumed by finish's gates) ----------

  function mkCheck(pathKey, res) {
    return (pass, label, detail = '') => {
      res.checks.push({ pass, label, detail })
      ;(RUN.journal.assertions[pathKey] ??= []).push({ pass, label, detail, at: new Date(now()).toISOString() })
      jwrite('journal.json', RUN.journal)
      console.log(`    ${pass ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`)
      if (!pass) throw new Exit(1, `path ${pathKey} assertion failed: ${label}`)
    }
  }

  /** Tight baseline snapshot (balance + block number): anchor for full-amount
   *  assertions. Captured only while the step is still planned; resume never
   *  overwrites a historical snapshot. Returns true when captured fresh in this
   *  process. */
  async function snapshotBefore(stepId, actor, slot) {
    const s = step(stepId)
    if (s.freshSnapshot !== undefined) return s.freshSnapshot
    if (s.state !== 'planned') {
      s.freshSnapshot = false
      return false
    }
    RUN.journal.balances[actor] ??= {}
    RUN.journal.balances[actor][slot] = {
      balance: String(await bal(actor === 'A' ? A : C)),
      block: Number(await withRetry(() => (actor === 'A' ? A : C).publicClient.getBlockNumber())),
    }
    s.freshSnapshot = true
    jwrite('journal.json', RUN.journal)
    return true
  }

  /** Full-amount assertion: fresh uses the tight snapshot; resume recomputes via the
   *  historical-block method (snapshot block → receipt block, immune to later txs);
   *  if historical balances are unavailable → pendingVerify (finish refuses passed).
   *  The assertion ALWAYS runs. */
  async function assertExactCredit(check, { actor, slot, refundStep, expected, creditIn, localFresh = false }) {
    const s = step(refundStep)
    if (s.state !== 'checked') return
    const rx = s.receipt
    const gas = BigInt(rx?.gasUsed ?? '0') * BigInt(rx?.effectiveGasPrice ?? '0')
    const snap = RUN.journal.balances?.[actor]?.[slot]
    if (!snap?.balance || !snap?.block) {
      check(false, `${refundStep} tight baseline missing (corrupt record)`)
      return
    }
    const client = actor === 'A' ? A : C
    let before, after, mode
    if (localFresh) {
      // fresh: the assertion runs immediately after the tx confirms, and this actor
      // has made no later txs yet → snapshot + live balance
      before = BigInt(snap.balance)
      after = await bal(client)
      mode = 'tight snapshot'
    } else {
      // resume: later txs may exist after the snapshot (e.g. other paths finished in
      // the same process) — always redo the historical-block method
      // (snapshot block → receipt block), immune to later txs
      try {
        before = await balAt(client, BigInt(snap.block))
        after = await balAt(client, BigInt(rx.blockNumber))
        mode = `historical blocks (#${snap.block}→#${rx.blockNumber})`
      } catch (e) {
        pushPendingVerify(refundStep)
        check(true, `${refundStep} full-amount assertion → pendingVerify (historical balance RPC unavailable, verify manually)`, 'finish will not report passed')
        return
      }
    }
    const delta = after - before + gas - (creditIn ?? 0n)
    check(delta === expected, `${refundStep} full-amount assertion (${mode}): balance delta + gas − inflow = expected`, `diff ${ai3(delta - expected)}`)
  }

  /** Wait for on-chain time: prints every 15s; beyond 30min persists nextEligibleAt
   *  and exits (code 3) for resume */
  async function waitUntil(s, epochMs) {
    const MAX_INLINE_MS = 30 * 60_000
    const remain = () => epochMs - now()
    if (remain() <= 0) {
      // resume: the wait window has passed — must land checked (strict gates treat
      // submitted as open)
      if (isFresh(s.id)) setStep(s, 'checked', { note: 'on-chain time reached (resume)' })
      return
    }
    if (remain() > MAX_INLINE_MS) {
      setStep(s, 'submitted', { nextEligibleAt: new Date(epochMs).toISOString(), note: `waiting for on-chain time ~${Math.ceil(remain() / 60_000)} min — exiting, resume continues` })
      await finish({ status: 'waiting' })
      throw new Exit(3, `waiting for on-chain time until ${s.nextEligibleAt} (persisted)`)
    }
    while (remain() > 0) {
      const r = remain()
      console.log(`  … waiting for on-chain time ${Math.ceil(r / 1000)}s (deadline ${new Date(epochMs).toISOString()})`)
      await sleep(Math.min(15_000, r))
      syncSpend()
      jwrite('journal.json', RUN.journal)
    }
    if (isFresh(s.id)) setStep(s, 'checked', { note: 'on-chain time reached' })
  }

  const signWith = (c) => async (message) => fromHex(await c.account.signMessage({ message }))

  /** Seller re-derives K via the signature channel (local HDAccount RFC6979 is
   *  deterministic; the key never touches disk) */
  async function unwrapKeyWithSigner(manifest, client) {
    const sigWrap = manifest.encryption?.wrappedKeys?.find((w) => w.mode === 'signature-v1')
    if (!sigWrap) throw new Error('manifest has no signature channel; cannot re-derive K in Node')
    const sig = await client.account.signMessage({ message: sigWrap.message })
    const key = await tryUnwrapWithSignature(sigWrap, fromHex(sig))
    if (!key) throw new Error('signature channel unwrap failed')
    return key
  }

  // Deterministic 1 KiB sample (xorshift64*, same as the PoC; re-running with the same
  // runId reproduces the content)
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

  const sha256HexOf = (bytes) => createHash('sha256').update(bytes).digest('hex')

  // Buyer announce-key idempotent precheck (shared by path A / D1; zero txs when
  // already announced)
  const precheckAnnounce = async (c, call) => {
    const kpC = await localBoxKeypair(signWith(c), c.address)
    const pub64 = Buffer.from(kpC.publicKey).toString('base64')
    const onchain = await withRetry(() => c.publicClient.readContract({ address: call.to, abi: call.abi, functionName: 'keys', args: [c.address] }))
    if (onchain === pub64) return true
    call.args = [pub64]
    return false
  }

  // pdgrant v3 construction and inbox binding-validation constant: bound to
  // chainId/sales/orderId/buyer/seller[/provider]; provider omitted = Seller mode
  const GRANT_V = 3

  // ---------- path D1 (test instance: normal direct purchase/delivery/key-grade download/rating change) ----------

  async function pathD1(testAddr, price) {
    const res = { path: 'D1', instance: 'test', checks: [] }
    const check = mkCheck('D1', res)
    const fileKey = keccak256(toHex(`pd-acceptance-${RUN.id}-D1`))
    const lid = encodePackedAddr(A.address, fileKey)

    await txStep(step('D1-list'), A, { to: testAddr, abi: abis, fn: 'createRevision', args: [fileKey, price, ...SELLER_MODE_ARGS()] }, { actor: 'A' })
    if (isFresh('D1-delist')) {
      const rid = await v2read(A, testAddr, 'currentRevision', [lid])
      check(rid === 1n, 'D1 listing readback (currentRevision=1, seller namespace)')
      const rev = await v2read(A, testAddr, 'revisionOf', [lid, rid])
      check(BigInt(rev[0]) === price && Number(rev[2]) === 1000 && Number(rev[4]) === 0, 'D1 revision snapshot: price/platformBps=1000/deliveryMode=0 (Seller)')
    }

    await txStep(step('D1-announce'), C, { to: RUN.input.mailbox, abi: mailboxAbis, fn: 'announceEncryptionKey', args: [] }, { actor: 'C', pre: precheckAnnounce })

    const d1fresh = isFresh('D1-purchase')
    const orderId = BigInt(
      await txStep(step('D1-purchase'), C, { to: testAddr, abi: abis, fn: 'purchase', args: [lid, 1n, price, 2000, 5000], value: price },
        { actor: 'C', parse: (rx) => orderIdFromReceipt(rx), extraCredit: { actor: 'A', amount: () => price } }),
    )
    const o = await orderOf(A, testAddr, orderId)
    if (d1fresh) {
      check(o.state === 0 && o.price === price && o.seller === A.address && o.buyer === C.address && o.platformBps === 1000 && o.provider === '0x0000000000000000000000000000000000000000',
        `D1 order(${orderId}) snapshot complete (Paid, Seller mode)`)
      check((await withRetry(() => A.publicClient.getBalance({ address: testAddr }))) === 0n, 'D1 contract balance 0 after purchase (pay-and-split, no escrow)')
    }

    // Delivery: pdgrant v3 (ciphertext rides the Mailbox E2E channel) + markKeySent (optional registration)
    const K = deterministicSample(32) // deterministic test key (no real file needed; full retrieval+decryption is covered by path A)
    const precheckGrant = async (c, call) => {
      const kpC = await localBoxKeypair(signWith(C), C.address)
      const inner = boxEncrypt(kpC.publicKey, K)
      const grant = {
        type: 'pdgrant',
        manifestCid: `test-${RUN.id}-D1`, // the test path has no real manifest; a placeholder identity for binding validation
        wrappedK: JSON.stringify(inner),
        v: GRANT_V,
        chainId: CHAIN_ID_EXPECTED,
        sales: testAddr,
        orderId: String(orderId),
        buyer: C.address.toLowerCase(),
        seller: A.address.toLowerCase(),
      }
      // Same as the frontend sendEncryptedMessage: on-chain content = boxEnvelope(pdgrant JSON)
      const envelope = boxEncrypt(kpC.publicKey, new TextEncoder().encode(JSON.stringify(grant)))
      call.args = [C.address, serializeEnvelope(envelope)]
      return false
    }
    await txStep(step('D1-send-grant'), A, { to: RUN.input.mailbox, abi: mailboxAbis, fn: 'send', args: [] }, { actor: 'A', pre: precheckGrant })

    const dKeySentFresh = isFresh('D1-mark-key-sent')
    await txStep(step('D1-mark-key-sent'), A, { to: testAddr, abi: abis, fn: 'markKeySent', args: [orderId] }, { actor: 'A' })
    if (dKeySentFresh) check((await orderOf(A, testAddr, orderId)).state === 1, 'D1 markKeySent: KeySent (optional state registration)')

    // Key-grade download check: the buyer fetches a pdgrant whose v3 bindings all match
    // from the Mailbox and unwraps K
    {
      const s = step('D1-receive-grant')
      if (s.state !== 'checked') {
        setStep(s, 'submitted')
        const kpC = await localBoxKeypair(signWith(C), C.address)
        const fromBlock = Math.max(RUN.input.mailboxDeployBlock, Number(await withRetry(() => C.publicClient.getBlockNumber())) - 400)
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
            continue // someone else's ciphertext / non-JSON, skip
          }
          if (g?.type !== 'pdgrant' || g.v !== GRANT_V) continue
          if (String(g.sales).toLowerCase() !== testAddr.toLowerCase() || String(g.orderId) !== String(orderId)) continue
          if (String(g.buyer).toLowerCase() !== C.address.toLowerCase() || String(g.seller).toLowerCase() !== A.address.toLowerCase()) continue
          found = g
          break
        }
        if (!found) {
          setStep(s, 'failed', { error: 'inbox has no pdgrant whose v3 bindings all match' })
          throw new Exit(1, 'D1 no matching pdgrant found')
        }
        const Kb = boxDecryptWithSecretKey(parseEnvelope(found.wrappedK), kpC.secretKey)
        if (Buffer.compare(Buffer.from(Kb), Buffer.from(K)) !== 0) {
          setStep(s, 'failed', { error: 'unwrapped K differs from the seller side' })
          throw new Exit(1, 'D1 key-grade download check failed (K mismatch)')
        }
        setStep(s, 'checked', { note: `pdgrant v3 binding validation passed (orderId ${orderId}) · K matches (full on-chain retrieval+decryption covered by path A)` })
      }
    }

    // Rating: positive → switch to negative (subtract first, then add; no stacking); gas paid by the rater
    const dRateFresh = isFresh('D1-rate-up')
    await txStep(step('D1-rate-up'), C, { to: testAddr, abi: abis, fn: 'rate', args: [orderId, true] }, { actor: 'C' })
    if (dRateFresh) {
      const [up, down, buyers] = await v2read(A, testAddr, 'ratingOf', [lid])
      check(BigInt(up) === 1n && BigInt(down) === 0n && BigInt(buyers) === 1n, 'D1 positive rating: up=1/down=0/distinct buyers=1')
    }
    const dSwitchFresh = isFresh('D1-rate-switch')
    await txStep(step('D1-rate-switch'), C, { to: testAddr, abi: abis, fn: 'rate', args: [orderId, false] }, { actor: 'C' })
    if (dSwitchFresh) {
      const [up, down] = await v2read(A, testAddr, 'ratingOf', [lid])
      check(BigInt(up) === 0n && BigInt(down) === 1n, 'D1 switch to negative: old vote subtracted before the new one added (up=0/down=1, no stacking)')
      const svc = await v2read(A, testAddr, 'serviceUp', [lid, '0x0000000000000000000000000000000000000000'])
      check(BigInt(svc) === 0n, 'D1 service dimension (provider=0) migrated in sync')
    }
    // non-buyer rating rejected (zero-tx simulate)
    await expectRevert('D1-rate-notbuyer', A, { to: testAddr, abi: abis, fn: 'rate', args: [orderId, false] }, 'NotBuyer')
    check(true, 'D1 non-buyer rating rejected (NotBuyer, zero-tx simulate)')

    await txStep(step('D1-delist'), A, { to: testAddr, abi: abis, fn: 'delist', args: [fileKey] }, { actor: 'A', essential: true })
    if (isFresh('D1-delist')) {
      check((await v2read(A, testAddr, 'currentRevision', [lid])) === 0n, 'D1 delist complete (currentRevision=0)')
      await expectRevert('D1-delist-purchase', C, { to: testAddr, abi: abis, fn: 'purchase', args: [lid, 1n, price, 2000, 5000], value: price }, 'NotListed')
      check(true, 'D1 purchase after delist rejected (NotListed, zero-tx simulate)')
    }

    res.orderId = String(orderId)
    res.finalState = 'rated-and-delisted'
    RUN.journal.pathResults.D1 = { finalState: res.finalState, orderId: res.orderId, instance: testAddr }
    jwrite('journal.json', RUN.journal)
    return res
  }

  // ---------- path D2 (test instance: failed purchase rolls back atomically — stale revision/delisted, zero residue) ----------

  async function pathD2(testAddr, price) {
    const res = { path: 'D2', instance: 'test', checks: [] }
    const check = mkCheck('D2', res)
    const fileKey = keccak256(toHex(`pd-acceptance-${RUN.id}-D2`))
    const lid = encodePackedAddr(A.address, fileKey)

    await txStep(step('D2-list'), A, { to: testAddr, abi: abis, fn: 'createRevision', args: [fileKey, price, ...SELLER_MODE_ARGS()] }, { actor: 'A' })
    const orderCount0 = await v2read(A, testAddr, 'orderCount')
    const balBefore = await withRetry(() => A.publicClient.getBalance({ address: testAddr }))

    // Scenario 1: purchase at the stale quote after a reprice → NotCurrentRevision (a swap between viewing and signing is rejected)
    await txStep(step('D2-reprice'), A, { to: testAddr, abi: abis, fn: 'createRevision', args: [fileKey, price * 2n, ...SELLER_MODE_ARGS()] }, { actor: 'A' })
    await expectRevert('D2a', C, { to: testAddr, abi: abis, fn: 'purchase', args: [lid, 1n, price, 2000, 5000], value: price }, 'NotCurrentRevision')
    check(true, 'D2 stale-revision purchase rejected (NotCurrentRevision, zero-tx simulate)')

    // Scenario 2: purchase after delist → NotListed
    await txStep(step('D2-delist'), A, { to: testAddr, abi: abis, fn: 'delist', args: [fileKey] }, { actor: 'A', essential: true })
    await expectRevert('D2b', C, { to: testAddr, abi: abis, fn: 'purchase', args: [lid, 2n, price * 2n, 2000, 5000], value: price * 2n }, 'NotListed')
    check(true, 'D2 purchase after delist rejected (NotListed, zero-tx simulate)')

    // Atomicity evidence: zero deals, zero fund movement (simulate never broadcasts;
    // the readback double-checks there is no state residue)
    check((await v2read(A, testAddr, 'orderCount')) === orderCount0, 'D2 atomic rollback: orderCount unchanged (no partial deals)')
    check((await withRetry(() => A.publicClient.getBalance({ address: testAddr }))) === balBefore && balBefore === 0n, 'D2 atomic rollback: contract balance stays 0 (no retained funds)')

    res.finalState = 'rolled-back-clean'
    RUN.journal.pathResults.D2 = { finalState: res.finalState, instance: testAddr }
    jwrite('journal.json', RUN.journal)
    return res
  }

  // ---------- path A (production instance: real file + real Mailbox delivery) ----------

  async function pathA(mainAddr, price) {
    const res = { path: 'A', instance: 'main', checks: [] }
    const check = mkCheck('A', res)
    const artifacts = path.join(RUN.dir, 'artifacts')
    mkdirSync(artifacts, { recursive: true })
    const plainName = `pd-accept-${RUN.id}.bin`

    // A1 encryption: random 32B K + AES-256-GCM over the whole file; signature channel
    // (determinism self-check)
    const s1 = step('A1-encrypt')
    let manifest
    if (s1.state === 'checked') {
      const mPath = path.join(artifacts, 'manifest.json')
      if (!existsSync(mPath)) throw new Exit(2, 'A1 checked but manifest.json missing — corrupt record, open a new runId')
      manifest = JSON.parse(readFileSync(mPath, 'utf8'))
      console.log('  [A1] resume: reusing the published manifest (K re-derived via the signature channel, never persisted)')
    } else {
      setStep(s1, 'submitted')
      const plain = deterministicSample(1024)
      const session = await startEncryption(new Uint8Array(plain))
      const okDet = await addSignatureChannel(session, A.address, signWith(A))
      requireChannel(session)
      if (!okDet) {
        setStep(s1, 'failed', { error: 'signature channel not reproducible (local HDAccount should never do this)' })
        throw new Exit(2, 'signature channel not reproducible — stopping path A')
      }
      writeFileSync(path.join(artifacts, 'cipher.bin'), session.cipher)
      manifest = {
        version: 2,
        network: 'mainnet',
        rootCid: '', // filled in after A2 packing
        file: { name: plainName, size: plain.length, sha256: createHash('sha256').update(plain).digest('hex'), mimeType: 'application/octet-stream' },
        encryption: session.encryption,
        compression: null,
        uploader: { address: A.address },
        nodes: [],
        txs: [],
        submittedAt: new Date(now()).toISOString(),
      }
      setStep(s1, 'checked', { note: `K in session memory only; cipher ${session.cipher.length}B · signature channel deterministic ✓` })
    }

    // A2 content on-chain: pack the whole ciphertext → utility.batch remark → single
    // submission + confirmationDepth
    const s2 = step('A2-publish-content')
    if (s2.state !== 'checked') {
      setStep(s2, 'submitted')
      const packed = await packFile(path.join(artifacts, 'cipher.bin'), plainName)
      manifest.rootCid = cidToString(packed.rootCid)
      manifest.nodes = packed.nodes.map((n) => ({ cid: cidToString(n.cid), blake3: nodeHashHex(n.cid), bytes: n.bytes.length }))
      const inclusions = await publishStep(s2, packed.nodes.map((n) => ({ cid: cidToString(n.cid), bytes: n.bytes })), 'A2 content')
      manifest.txs = inclusions.map(({ txHash, blockHash, height }) => ({ txHash, blockHash, height }))
      console.log(`  content root=${manifest.rootCid} · ${manifest.nodes.length} nodes · block #${manifest.txs[0].height}`)
      writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)) // resume snapshot
      setStep(s2, 'checked', { note: `root ${manifest.rootCid.slice(0, 20)}… · block #${manifest.txs[0].height}` })
    } else {
      manifest = JSON.parse(readFileSync(path.join(artifacts, 'manifest.json'), 'utf8')) // A2 checked: the snapshot is authoritative
    }

    // A3 manifest into the DSN (fixed name ${rootCid}.manifest.json → content-addressed determinism)
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
      writeFileSync(mPath, JSON.stringify(manifest)) // same as the frontend: single-line JSON.stringify(manifest)
      const packed = await packFile(mPath)
      const inclusions = await publishStep(s3, packed.nodes.map((n) => ({ cid: cidToString(n.cid), bytes: n.bytes })), 'A3 manifest')
      manifestCid = cidToString(packed.rootCid)
      regHeight = inclusions[0].height
      setStep(s3, 'checked', { result: { manifestCid, height: regHeight }, note: `manifestCid ${manifestCid.slice(0, 20)}… · block #${regHeight}` })
    }

    // A4 Registry v2 register (dev fee = max(minFee, size×feePerByte); overpayment refunded)
    const s4 = step('A4-register')
    const registryAddr = RUN.input.registry
    const [fpb, minFee] = await Promise.all([
      withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: registryAbi, functionName: 'feePerByte' })),
      withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: registryAbi, functionName: 'minFee' })),
    ])
    const regSize = BigInt(manifest.file.size)
    const quote = regSize * fpb > minFee ? regSize * fpb : minFee
    // The fee goes straight to treasury: when treasury = A, the fee flows back into the
    // same balance — the ledger must record the inflow (otherwise reconciliation always
    // differs by exactly the fee)
    let feeReturnsToA = false
    try {
      const regTreasury = await withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: registryAbi, functionName: 'treasury' }))
      feeReturnsToA = String(regTreasury).toLowerCase() === A.address.toLowerCase()
    } catch { /* no treasury view → assume it does not flow back */ }
    const feePaid = BigInt(
      await txStep(
        s4, A,
        { to: registryAddr, abi: registryAbi, fn: 'register', args: [manifestCid, regHeight, manifest.file.name, regSize], value: quote },
        {
          actor: 'A',
          parse: (rx) => String(eventsOf(rx, registryAbi).find((e) => e.eventName === 'FeePaid')?.args?.amount ?? 0n),
          // ledger out = the fee actually kept (overpayment refunded in-tx) + gas, not the quote
          flowOut: (rx) => {
            const ev = eventsOf(rx, registryAbi).find((e) => e.eventName === 'FeePaid')
            return (ev?.args?.amount ?? 0n) + BigInt(rx.gasUsed) * BigInt(rx.effectiveGasPrice)
          },
          feesOut: (rx) => eventsOf(rx, registryAbi).find((e) => e.eventName === 'FeePaid')?.args?.amount ?? 0n,
          ...(feeReturnsToA ? { extraCredit: { actor: 'A', amount: (rx) => eventsOf(rx, registryAbi).find((e) => e.eventName === 'FeePaid')?.args?.amount ?? 0n } } : {}),
        },
      ),
    )
    check(feePaid === quote, 'A4 FeePaid = quote (max(minFee, size×feePerByte))', ai3(quote))

    // A5 production instance listing (new revision, Seller mode)
    const keyA = keccak256(toHex(manifestCid))
    const lidA = encodePackedAddr(A.address, keyA)
    await txStep(step('A5-list'), A, { to: mainAddr, abi: abis, fn: 'createRevision', args: [keyA, price, ...SELLER_MODE_ARGS()] }, { actor: 'A' })
    const a5fresh = isFresh('A15-delist') // A15 checked ⇒ already delisted, the readback must be 0
    if (a5fresh) {
      const rid = await v2read(A, mainAddr, 'currentRevision', [lidA])
      check(rid === 1n, 'A5 production listing readback (currentRevision=1)')
    }

    // A6 buyer announces its encryption key (idempotent: zero txs if already registered)
    await txStep(step('A6-announce-buyer'), C, { to: RUN.input.mailbox, abi: mailboxAbis, fn: 'announceEncryptionKey', args: [] }, { actor: 'C', pre: precheckAnnounce })

    // A7 cross-address purchase (never replaced by a self-trade; expectedRevision read
    // at send time; orderId parsed from the receipt's Purchased event + the purchase
    // block recorded for the inbox scan; payment exactly equals the quote)
    const a7fresh = isFresh('A7-purchase')
    const s7 = step('A7-purchase')
    const ridA = await v2read(A, mainAddr, 'currentRevision', [lidA])
    await txStep(
      s7, C,
      { to: mainAddr, abi: abis, fn: 'purchase', args: [lidA, ridA, price, 2000, 5000], value: price },
      { actor: 'C', parse: (rx) => ({ orderId: String(orderIdFromReceipt(rx)), block: Number(rx.blockNumber) }), extraCredit: { actor: 'A', amount: () => price } },
    )
    const orderIdA = BigInt(s7.result.orderId)
    const oA = await orderOf(A, mainAddr, orderIdA)
    if (a7fresh) {
      check(oA.state === 0 && oA.seller === A.address && oA.buyer === C.address, `A7 order(${orderIdA}) Paid, cross-address snapshot correct`)
      check(oA.price === price && oA.platformBps === 1000 && oA.provider === '0x0000000000000000000000000000000000000000', 'A7 price/platform-fee snapshot correct (Seller mode)')
      check((await withRetry(() => A.publicClient.getBalance({ address: mainAddr }))) === 0n, 'A7 contract balance 0 after purchase (pay-and-split: platform fee + net land on A immediately)')
    }

    // A8 pdgrant delivery: unwrap K → wrap with the buyer's key → v3 binding
    // (chainId/sales/orderId/buyer/seller) → Mailbox send
    const precheckGrant = async (c, call) => {
      const K = await unwrapKeyWithSigner(manifest, A)
      const kpC = await localBoxKeypair(signWith(C), C.address)
      const inner = boxEncrypt(kpC.publicKey, K)
      const grant = {
        type: 'pdgrant',
        manifestCid, // CID of the manifest document (same as the Registry entry), not the content rootCid
        wrappedK: JSON.stringify(inner),
        v: GRANT_V,
        chainId: CHAIN_ID_EXPECTED,
        sales: mainAddr,
        orderId: String(orderIdA),
        buyer: C.address.toLowerCase(),
        seller: A.address.toLowerCase(),
      }
      // Same as the frontend sendEncryptedMessage: on-chain content = boxEnvelope(pdgrant JSON)
      const envelope = boxEncrypt(kpC.publicKey, new TextEncoder().encode(JSON.stringify(grant)))
      call.args = [C.address, serializeEnvelope(envelope)]
      return false
    }
    await txStep(step('A8-send-grant'), A, { to: RUN.input.mailbox, abi: mailboxAbis, fn: 'send', args: [] }, { actor: 'A', pre: precheckGrant })

    // A9 markKeySent (optional state registration; never a precondition for the buyer's download)
    const a9fresh = isFresh('A9-deliver')
    await txStep(step('A9-deliver'), A, { to: mainAddr, abi: abis, fn: 'markKeySent', args: [orderIdA] }, { actor: 'A' })
    if (a9fresh) check((await orderOf(A, mainAddr, orderIdA)).state === 1, 'A9 markKeySent: KeySent')

    // A10 buyer receives: decrypt the pdgrant + v3 binding validation (mismatched/forged
    // candidates are skipped)
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
          continue // someone else's ciphertext / non-JSON, skip
        }
        if (g?.type !== 'pdgrant' || g.manifestCid !== manifestCid) continue
        if (g.v !== GRANT_V || g.chainId !== CHAIN_ID_EXPECTED || String(g.sales).toLowerCase() !== mainAddr.toLowerCase()) continue
        if (String(g.orderId) !== String(orderIdA) || String(g.buyer).toLowerCase() !== C.address.toLowerCase() || String(g.seller).toLowerCase() !== A.address.toLowerCase()) continue
        found = g
        break
      }
      if (!found) {
        setStep(s10, 'failed', { error: 'inbox has no pdgrant whose v3 bindings all match' })
        throw new Exit(1, 'A10 no matching pdgrant found')
      }
      Kbuyer = boxDecryptWithSecretKey(parseEnvelope(found.wrappedK), kpC.secretKey)
      setStep(s10, 'checked', { note: `pdgrant v3 binding validation passed (orderId ${orderIdA})` })
    }

    // A11 buyer recovers the manifest from the Registry entry's height hint (independent
    // of the seller's local state)
    const s11 = step('A11-recover-manifest')
    let manifestBuyer
    {
      setStep(s11, 'submitted')
      const entries = await withRetry(() => A.publicClient.readContract({ address: registryAddr, abi: registryAbi, functionName: 'entries', args: [A.address] }))
      const entry = entries.find((e) => e.manifestCid === manifestCid)
      if (!entry) {
        setStep(s11, 'failed', { error: `Registry entries(A) has no ${manifestCid}` })
        throw new Exit(1, 'A11 directory entry missing')
      }
      const { api } = await deps.consensus.connect()
      let recovered = null
      for (let h = Number(entry.height); h <= Number(entry.height) + 3; h++) {
        const bh = await api.rpc.chain.getBlockHash(h)
        if (bh.toHex() === '0x' + '0'.repeat(64)) continue
        const { found } = await deps.consensus.extract(api, bh.toHex())
        if (!found.get(manifestCid)) continue
        const { bytes } = assemble(stringToCid(manifestCid), (cid) => found.get(cidToString(cid))?.bytes)
        recovered = JSON.parse(new TextDecoder().decode(bytes))
        break
      }
      await api.disconnect().catch(() => {})
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

    // A12 buyer retrieves the ciphertext on-chain + integrity gate (cipherSha256/cipherSize first)
    const s12 = step('A12-retrieve-cipher')
    let cipher
    {
      setStep(s12, 'submitted')
      const { api } = await deps.consensus.connect()
      const wanted = new Set(manifestBuyer.nodes.map((n) => n.cid))
      const bytesByCid = new Map()
      for (const { blockHash } of manifestBuyer.txs) {
        let hash = blockHash
        for (let hop = 0; hop < 4 && wanted.size > bytesByCid.size; hop++) {
          const { found } = await deps.consensus.extract(api, hash)
          for (const [cid, ent] of found) if (wanted.has(cid)) bytesByCid.set(cid, ent.bytes)
          if (wanted.size === bytesByCid.size) break
          hash = (await api.rpc.chain.getBlock(hash)).block.header.parentHash.toHex()
        }
        if (wanted.size === bytesByCid.size) break
      }
      await api.disconnect().catch(() => {})
      const missing = [...wanted].filter((cid) => !bytesByCid.has(cid))
      if (missing.length > 0) {
        setStep(s12, 'failed', { error: `nodes missing on-chain: ${missing.join(', ')}` })
        throw new Exit(1, 'A12 on-chain retrieval incomplete')
      }
      const { bytes } = assemble(stringToCid(manifestBuyer.rootCid), (cid) => bytesByCid.get(cidToString(cid)))
      cipher = new Uint8Array(bytes)
      const cipherSha = sha256HexOf(cipher)
      check(cipherSha === manifestBuyer.encryption.cipherSha256 && cipher.length === manifestBuyer.encryption.cipherSize, 'A12 ciphertext integrity gate (cipherSha256/cipherSize)')
      setStep(s12, 'checked', { note: `${cipher.length}B ciphertext` })
    }

    // A13 decrypt & verify plaintext (buyer's K from the pdgrant; plaintext sha256 must
    // match manifest.file.sha256)
    {
      const s13 = step('A13-decrypt-verify')
      setStep(s13, 'submitted')
      const plain = await aesGcmDecrypt(Kbuyer, fromHex(manifestBuyer.encryption.iv), cipher)
      const sha = createHash('sha256').update(plain).digest('hex')
      check(sha === manifestBuyer.file.sha256, 'A13 plaintext sha256 matches (decryption + integrity)', `${sha.slice(0, 16)}…`)
      setStep(s13, 'checked', {})
    }

    // A14 rating (a real buyer's vote goes on-chain; the vote-change drill is covered
    // on the test instance in D1 — the production instance casts one final vote)
    await txStep(step('A14-rate'), C, { to: mainAddr, abi: abis, fn: 'rate', args: [orderIdA, true] }, { actor: 'C' })
    const [upA, downA, buyersA] = await v2read(A, mainAddr, 'ratingOf', [lidA])
    check(BigInt(upA) === 1n && BigInt(downA) === 0n && BigInt(buyersA) === 1n, 'A14 rating on-chain: up=1/down=0/distinct buyers=1')

    // A15 delist (orders/ratings are already terminal and unaffected; the sales contract
    // balance is always 0, so there is no withdraw step)
    await txStep(step('A15-delist'), A, { to: mainAddr, abi: abis, fn: 'delist', args: [keyA] }, { actor: 'A', essential: true })
    check((await v2read(A, mainAddr, 'currentRevision', [lidA])) === 0n, 'A15 delist complete')

    res.orderId = String(orderIdA)
    res.manifestCid = manifestCid
    res.finalState = 'delivered-and-rated'
    RUN.journal.pathResults.A = { finalState: res.finalState, orderId: res.orderId, instance: mainAddr }
    jwrite('journal.json', RUN.journal)
    return res
  }

  // ---------- finish: strict pass gates ----------

  async function finish({ status: forced } = {}) {
    const steps = RUN.journal.steps
    const failed = steps.filter((s) => s.state === 'failed')
    const unknown = steps.filter((s) => s.state === 'unknown')
    const open = steps.filter((s) => s.state === 'submitted' || s.state === 'confirmed')
    const planned = steps.filter((s) => s.state === 'planned')
    const required = (RUN.input?.paths ?? []).map((p) => p.toUpperCase())
    const pathResults = RUN.journal.pathResults ?? {}
    const missingPaths = required.filter((p) => !pathResults[p])
    const badAssertions = Object.entries(RUN.journal.assertions ?? {}).flatMap(([p, list]) =>
      list.filter((a) => !a.pass).map((a) => `${p}:${a.label}`),
    )
    const noEvidence = required.filter((p) => (RUN.journal.assertions?.[p] ?? []).length === 0)
    const ordersMissing = required
      .filter((p) => pathResults[p] && PURCHASE_STEP[p]) // d2 = the rollback path has no deal order, no orderId check
      .filter((p) => {
        const s = steps.find((x) => x.id === PURCHASE_STEP[p])
        const orderId = s && s.state === 'checked' ? (s.result?.orderId ?? s.result) : null
        return orderId == null
      })

    // funds ledger reconciliation: expected = baseline − Σout + Σin, exact per role
    const funds = {}
    let fundsPass = true
    let fundsDetail = 'reconciled'
    if (failed.length + unknown.length + open.length + planned.length > 0) {
      fundsPass = false
      fundsDetail = `open/failed steps exist (failed ${failed.length} · unknown ${unknown.length} · open ${open.length} · planned ${planned.length}) — ledger incomplete`
    } else {
      for (const [actor, client, key] of [['A', A, 'balanceA'], ['C', C, 'balanceC']]) {
        const ledger = RUN.journal.flow?.[actor] ?? []
        const sumIn = ledger.reduce((a, e) => a + BigInt(e.in ?? '0'), 0n)
        const sumOut = ledger.reduce((a, e) => a + BigInt(e.out ?? '0'), 0n)
        const expected = BigInt(RUN.input.baseline[key]) - sumOut + sumIn
        const actual = await bal(client)
        funds[actor] = { baseline: RUN.input.baseline[key], expected: expected.toString(), actual: actual.toString(), diff: (actual - expected).toString() }
        if (actual !== expected) {
          fundsPass = false
          fundsDetail = `${actor} balance diff ${ai3(actual - expected)} (expected ${ai3(expected)}) — unexplained funds movement`
        }
      }
    }

    // Direct sales holds no escrow: at finish both instances' contract balances must
    // be 0 (pay-and-split; any nonzero balance is unexplained retained funds)
    const salesBalMain = await withRetry(() => A.publicClient.getBalance({ address: RUN.input.instances.main }))
    const salesBalTest = await withRetry(() => A.publicClient.getBalance({ address: RUN.input.instances.test }))

    const gates = [
      { name: 'requiredPathsComplete', pass: required.length > 0 && missingPaths.length === 0, detail: missingPaths.length ? `incomplete: ${missingPaths.join(',')}` : 'all mandatory paths have a terminal state' },
      { name: 'pathAssertionsAllPass', pass: required.length > 0 && badAssertions.length === 0 && noEvidence.length === 0, detail: [badAssertions.length ? `failed assertions: ${badAssertions.join('; ')}` : '', noEvidence.length ? `no assertion evidence: ${noEvidence.join(',')}` : ''].filter(Boolean).join(' · ') || 'evidence complete and all passing' },
      { name: 'noFailedSteps', pass: failed.length === 0, detail: failed.map((s) => s.id).join(',') || 'none' },
      { name: 'noOpenOrUnknownSteps', pass: unknown.length === 0 && open.length === 0 && planned.length === 0, detail: [...unknown, ...open, ...planned].map((s) => `${s.id}(${s.state})`).join(',') || 'none' },
      { name: 'salesContractBalanceZero', pass: salesBalMain === 0n && salesBalTest === 0n, detail: `main ${ai3(salesBalMain)} · test ${ai3(salesBalTest)} (0 = no retained funds)` },
      { name: 'ordersRecorded', pass: ordersMissing.length === 0, detail: ordersMissing.length ? `order ids missing: ${ordersMissing.join(',')}` : 'every purchase step has an orderId' },
      { name: 'fundsReconciled', pass: fundsPass, detail: fundsDetail },
      { name: 'noPendingVerify', pass: (RUN.journal.pendingVerify ?? []).length === 0, detail: (RUN.journal.pendingVerify ?? []).join(',') || 'none' },
    ]

    const allPass = gates.every((g) => g.pass)
    const status = forced ?? (allPass ? 'passed'
      : unknown.length + open.length > 0 ? 'blocked'
      : missingPaths.length > 0 || planned.length > 0 ? 'incomplete'
      : (RUN.journal.pendingVerify ?? []).length > 0 ? 'manual-verify'
      : 'failed')

    const report = {
      kind: 'acceptance', runId: RUN.id, commit: RUN.input?.commit, chainId: CHAIN_ID_EXPECTED,
      instances: RUN.input?.instances, price: RUN.input?.price, cap: RUN.input?.cap, capWei: String(RUN.input?.capWei ?? '0'),
      paths: RUN.input?.paths,
      startedAt: RUN.input?.startedAt, finishedAt: new Date(now()).toISOString(),
      spend: {
        gas: String(spend.gas), fees: String(spend.fees),
        consensusApprox: String(spend.consensus), escrowOutstanding: String(spend.escrow),
      },
      finishReserveUsed: Boolean(RUN.journal.finishReserveUsed),
      balancesAtFinish: {
        A: String(await bal(A)), C: String(await bal(C)),
        salesMainBalance: String(salesBalMain),
        salesTestBalance: String(salesBalTest),
      },
      funds,
      gates,
      pathResults,
      pendingVerify: RUN.journal.pendingVerify ?? [],
      steps: steps.map(({ id, state, txHash, note, error, nextEligibleAt }) => ({ id, state, txHash, note, error, nextEligibleAt })),
      failedSteps: [...failed, ...unknown].map((s) => ({ id: s.id, state: s.state, error: s.error ?? s.note })),
      ordersCreated: steps
        .filter((s) => Object.values(PURCHASE_STEP).includes(s.id) && s.state === 'checked' && (s.result?.orderId ?? s.result) != null)
        .map((s) => ({ step: s.id, orderId: String(s.result?.orderId ?? s.result) })),
      status,
    }
    jwrite('report.json', report)

    const exitCode = status === 'waiting' ? 3 : status === 'passed' ? 0 : status === 'failed' ? 1 : 2
    const lines = [
      `# DirectSales on-chain acceptance · ${RUN.id}`, '',
      `- commit: \`${report.commit}\` · chainId ${report.chainId} · paths ${required.join('/') || '—'}`,
      `- instances: main \`${RUN.input.instances.main}\` · test \`${RUN.input.instances.test}\``,
      `- spend: gas ${ai3(spend.gas)} · fees ${ai3(spend.fees)} · consensus ≈${ai3(spend.consensus)}${report.finishReserveUsed ? ' · ⚠ the safe-finish reserve was used' : ''}`,
      `- funds: A ${funds.A?.diff ?? '—'} · C ${funds.C?.diff ?? '—'} (0 = reconciled)`,
      `- orders: ${report.ordersCreated.map((o) => `${o.step}→#${o.orderId}`).join(' · ') || '(none)'}`, '',
      '| gate | result | detail |', '|---|---|---|',
      ...gates.map((g) => `| ${g.name} | ${g.pass ? '✓' : '✗'} | ${g.detail} |`),
      '', '| step | state | tx | note |', '|---|---|---|---|',
      ...steps.map((s) => `| ${s.id} | ${s.state} | ${s.txHash ? String(s.txHash).slice(0, 18) + '…' : ''} | ${s.note ?? s.error ?? ''} |`),
      '', `**Verdict: ${report.status.toUpperCase()}** (exit code ${exitCode})`,
    ]
    writeFileSync(path.join(RUN.dir, 'summary.md'), lines.join('\n') + '\n')
    return { report, exitCode }
  }

  // ---------- legacy instance inventory (read-only; all reads pinned to one blockNumber) ----------

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
    const headTag = BigInt(head) // one snapshot: deal/credits/balance are read at the same block as the log scan
    const headHash = String((await withRetry(() => A.publicClient.getBlock({ blockNumber: headTag }))).hash)
    console.log(`  [${label}] ${address} · range [${from}, ${head}] (pinned to block ${head})`)

    const names = ['Listed', 'Unlisted', 'Purchased', 'Delivered', 'Released', 'Refunded', 'Withdrawn']
    const fails = []
    const by = {}
    for (const n of names) {
      const r = await scanLogs(A.publicClient, address, n, from, head)
      by[n] = r.logs
      fails.push(...r.fails)
      console.log(`    ${n} × ${r.logs.length}`)
    }
    if (fails.length > 0) console.warn(`    ⚠ range scan failures (retried with backoff): ${fails.join(' | ')}`)

    // (key,buyer) pairs → current deal state; the address universe comes from all log
    // fields (covers sellers/buyers/treasury)
    const pairs = new Set()
    for (const n of ['Purchased', 'Delivered', 'Released', 'Refunded']) {
      for (const l of by[n]) pairs.add(`${l.args.key}|${l.args.buyer}`)
    }
    const orders = []
    for (const kb of pairs) {
      const key = kb.slice(0, 66)
      const buyer = kb.slice(67)
      // viem decodes multi-return human-readable ABIs as unnamed tuples — destructure by position
      const [dBuyer, dPrice, dState, dPurchasedAt, dDeliveredAt] = await withRetry(() =>
        A.publicClient.readContract({ address, abi: V1_ABI, functionName: 'deal', args: [key, buyer], blockNumber: headTag }),
      )
      const st = STATE_NAME[Number(dState)]
      if (st === 'none') continue
      const [lSeller] = await withRetry(() =>
        A.publicClient.readContract({ address, abi: V1_ABI, functionName: 'listings', args: [key], blockNumber: headTag }),
      )
      const deadline = st === 'escrowed'
        ? Number(dPurchasedAt) + Number(instance.deliveryTimeout ?? 0)
        : st === 'delivered'
          ? Number(dDeliveredAt) + Number(instance.gracePeriod ?? 0)
          : null
      orders.push({
        key, buyer, price: String(dPrice), state: st,
        purchasedAt: Number(dPurchasedAt), deliveredAt: Number(dDeliveredAt),
        currentListingSeller: String(lSeller), currentListingPrice: null,
        action: deadline == null ? `terminal (${st})` : deadline <= Math.floor(now() / 1000) ? 'refund-now (buyer may refund)' : `refund-at ${new Date(deadline * 1000).toISOString()}`,
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
      const c = await withRetry(() => A.publicClient.readContract({ address, abi: V1_ABI, functionName: 'credits', args: [a], blockNumber: headTag }))
      if (c > 0n) credits[a] = String(c)
    }

    const contractBal = await withRetry(() => A.publicClient.getBalance({ address, blockNumber: headTag }))
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
      caveat: 'v1 has no seller snapshot: currentListingSeller is only the current listing holder and cannot prove the deal seller; refunded/released orders are not part of the escrow balance.',
    }
  }

  // ---------- preflight (read-only; every check is a hard gate) ----------

  async function preflight({ skipTests = false } = {}) {
    console.log('=== DirectSales on-chain acceptance · read-only preflight (zero cost) ===')
    const deployments = deps.deployments
    const report = { kind: 'preflight', commit: deps.COMMIT, at: new Date(now()).toISOString(), gates: [] }
    const gates = report.gates
    const gate = (name, pass, detail = '') => {
      gates.push({ name, pass, detail })
      console.log(`  gate ${pass ? '✓' : '✗'} ${name}${detail ? ` · ${detail}` : ''}`)
      return pass
    }

    let chainId = null
    try {
      chainId = await withRetry(() => A.publicClient.getChainId())
    } catch (e) {
      gate('chainReachable', false, String(e?.message ?? e).slice(0, 120))
    }
    report.chainId = chainId
    if (chainId !== null) gate('chainId870', chainId === CHAIN_ID_EXPECTED, `chainId=${chainId}`)

    if (chainId === CHAIN_ID_EXPECTED) {
      // 1. legacy Paywall two-instance inventory (read-only, before any fund disposal)
      report.blocks = {}
      for (const [key, label] of [['auto-evm-mainnet-paywall', 'v1-main'], ['auto-evm-mainnet-paywall-test', 'v1-test']]) {
        if (!deployments[key]) {
          report.blocks[label] = { error: 'instance missing from deployments.json' }
          gate(`inventory_${label}`, false, 'instance missing from deployments.json')
          continue
        }
        report.blocks[label] = await inventoryLegacy(deployments[key], label)
      }
      for (const [label, b] of Object.entries(report.blocks)) {
        if (!b.activeOrders) continue
        console.log(`\n[${b.label}] active orders ${b.activeOrders.length} · terminal ${b.terminalOrders.length} · reconciliation diff ${b.reconciliationDiff} wei`)
        for (const o of b.activeOrders) console.log(`  · ${o.state} buyer=${o.buyer} price=${ai3(BigInt(o.price))} → ${o.action}`)
        gate(
          `inventory_${label}`,
          b.logFailures.length === 0 && b.reconciliationDiff === '0' && b.activeOrders.length === 0,
          `log gaps ${b.logFailures.length} · reconciliation diff ${b.reconciliationDiff} · active orders ${b.activeOrders.length}`,
        )
      }

      // 2. DirectSales deployment state (not deployed → recorded as-is, expected, no gate)
      report.sales = {}
      const artifact = deps.artifactSales
      for (const key of ['auto-evm-mainnet-direct-sales', 'auto-evm-mainnet-direct-sales-test']) {
        const d = deployments[key]
        if (!d) {
          report.sales[key] = { deployed: false, note: 'not deployed (expected, pending the deployment step)' }
          continue
        }
        const expected = patchImmutablesMulti(artifact, { treasury: d.treasury })
        const code = await withRetry(() => A.publicClient.getCode({ address: d.address }))
        const [treasury, pbps, orderCount, listingCount] = await Promise.all(
          ['treasury', 'platformBps', 'orderCount', 'listingCount'].map((f) => withRetry(() => A.publicClient.readContract({ address: d.address, abi: artifact.abi, functionName: f }))),
        )
        const codeMatch = code === expected
        const paramsMatch = String(treasury).toLowerCase() === String(d.treasury).toLowerCase() && Number(pbps) === Number(d.platformBps ?? 1000)
        report.sales[key] = {
          deployed: true, address: d.address, txHash: d.txHash, blockNumber: d.blockNumber, codeMatch, paramsMatch,
          readback: { treasury: String(treasury), platformBps: Number(pbps) },
          orderCount: String(orderCount), listingCount: String(listingCount),
        }
        gate(`salesCode_${key}`, codeMatch, codeMatch ? 'on-chain code matches byte for byte' : 'on-chain code differs from the build artifact')
        gate(`salesParams_${key}`, paramsMatch, paramsMatch ? 'readback matches the deployment record' : 'readback differs from the deployment record')
      }

      // 3. role balances & gas estimate
      const [balA, balC, gasPrice] = await Promise.all([bal(A), bal(C), withRetry(() => A.publicClient.getGasPrice())])
      report.roles = {
        A: { address: A.address, balance: String(balA) },
        C: { address: C.address, balance: String(balC) },
        gasPrice: String(gasPrice),
        perTxEstimate: `${ai3(150_000n * gasPrice)}/tx (150k gas upper bound)`,
      }
      gate('balanceA', balA > 0n, ai3(balA))
      gate('balanceC', balC > 0n, ai3(balC))

      // 4. Mailbox key announcement state (A/C — informational, no gate)
      const mailbox = deployments['auto-evm-mainnet-mailbox']
      report.mailbox = { address: mailbox?.address, deployBlock: mailbox?.blockNumber }
      if (mailbox) {
        for (const [n, c] of [['A', A], ['C', C]]) {
          const k = await withRetry(() => c.publicClient.readContract({ address: mailbox.address, abi: mailboxAbis, functionName: 'keys', args: [c.address] }))
          report.mailbox[`${n}Announced`] = k !== ''
        }
      }
    }

    // 5. offline test evidence
    report.offlineTests = {}
    if (skipTests || (deps.offlineTests ?? []).length === 0) {
      report.offlineTests.skipped = true
      gate('offlineTests', true, 'skipped (--skip-tests or not configured)')
    } else {
      for (const [name, rel] of deps.offlineTests) {
        const p = path.join(deps.ROOT ?? process.cwd(), rel)
        if (!existsSync(p)) {
          report.offlineTests[name] = { exit: null, note: 'script missing' }
          gate(`offline_${name}`, false, 'script missing')
          continue
        }
        const t0 = now()
        const r = deps.spawnOffline('node', [p], { cwd: path.dirname(p), encoding: 'utf8', timeout: 300_000 })
        report.offlineTests[name] = { exit: r.status, ms: Number(now() - t0), tail: (r.stdout ?? '').split('\n').filter(Boolean).slice(-1).join('').slice(0, 160) }
        console.log(`  offline ${name}: exit=${r.status} (${(Number(now() - t0) / 1000).toFixed(1)}s)`)
        gate(`offline_${name}`, r.status === 0, `exit=${r.status}`)
      }
    }

    mkdirSync(OUT_BASE, { recursive: true })
    const outFile = path.join(OUT_BASE, `preflight-${report.at.slice(0, 19).replace(/[:T]/g, '-')}.json`)
    writeFileSync(outFile, JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
    console.log(`\npreflight report: ${outFile}`)

    const failedGates = gates.filter((g) => !g.pass)
    if (failedGates.length > 0) {
      console.warn(`\n✗ preflight FAILED (${failedGates.length} gate(s)): ${failedGates.map((g) => g.name).join(', ')} — do not deploy / do not start a run`)
      return { report, exitCode: 1 }
    }
    console.log('\nall preflight gates passed')
    return { report, exitCode: 0 }
  }

  // ---------- run / resume ----------

  // File lock: prevents two processes from running/resuming the same runId
  // concurrently; the lock records the pid, and a stale lock (holder process dead)
  // is adopted by the next runner
  function acquireLock(dir) {
    const lf = path.join(dir, '.lock')
    const take = () => {
      const fd = openSync(lf, 'w')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { unlinkSync(lf) } catch { /* already cleaned up */ } }
    }
    try {
      const fd = openSync(lf, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { unlinkSync(lf) } catch { /* already cleaned up */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const pid = Number(readFileSync(lf, 'utf8').trim())
        process.kill(pid, 0) // alive → this does not throw
        throw new Exit(2, `runId ${path.basename(dir)} is held by another process (pid ${pid}) — concurrent resume is blocked; confirm that process has ended, then retry`)
      } catch (e2) {
        if (e2 instanceof Exit) throw e2
        // stale lock (holder process is dead) — adopt it
      }
      return take()
    }
  }

  async function runOrResume(resumeMode, { runId, cap, price: priceArg, paths: pathsArg } = {}) {
    if (!runId) throw new Exit(2, 'run/resume require a runId (an explicit runId + spend cap are required before any write)')
    RUN = loadRun(runId, { forWrite: true })

    const releaseLock = acquireLock(RUN.dir)
    try {
      return await runOrResumeLocked(resumeMode, { runId, cap, price: priceArg, paths: pathsArg })
    } finally {
      releaseLock()
    }
  }

  async function runOrResumeLocked(resumeMode, { runId, cap, price: priceArg, paths: pathsArg } = {}) {
    const deployments = deps.deployments
    const mainD = deployments['auto-evm-mainnet-direct-sales']
    const testD = deployments['auto-evm-mainnet-direct-sales-test']
    if (!mainD || !testD) throw new Exit(2, 'DirectSales not deployed (deployments.json lacks the direct-sales keys) — run the deployment step first')

    if (!RUN.input) {
      if (resumeMode) throw new Exit(2, `runId ${runId} has no input.json; cannot resume`)
      // fix 1: price parsing/positivity and budget-legality checks come first
      const priceStr = priceArg ?? PRICE_DEFAULT
      const priceNum = Number(priceStr)
      if (!Number.isFinite(priceNum) || priceNum <= 0) throw new Exit(2, `invalid price: ${priceStr} (positive decimal AI3 required)`)
      const capStr = cap ?? CAP_DEFAULT
      const capNum = Number(capStr)
      if (!Number.isFinite(capNum) || capNum <= 0) throw new Exit(2, `invalid cap: ${capStr} (positive decimal AI3 required)`)
      const capWei = toWei(capStr)
      const paths = (pathsArg ?? 'd1,d2,a').split(',').map((s) => s.trim().toLowerCase()).filter((p) => ['d1', 'd2', 'a'].includes(p))
      if (paths.length === 0) throw new Exit(2, 'no valid paths (choose from d1,d2,a)')
      const nPurchases = paths.filter((p) => PURCHASE_STEP[p.toUpperCase()]).length // the d2 rollback path makes no deal
      if (capWei < toWei(priceStr) * BigInt(nPurchases) + FINISH_RESERVE) {
        throw new Exit(2, `budget legality: cap ${ai3(capWei)} < ${nPurchases} purchases ${ai3(toWei(priceStr) * BigInt(nPurchases))} + safe-finish reserve ${ai3(FINISH_RESERVE)} — raise --cap`)
      }

      const [balA, balC, contractMain, contractTest] = await Promise.all([
        bal(A), bal(C),
        A.publicClient.getBalance({ address: mainD.address }), A.publicClient.getBalance({ address: testD.address }),
      ])
      RUN.input = {
        runId, suite: SUITE, commit: deps.COMMIT, chainId: CHAIN_ID_EXPECTED, startedAt: new Date(now()).toISOString(),
        instances: { main: mainD.address, test: testD.address },
        registry: deployments['auto-evm-mainnet-v2'].address,
        mailbox: deployments['auto-evm-mainnet-mailbox'].address,
        mailboxDeployBlock: Number(deployments['auto-evm-mainnet-mailbox'].blockNumber),
        roles: { A: A.address, C: C.address },
        price: priceStr,
        cap: capStr, capWei: String(capWei),
        paths, // frozen full plan (resume restores from here, never re-derived from steps)
        baseline: {
          balanceA: String(balA), balanceC: String(balC),
          contractMain: String(contractMain), contractTest: String(contractTest),
        },
      }
      jwrite('input.json', RUN.input) // fix 2: atomic persist of the frozen inputs before any broadcast
      console.log(`run ${runId} initialized: price=${RUN.input.price} AI3 · cap=${RUN.input.cap} AI3 · paths=${RUN.input.paths.join(',')} · A=${A.address} · C=${C.address}`)
    } else {
      // resume (or accidental re-run): verify the frozen inputs against the current environment
      if (!resumeMode) throw new Exit(2, `runId ${runId} already has input.json — use a new runId or resume (old records are never overwritten)`)
      const f = RUN.input
      if (!Array.isArray(f.paths) || f.paths.length === 0) throw new Exit(2, `runId ${runId} input.json has no frozen path list — corrupt record, open a new runId`)
      const cur = {
        chainId: CHAIN_ID_EXPECTED,
        commit: deps.COMMIT,
        'instances.main': mainD.address, 'instances.test': testD.address,
        registry: deployments['auto-evm-mainnet-v2'].address,
        mailbox: deployments['auto-evm-mainnet-mailbox'].address,
        'roles.A': A.address, 'roles.C': C.address,
      }
      const drift = []
      if (f.suite !== SUITE) drift.push(`suite: current ${SUITE} ≠ frozen ${f.suite ?? '(missing)'}`)
      for (const [k, v] of Object.entries(cur)) {
        const fv = k.includes('.') ? f[k.split('.')[0]]?.[k.split('.')[1]] : f[k]
        if (!fv || String(fv).toLowerCase() !== String(v).toLowerCase()) drift.push(`${k}: current ${v} ≠ frozen ${fv ?? '(missing)'}`)
      }
      if (drift.length > 0) throw new Exit(2, `runId ${runId} frozen inputs differ from the current environment — open a new runId:\n  ${drift.join('\n  ')}`)
      console.log(`resume ${runId}: input consistency ✓ (paths=${f.paths.join(',')})`)
    }
    RUN.journal.runId = runId
    restoreSpend()
    jwrite('journal.json', RUN.journal)

    const price = toWei(RUN.input.price)

    // pre-write guard: both DirectSales instances' on-chain code must match the build
    // artifact (after immutable patching) and their parameters (treasury/platformBps)
    // must match the deployment record
    for (const [key, inst] of [['main', mainD], ['test', testD]]) {
      const expected = patchImmutablesMulti(deps.artifactSales, { treasury: inst.treasury })
      const code = await withRetry(() => A.publicClient.getCode({ address: inst.address }))
      if (code !== expected) throw new Exit(2, `${key} instance on-chain code differs from the build artifact (codeMismatch) — stopping, no txs written`)
      const [tr, pbps] = await Promise.all([
        v2read(A, inst.address, 'treasury'), v2read(A, inst.address, 'platformBps'),
      ])
      if (String(tr).toLowerCase() !== String(inst.treasury).toLowerCase() || Number(pbps) !== Number(inst.platformBps ?? 1000)) {
        throw new Exit(2, `${key} instance parameters differ from the deployment record (treasury/platformBps) — stopping`)
      }
    }

    // buyer gas guard: the runner never auto-funds (read-only checks only);
    // insufficient C balance blocks with the exact funding requirement
    // (each frozen path pays exactly one purchase + a gas buffer)
    const balC = await bal(C)
    const nPurchase = RUN.input.paths.filter((p) => PURCHASE_STEP[p.toUpperCase()]).length
    const minC = price * BigInt(nPurchase) + 10n ** 16n
    if (balC < minC) {
      throw new Exit(2, `buyer C balance ${ai3(balC)} < minimum ${ai3(minC)} (${ai3(price)} × ${nPurchase} purchases + gas buffer) — transfer from A first, e.g. A.walletClient.sendTransaction({ to: '${C.address}', value: 10n ** 17n })`)
    }

    const queue = RUN.input.paths // frozen plan: includes not-yet-started paths
    const results = []

    RUN.journal.balances.A = RUN.journal.balances.A ?? {}
    RUN.journal.balances.C = RUN.journal.balances.C ?? {}

    try {
      for (const p of queue) {
        if (p === 'd1') results.push(await pathD1(RUN.input.instances.test, price))
        else if (p === 'd2') results.push(await pathD2(RUN.input.instances.test, price))
        else if (p === 'a') results.push(await pathA(RUN.input.instances.main, price))
      }
    } catch (e) {
      // best-effort report snapshot before halting (read failures ignored), then rethrow
      try { await finish({}) } catch { /* a failed snapshot must not mask the original error */ }
      throw e
    }

    const { report, exitCode } = await finish({})
    console.log(`\n═══ acceptance run ${runId}: ${report.status.toUpperCase()} · ${results.map((r) => `path${r.path} ${r.finalState}`).join(' · ') || '(no paths executed)'} ═══`)
    console.log(`report: ${path.join(RUN.dir, 'report.json')} · ${path.join(RUN.dir, 'summary.md')}`)
    return { report, exitCode }
  }

  // ---------- report (recompute report.json + summary.md only; gates identical to finish) ----------

  async function reportOnly({ runId } = {}) {
    if (!runId) throw new Exit(2, 'report requires a runId')
    RUN = loadRun(runId, { forWrite: false })
    if (!RUN.input) throw new Exit(2, 'this runId has no input.json')
    restoreSpend()
    const { report, exitCode } = await finish({})
    console.log(`report/summary recomputed: ${report.status.toUpperCase()} (exit code ${exitCode})`)
    return { report, exitCode }
  }

  return { preflight, runOrResume, reportOnly }
}
