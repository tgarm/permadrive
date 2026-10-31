// P4 · acceptance runner pure-offline fault-injection tests (the acceptance runbook's
// "minimum retest requirements", reworked for the direct-sales paths).
//
// Scenarios covered (all zero-network, zero-cost — a mock EVM plus a mock consensus
// chain; asserts: no duplicate broadcasts, no skipped paths, no false "passed"):
//   S1  full first run (d1,d2,a; single consensus submission; funds reconciled)
//   S2  resume without input.json — rejected with zero broadcasts
//   S3  purchase accepted by the node but the response lost — no resend; resume verifies
//       by hash and completes
//   S4  receipt wait timeout — no resend; resume verifies and completes
//   S5  on-chain reverted (unknown) re-entry — read-only verification halts, no new
//       writes, report says blocked (never passed)
//   S6  D2 rollback path standalone — expectRevert with zero purchase broadcasts,
//       zero deals, funds reconciled
//   S7  insufficient budget — input-legality check rejects with zero broadcasts
//   S8  codeMismatch (on-chain code ≠ build artifact) — pre-write guard rejects, zero
//       broadcasts
//   S9  partially executed paths — report says incomplete, never passed; resume completes
//       after the fault clears
//   S10 preflight gate: codeMatch=false must fail (a hard gate, not an info item)
//
// The mocks implement the minimal client surface the core touches
// (prepareTransactionRequest/signTransaction/sendRawTransaction/waitForTransactionReceipt/
// readContract/simulateContract/getLogs/getBalance/getBlockNumber/getBlock/getCode/
// getGasPrice/getChainId/account.signMessage) and the minimal consensus api (tx builders/
// signAsync/submitExtrinsic/chain.getHeader/getBlockHash/getBlock/query.transactionFees).
// The mock contract follows DirectSales semantics (immutable revisions / exact payment /
// instant three-way split / markKeySent / ratings with subtract-then-add vote changes).

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodePacked, getAddress, getAbiItem, keccak256, toEventSelector, toHex } from 'viem'
import { REGISTRY_ABI } from '../../frontend/src/lib/registry-abi.ts'
import { cidOfNode, cidToString, decodeNode } from '../poc/lib/dag.mjs'
import { patchImmutablesMulti } from '../p3/lib/chain.mjs'
import { Exit, createRunner } from './lib/acceptance-core.mjs'

// viem 2.57 has no top-level encodeEventLog — a local equivalent (all indexed params in
// these tests are static types)
function encodeEvent(abi, eventName, args) {
  const item = getAbiItem({ abi, name: eventName })
  const topics = [toEventSelector(item)]
  for (const input of item.inputs.filter((i) => i.indexed)) {
    const v = args[input.name]
    if (v === undefined) { topics.push(undefined); continue }
    const enc = encodeAbiParameters([{ name: input.name, type: input.type }], [v])
    topics.push(/^bytes|^string$/.test(input.type) ? keccak256(enc) : enc)
  }
  const nonIndexed = item.inputs.filter((i) => !i.indexed)
  const data = nonIndexed.length > 0 ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name])) : '0x'
  return { topics, data }
}

const ROOT = new URL('../../', import.meta.url).pathname
const artifactSales = JSON.parse(readFileSync(path.join(ROOT, 'contracts/out/DirectSales.json'), 'utf8'))
const mailboxArtifact = JSON.parse(path.join(ROOT, 'contracts/out/Mailbox.json') ? readFileSync(path.join(ROOT, 'contracts/out/Mailbox.json'), 'utf8') : '{}')

const A_ADDR = '0x' + 'a'.repeat(40)
const C_ADDR = '0x' + 'c'.repeat(40)
const MAIN = '0x' + '1'.repeat(40)
const TEST = '0x' + '2'.repeat(40)
const REG = '0x' + '3'.repeat(40)
const MBX = '0x' + '4'.repeat(40)
const V1M = '0x' + '5'.repeat(40)
const V1T = '0x' + '6'.repeat(40)
const ZERO = '0x0000000000000000000000000000000000000000'

const AI3 = 10n ** 18n
const GAS_PRICE = 11n * 10n ** 9n
const COMBINED_ABI = [...artifactSales.abi, ...REGISTRY_ABI, ...mailboxArtifact.abi]
const GAS_BY_FN = {
  createRevision: 120_000n, purchase: 150_000n, markKeySent: 60_000n, rate: 90_000n, delist: 50_000n,
  announceEncryptionKey: 90_000n, send: 120_000n, register: 150_000n,
}

const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`) }

// ---------- mock consensus chain ----------

function stripCompact(bytes) {
  const b0 = bytes[0]
  const mode = b0 & 0b11 // the mode bits live in the first byte's low 2 bits
  if (mode === 0b00) return bytes.slice(1)
  if (mode === 0b01) return bytes.slice(2)
  if (mode === 0b10) return bytes.slice(4)
  return bytes.slice(9) // 0b11: big int (never occurs in these scenarios)
}
const blkHash = (h) => keccak256(toHex(`consensus-blk-${h}`))

function makeMockConsensus(clock) {
  const chain = { height: 1000, blocks: new Map(), byHex: new Map() }
  let pendingTx = null
  const mkTx = (nodeBytesList) => {
    const tx = { // the most recently constructed tx is the pending submission
      _pending: true,
      nodeBytesList,
      encodedLength: nodeBytesList.reduce((a, b) => a + b.length + 200, 0),
      hash: null,
      _nonce: null,
      toHex: () => '0x' + Buffer.concat(nodeBytesList).toString('hex'),
      async signAsync(_pair, { nonce }) { tx._nonce = nonce; tx.hash = { toHex: () => keccak256(toHex(`consensus-tx:${tx._nonce}:${tx.toHex()}`)) } },
    }
    pendingTx = tx
    return tx
  }
  const include = (tx) => {
    const h = chain.height + 1
    chain.height = h
    const entries = tx.nodeBytesList.map((b) => {
      const node = stripCompact(b)
      return { cid: cidToString(cidOfNode(decodeNode(node))), bytes: Buffer.from(node) }
    })
    chain.blocks.set(h, { height: h, hash: blkHash(h), parentHash: blkHash(h - 1), txs: [{ txHash: tx.hash.toHex(), entries }] })
  }
  const getBlockBy = (key) => {
    for (const b of chain.blocks.values()) {
      if (key === b.hash || key === `0x${b.height.toString(16)}`) return b
    }
    return null
  }
  const api = {
    rpc: {
      system: { accountNextIndex: async () => ({ toNumber: () => 7 }) },
      chain: {
        getHeader: async () => { chain.height += 1; return { number: { toNumber: () => chain.height } } },
        getBlockHash: async (h) => ({ toHex: () => (chain.blocks.has(Number(h)) ? chain.blocks.get(Number(h)).hash : '0x' + '0'.repeat(64)) }),
        getBlock: async (hashHex) => {
          const b = getBlockBy(typeof hashHex === 'string' ? hashHex : hashHex.toHex()) // accepts a BlockHash object or hex, like polkadot
          if (!b) return null
          return {
            block: {
              header: { parentHash: { toHex: () => b.parentHash }, number: { toNumber: () => b.height } },
              extrinsics: b.txs.map((t) => ({ hash: { toHex: () => t.txHash } })),
            },
          }
        },
      },
      author: {
        submitExtrinsic: async (hex) => {
          if (!pendingTx || pendingTx.toHex() !== hex) throw new Error(`mock: submitted hex does not match the constructed tx (got ${hex.slice(0, 20)}… pending ${pendingTx ? pendingTx.toHex().slice(0, 20) + '…' : 'null'})`)
          include(pendingTx)
        },
      },
    },
    query: { transactionFees: { transactionByteFee: async () => ({ toJSON: () => ({ current: '2000000000000' }) }) } },
    tx: {
      system: { remark: (payload) => mkTx([Buffer.from(payload)]) },
      utility: { batch: (txs) => mkTx(txs.flatMap((t) => t.nodeBytesList)) },
    },
    disconnect: async () => {},
  }
  return {
    api,
    submitCount: () => chain.blocks.size,
    consensus: {
      connect: async () => ({ api, pair: { address: 'mock-consensus-pair' } }),
      extract: async (_api, hashHex) => {
        const b = getBlockBy(hashHex)
        const found = new Map()
        if (b) for (const t of b.txs) for (const e of t.entries) found.set(e.cid, { bytes: e.bytes })
        return { found, block: b }
      },
    },
  }
}

// ---------- mock EVM (DirectSales semantics) ----------

function makeMockEvm(faults = {}, clock = { t: 0 }, opts = {}) {
  const state = {
    block: 100,
    balances: new Map([[A_ADDR, 5n * AI3], [C_ADDR, 1n * AI3], [MAIN, 0n], [TEST, 0n], [REG, 0n], [MBX, 0n]]),
    history: [],
    nonces: new Map([[A_ADDR, 0n], [C_ADDR, 0n]]),
    txs: new Map(),
    logs: [], // {address, topics, data, blockNumber}
    codeBad: null,
  }
  const counts = {}
  const signMap = new Map()

  // mock-internal maps use lowercase keys; checksummed addresses only at the boundary
  // (client addresses / events)
  const L = (a) => a.toLowerCase()
  const bal = (a) => state.balances.get(L(a)) ?? 0n
  const credit = (a, d, deltas) => { deltas.push([L(a), d]) } // enqueue only; sendRawTransaction applies them (prevents double-counting)
  const lidOf = (seller, fileKey) => keccak256(encodePacked(['address', 'bytes32'], [seller, fileKey]))

  function salesContract(cfg) {
    // revisions: lid → { count, current, revs: Map(rid → rev) }; the listing log is append-only
    const c = { orders: new Map(), orderSeq: 0, listingCount: 0, listingLog: [], revisions: new Map(), votes: new Map(), rating: new Map(), ...cfg }
    return {
      view(fn, args) {
        const R = c.revisions.get(args[0])
        if (fn === 'currentRevision') return BigInt(R?.current ?? 0)
        if (fn === 'revisionOf') {
          const r = R?.revs.get(Number(args[1]))
          return r
            ? [r.price, 0n, r.platformBps, r.providerBps, r.deliveryMode, r.seller, r.provider, r.providerPayout, r.fileKey, r.termsHash, r.revoked]
            : [0n, 0n, 0, 0, 0, ZERO, ZERO, ZERO, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64), false]
        }
        if (fn === 'orderOf') {
          const o = c.orders.get(Number(args[0]))
          return o
            ? [o.revision, o.price, o.platformBps, o.providerBps, o.state, BigInt(o.purchasedAt), o.buyer, o.seller, o.provider, o.providerPayout, o.fileKey]
            : [0n, 0n, 0, 0, 0, 0n, ZERO, ZERO, ZERO, ZERO, '0x' + '0'.repeat(64)]
        }
        if (fn === 'ratingOf') {
          const r = c.rating.get(args[0]) ?? { up: 0n, down: 0n, buyers: 0n }
          return [r.up, r.down, r.buyers]
        }
        if (fn === 'serviceUp') return BigInt(c.rating.get(args[0])?.svcUp?.get(args[1]) ?? 0n)
        if (fn === 'serviceDown') return BigInt(c.rating.get(args[0])?.svcDown?.get(args[1]) ?? 0n)
        if (fn === 'voteOf') {
          const v = c.votes.get(`${args[0]}|${args[1]}`) ?? { choice: 0, orderId: 0n }
          return [v.choice, v.orderId]
        }
        if (fn === 'orderCount') return BigInt(c.orderSeq)
        if (fn === 'listingCount') return BigInt(c.listingCount)
        if (fn === 'listingLog') return c.listingLog[Number(args[0])] ?? '0x' + '0'.repeat(64)
        if (fn === 'treasury') return c.treasury
        if (fn === 'platformBps') return c.platformBps
        throw new Error(`mock sales: no view ${fn}`)
      },
      apply(fn, args, from, value, dryRun) {
        const deltas = []
        const logs = []
        const now = () => Math.floor(clock.t / 1000)
        const guard = (cond, reason) => { if (!cond) throw Object.assign(new Error(reason), { reason }) }
        if (fn === 'createRevision') {
          const [fileKey, price, provider, providerPayout, providerBps, deliveryMode, termsHash, expiry] = args
          guard(price > 0n, 'BadPrice')
          guard(deliveryMode === 0 || deliveryMode === 1, 'BadMode')
          if (Number(deliveryMode) === 0) guard(provider === ZERO && providerPayout === ZERO && Number(providerBps) === 0, 'BadMode')
          const lid = lidOf(from, fileKey)
          const R = c.revisions.get(lid) ?? { count: 0, current: 0, revs: new Map() }
          const rid = R.count + 1
          R.count = rid
          R.current = rid
          R.revs.set(rid, { price, platformBps: c.platformBps, providerBps: Number(providerBps), deliveryMode: Number(deliveryMode), seller: from, provider, providerPayout, fileKey, termsHash, revoked: false })
          if (rid === 1) { c.listingLog.push(lid); c.listingCount++ } // appended on first listing
          c.revisions.set(lid, R)
          logs.push({ eventName: 'Revised', args: { listingId: lid, seller: from, revision: BigInt(rid), price, provider, providerBps: BigInt(Number(providerBps)), deliveryMode: BigInt(Number(deliveryMode)), termsHash, attestationExpiry: expiry ?? 0n } })
          return { deltas, logs }
        }
        if (fn === 'delist') {
          const lid = lidOf(from, args[0])
          const R = c.revisions.get(lid)
          guard(R && R.current !== 0, 'NotListed')
          R.current = 0
          logs.push({ eventName: 'Unlisted', args: { listingId: lid, seller: from } })
          return { deltas, logs }
        }
        if (fn === 'purchase') {
          const [listingId, expectedRevision, maxPrice, maxPlatformBps, maxProviderBps] = args
          const R = c.revisions.get(listingId)
          guard(R && R.current !== 0, 'NotListed')
          guard(BigInt(R.current) === BigInt(expectedRevision), 'NotCurrentRevision')
          const rev = R.revs.get(Number(R.current))
          guard(rev.price <= maxPrice, 'PriceTooHigh')
          guard(rev.platformBps <= Number(maxPlatformBps), 'BpsTooHighPlatform')
          guard(rev.providerBps <= Number(maxProviderBps), 'BpsTooHighProvider')
          guard(value === rev.price, 'ExactPaymentRequired') // exact payment (no overpay refund)
          const id = ++c.orderSeq
          const fee = (rev.price * BigInt(rev.platformBps)) / 10_000n
          const pfee = (rev.price * BigInt(rev.providerBps)) / 10_000n
          c.orders.set(id, { revision: BigInt(R.current), price: rev.price, platformBps: rev.platformBps, providerBps: rev.providerBps, state: 0, purchasedAt: now(), buyer: from, seller: rev.seller, provider: rev.provider, providerPayout: rev.providerPayout, fileKey: rev.fileKey })
          if (from !== rev.seller) {
            const r = c.rating.get(listingId) ?? { up: 0n, down: 0n, buyers: 0n, seen: new Set(), svcUp: new Map(), svcDown: new Map() }
            if (!r.seen.has(from)) { r.seen.add(from); r.buyers += 1n }
            c.rating.set(listingId, r)
          }
          credit(from, -rev.price, deltas)
          credit(c.treasury, fee, deltas) // the platform fee lands immediately
          credit(rev.seller, rev.price - fee - pfee, deltas) // the seller net lands immediately
          if (pfee > 0n) credit(rev.providerPayout, pfee, deltas)
          logs.push({ eventName: 'Purchased', args: { orderId: BigInt(id), buyer: from, seller: rev.seller, listingId, revision: BigInt(R.current), fileKey: rev.fileKey, provider: rev.provider, price: rev.price, platformBps: rev.platformBps, providerBps: rev.providerBps } })
          return { deltas, logs }
        }
        if (fn === 'markKeySent') {
          const o = c.orders.get(Number(args[0]))
          guard(o, 'NotPurchased')
          guard(from === o.seller || from === o.provider, 'NotOrderSellerOrProvider')
          guard(o.state === 0, 'BadState')
          o.state = 1
          logs.push({ eventName: 'KeySent', args: { orderId: BigInt(args[0]), sender: from } })
          return { deltas, logs }
        }
        if (fn === 'rate') {
          const [orderId, positive] = args
          const o = c.orders.get(Number(orderId))
          guard(o, 'NotPurchased')
          guard(o.buyer === from, 'NotBuyer')
          guard(o.buyer !== o.seller, 'SelfRating')
          const lid = lidOf(o.seller, o.fileKey)
          const r = c.rating.get(lid) ?? { up: 0n, down: 0n, buyers: 0n, seen: new Set(), svcUp: new Map(), svcDown: new Map() }
          const vkey = `${lid}|${from}`
          const v = c.votes.get(vkey) ?? { choice: 0, orderId: 0n }
          const newChoice = positive ? 1 : -1
          if (v.choice !== newChoice) {
            if (v.choice === 1) { r.up -= 1n; r.svcUp.set(o.provider, (r.svcUp.get(o.provider) ?? 0n) - 1n) }
            else if (v.choice === -1) { r.down -= 1n; r.svcDown.set(o.provider, (r.svcDown.get(o.provider) ?? 0n) - 1n) }
            if (positive) { r.up += 1n; r.svcUp.set(o.provider, (r.svcUp.get(o.provider) ?? 0n) + 1n) }
            else { r.down += 1n; r.svcDown.set(o.provider, (r.svcDown.get(o.provider) ?? 0n) + 1n) }
            v.choice = newChoice
            v.orderId = BigInt(orderId)
            c.votes.set(vkey, v)
            c.rating.set(lid, r)
            logs.push({ eventName: 'Rated', args: { listingId: lid, buyer: from, orderId: BigInt(orderId), positive, up: r.up, down: r.down } })
          }
          return { deltas, logs }
        }
        throw new Error(`mock sales: no apply ${fn}`)
      },
    }
  }
  function registryContract() {
    const c = { feePerByte: 2n * 10n ** 12n, minFee: 10n ** 16n, entries: [], treasury: A_ADDR }
    return {
      view(fn, args) {
        if (fn === 'feePerByte') return c.feePerByte
        if (fn === 'minFee') return c.minFee
        if (fn === 'treasury') return c.treasury
        if (fn === 'entries') return c.entries.filter((e) => e.registrant === args[0])
        throw new Error(`mock registry: no view ${fn}`)
      },
      apply(fn, args, from, value, dryRun) {
        const deltas = []; const logs = []
        if (fn === 'register') {
          const [manifestCid, height, name, size] = args
          const fee = size * c.feePerByte > c.minFee ? size * c.feePerByte : c.minFee
          if (value < fee) throw Object.assign(new Error('InsufficientPayment'), { reason: 'InsufficientPayment' })
          credit(from, -value, deltas) // msg.value moves with the tx
          credit(REG, value, deltas)
          if (value > fee) credit(from, value - fee, deltas) // overpayment refunded
          credit(REG, -fee, deltas); credit(c.treasury, fee, deltas) // the fee goes straight to treasury
          c.entries.push({ registrant: from, manifestCid, height, name, size, registeredAt: 0, feePaid: fee })
          logs.push({ eventName: 'FeePaid', args: { payer: from, manifestCidKey: keccak256(toHex(manifestCid)), amount: fee } })
          return { deltas, logs }
        }
        throw new Error(`mock registry: no apply ${fn}`)
      },
    }
  }
  function mailboxContract() {
    const c = { keys: new Map(), msgs: [], seq: 0 }
    return {
      view(fn, args) {
        if (fn === 'keys') return c.keys.get(args[0]) ?? ''
        throw new Error(`mock mailbox: no view ${fn}`)
      },
      apply(fn, args, from) {
        const deltas = []; const logs = []
        if (fn === 'announceEncryptionKey') c.keys.set(from, args[0])
        else if (fn === 'send') {
          const id = ++c.seq
          c.msgs.push({ id, from, to: args[0], content: args[1], sentAt: Math.floor(clock.t / 1000), block: state.block + 1 })
          logs.push({ eventName: 'MessageSent', args: { id: BigInt(id), from, to: args[0], content: args[1], sentAt: BigInt(Math.floor(clock.t / 1000)) } })
        } else throw new Error(`mock mailbox: no apply ${fn}`)
        return { deltas, logs }
      },
      msgs: c.msgs, keys: c.keys,
    }
  }

  const salesMain = salesContract({ treasury: A_ADDR, platformBps: 1000 })
  const salesTest = salesContract({ treasury: A_ADDR, platformBps: 1000 })
  const registry = registryContract()
  const mailbox = mailboxContract()
  const contracts = new Map([[MAIN, salesMain], [TEST, salesTest], [REG, registry], [MBX, mailbox]])

  const expectCode = (addr) => patchImmutablesMulti(artifactSales, { treasury: A_ADDR })

  const mkClient = (rawAddr) => {
    const addr = getAddress(rawAddr) // viem account addresses are checksummed (apply compares from/seller against the same form)
    return {
    address: addr,
    account: {
      address: addr,
      signMessage: async ({ message }) => keccak256(toHex(`${addr}:${message}`)), // deterministic (boxCrypto derivation is reproducible)
    },
    publicClient: {
      getChainId: async () => 870,
      getGasPrice: async () => GAS_PRICE,
      getBlockNumber: async () => BigInt(state.block),
      getBlock: async ({ blockNumber }) => ({ hash: keccak256(toHex(`evm-blk-${blockNumber}`)) }),
      getCode: async ({ address }) => (state.codeBad === address ? '0xdead' : /^0x1+$|^0x2+$/.test(address) ? expectCode(address) : '0x6080'),
      getBalance: async ({ address, blockNumber }) => {
        if (blockNumber === undefined) return bal(address)
        let v = 0n
        // exact historical method: replay from 0 (the mock injects initial balances as history)
        for (const h of state.history) if (h.addr === L(address) && h.block <= Number(blockNumber)) v += h.delta
        return v
      },
      readContract: async ({ address, functionName, args }) => {
        const c = contracts.get(address)
        if (!c) {
          // v1 legacy-instance mock: empty deal/listings state, credits 0 (inventory read surface)
          if (functionName === 'credits') return 0n
          if (functionName === 'deal') return ['0x0'.padEnd(42, '0'), 0n, 0, 0n, 0n]
          if (functionName === 'listings') return ['0x0'.padEnd(42, '0'), 0n]
          throw new Error(`mock: no contract at ${address} (${functionName})`)
        }
        return c.view(functionName, args ?? [])
      },
      getLogs: async ({ address, args: want, fromBlock, toBlock }) => {
        if (address !== MBX) return []
        return mailbox.msgs
          .filter((m) => m.block >= Number(fromBlock) && m.block <= Number(toBlock) && (!want?.to || m.to === want.to))
          .map((m) => {
            const { topics, data } = encodeEvent(mailboxArtifact.abi, 'MessageSent', { id: BigInt(m.id), from: m.from, to: m.to, content: m.content, sentAt: BigInt(m.sentAt) })
            return { address, topics, data, blockNumber: BigInt(m.block), args: decodeEventLog({ abi: mailboxArtifact.abi, topics, data }).args } // viem getLogs also decodes args
          })
      },
      simulateContract: async ({ address, functionName, args, value }) => {
        const c = contracts.get(address)
        try { c.apply(functionName, args ?? [], addr ?? A_ADDR, value ?? 0n, true) } catch (e) {
          throw new Error(`simulation failed: execution reverted: ${e.reason ?? e.message}`)
        }
        return {}
      },
      prepareTransactionRequest: async ({ account, to, data, value }) => {
        const { functionName } = decodeFunctionData({ abi: COMBINED_ABI, data })
        const nonce = state.nonces.get(L(account.address)) ?? 0n
        return { account, to, data, value: value ?? 0n, gas: GAS_BY_FN[functionName] ?? 100_000n, gasPrice: GAS_PRICE, nonce, chainId: 870, type: 'legacy' }
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        const req = signMap.get(serializedTransaction)
        if (!req) throw new Error('mock: unsigned serialized tx')
        const { functionName, args } = decodeFunctionData({ abi: COMBINED_ABI, data: req.data })
        counts[functionName] = (counts[functionName] ?? 0) + 1
        const hash = keccak256(serializedTransaction)
        const behavior = faults.broadcast?.({ from: req.account.address, to: req.to, fn: functionName, args, value: req.value })
        if (behavior === 'reject') throw new Error('mock: node rejected (definitely not broadcast)')
        const forceRevert = faults.revertOn?.({ from: req.account.address, to: req.to, fn: functionName, args, value: req.value }) ?? false
        const gas = req.gas * req.gasPrice
        let deltas, logs = []
        let status = 'success'
        if (forceRevert) {
          deltas = [[req.account.address, -gas]]
          status = 'failed'
        } else {
          try {
            const r = contracts.get(req.to).apply(functionName, args, req.account.address, req.value)
            deltas = [[req.account.address, -gas], ...r.deltas]
            logs = r.logs
          } catch (e) { console.error('DEBUG mock apply throw:', functionName, e.message); throw e }
        }
        const block = state.block + 1
        state.block = block
        for (const [a, d] of deltas) { const k = L(a); state.balances.set(k, (state.balances.get(k) ?? 0n) + d); state.history.push({ block, addr: k, delta: d }) }
        const encodedLogs = logs.map((l) => {
          const { topics, data } = encodeEvent(COMBINED_ABI, l.eventName, l.args)
          return { address: req.to, topics, data, blockNumber: BigInt(block) }
        })
        state.logs.push(...encodedLogs)
        const receipt = { status, gasUsed: req.gas, effectiveGasPrice: req.gasPrice, blockNumber: BigInt(block), logs: status === 'success' ? encodedLogs : [], blockHash: keccak256(toHex(`evm-blk-${block}`)) }
        state.txs.set(hash, { receipt, ctx: { fn: functionName, args } })
        state.nonces.set(L(req.account.address), req.nonce + 1n)
        if (behavior === 'drop-response') throw new Error('mock: connection dropped (the tx may have reached the node)')
        return hash
      },
      waitForTransactionReceipt: async ({ hash }) => {
        const tx = state.txs.get(hash)
        if (!tx) throw new Error('mock: receipt not found')
        if (faults.waitTimeout?.(tx) && !faults._resolved) throw new Error('mock: wait timeout')
        return tx.receipt
      },
    },
    walletClient: {
      signTransaction: async (request) => {
        const serialized = keccak256(toHex(`sig:${request.account.address}:${request.nonce}:${request.to}`))
        signMap.set(serialized, request)
        return serialized
      },
    },
  }
}

  return { mkClient, state, counts, mailbox }
}

// ---------- scenario wiring ----------

function deployments() {
  return {
    'auto-evm-mainnet-paywall': { address: V1M, blockNumber: '50', deliveryTimeout: '259200', gracePeriod: '259200', treasury: A_ADDR },
    'auto-evm-mainnet-paywall-test': { address: V1T, blockNumber: '55', deliveryTimeout: '259200', gracePeriod: '259200', treasury: A_ADDR },
    'auto-evm-mainnet-direct-sales': { address: MAIN, txHash: '0x' + '9'.repeat(64), blockNumber: '60', treasury: A_ADDR, platformBps: '1000' },
    'auto-evm-mainnet-direct-sales-test': { address: TEST, txHash: '0x' + '8'.repeat(64), blockNumber: '62', treasury: A_ADDR, platformBps: '1000' },
    'auto-evm-mainnet-v2': { address: REG },
    'auto-evm-mainnet-mailbox': { address: MBX, blockNumber: '40' },
  }
}

async function setup({ faults = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pd-accept-test-'))
  const clock = { t: 1_767_139_200_000 } // fixed start (2026-01-01, deterministic)
  const mockConsensus = makeMockConsensus(clock)
  const mockEvm = makeMockEvm(faults, clock, {})
  const runner = createRunner({
    A: mockEvm.mkClient(A_ADDR),
    C: mockEvm.mkClient(C_ADDR),
    abis: artifactSales.abi,
    mailboxAbis: mailboxArtifact.abi,
    registryAbi: REGISTRY_ABI,
    artifactSales,
    deployments: deployments(),
    consensus: mockConsensus.consensus,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms }, // mock sleeps advance the on-chain clock (inline waits finish instantly)
    pollMs: 1,
    confirmDepth: 12,
    OUT_BASE: dir,
    ROOT,
    COMMIT: 'test-commit-0123456789',
    offlineTests: [],
    spawnOffline: () => ({ status: 0, stdout: '' }),
  })
  return { runner, clock, mockEvm, mockConsensus, dir, faults }
}

const readJson = (dir, f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
async function expectExit(promise, code, msg) {
  try {
    await promise
    throw new Error(`${msg}: expected Exit(${code}), but it returned normally`)
  } catch (e) {
    if (e instanceof Exit) { assert(e.code === code, `${msg}: exit code ${e.code} ≠ ${code} (${e.message.slice(0, 120)})`); return e }
    throw e
  }
}

// ---------- scenarios ----------

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('S1 full first run (d1,d2,a) — single consensus submission + funds reconciled', async () => {
  const { runner, mockEvm, mockConsensus, dir } = await setup({})
  let r1
  try {
    r1 = await runner.runOrResume(false, { runId: 's1', cap: '0.2', price: '0.01', paths: 'd1,d2,a' })
  } catch (e) {
    const { copyFileSync } = await import('node:fs')
    try { copyFileSync(path.join(dir, 's1', 'journal.json'), '/tmp/s1-journal.json') } catch {}
    throw e
  }
  const { report, exitCode } = r1
  if (exitCode !== 0) {
    const { copyFileSync } = await import('node:fs')
    try { copyFileSync(path.join(dir, 's1', 'journal.json'), '/tmp/s1-journal.json') } catch {}
  }
  assert(exitCode === 0, `exitCode ${exitCode} · status ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(report.status === 'passed', `status ${report.status}: ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(existsSync(path.join(dir, 's1', 'input.json')), 'input.json was not persisted')
  const input = readJson(dir, path.join('s1', 'input.json'))
  assert(JSON.stringify(input.paths) === JSON.stringify(['d1', 'd2', 'a']), 'paths were not frozen')
  assert(mockEvm.counts.purchase === 2, `purchase broadcasts ${mockEvm.counts.purchase} ≠ 2 (d1 + a; the d2 rollback broadcasts none)`)
  assert(mockEvm.counts.markKeySent === 2, `markKeySent broadcasts ${mockEvm.counts.markKeySent} ≠ 2`)
  assert(mockEvm.counts.rate === 3, `rate broadcasts ${mockEvm.counts.rate} ≠ 3 (d1 positive + switch to negative · a positive)`)
  assert(mockEvm.counts.refund === undefined && mockEvm.counts.withdraw === undefined, 'no refund/withdraw may exist (direct sales has no escrow)')
  assert(mockConsensus.submitCount() === 2, `consensus submission blocks ${mockConsensus.submitCount()} ≠ 2 (single submission)`)
  assert(report.funds.A?.diff === '0' && report.funds.C?.diff === '0', `funds ledger not reconciled: A ${report.funds.A?.diff} / C ${report.funds.C?.diff}`)
  assert(report.finishReserveUsed === false, 'the safe-finish reserve should not have been used')
  assert(mockEvm.state.balances.get(MAIN.toLowerCase()) === 0n && mockEvm.state.balances.get(TEST.toLowerCase()) === 0n, 'both instances contract balances should stay 0')
})

test('S2 resume without input.json — rejected with zero broadcasts', async () => {
  const { runner, mockEvm, dir } = await setup({})
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.join(dir, 's2'), { recursive: true })
  writeFileSync(path.join(dir, 's2', 'journal.json'), JSON.stringify({ runId: 's2', steps: [], spend: { gas: '0', fees: '0', consensus: '0', escrow: '0' } }))
  await expectExit(runner.runOrResume(true, { runId: 's2' }), 2, 'S2')
  assert(Object.keys(mockEvm.counts).length === 0, `broadcasts happened: ${JSON.stringify(mockEvm.counts)}`)
})

test('S3 purchase accepted but the response lost — no resend; resume verifies by hash', async () => {
  let triggered = false
  const { runner, mockEvm, dir } = await setup({
    faults: { broadcast: (ctx) => { if (ctx.fn === 'purchase' && !triggered) { triggered = true; return 'drop-response' } return undefined } },
  })
  await expectExit(runner.runOrResume(false, { runId: 's3', cap: '0.2', price: '0.01', paths: 'd1' }), 2, 'S3 first run')
  const j1 = readJson(dir, path.join('s3', 'journal.json'))
  const s = j1.steps.find((x) => x.id === 'D1-purchase')
  assert(s.state === 'submitted' && s.txHash, 'D1-purchase should be submitted+txHash (hash persisted before broadcast)')
  assert(mockEvm.counts.purchase === 1, `purchase broadcasts ${mockEvm.counts.purchase} ≠ 1`)
  // the order actually exists on the (mock) chain — the tx was included
  assert(mockEvm.state.txs.get(s.txHash)?.receipt.status === 'success', 'the tx should have been accepted by the node')

  const { report, exitCode } = await runner.runOrResume(true, { runId: 's3' })
  assert(exitCode === 0 && report.status === 'passed', `resume did not pass: ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(mockEvm.counts.purchase === 1, `purchase broadcasts after resume ${mockEvm.counts.purchase} ≠ 1 (duplicate broadcast!)`)
})

test('S4 receipt wait timeout — no resend; resume verifies and completes', async () => {
  let triggered = false
  const { runner, mockEvm, dir } = await setup({
    faults: { waitTimeout: (tx) => { if (tx.ctx.fn === 'purchase' && !triggered) { triggered = true; return true } return false } },
  })
  await expectExit(runner.runOrResume(false, { runId: 's4', cap: '0.2', price: '0.01', paths: 'd1' }), 2, 'S4 first run')
  const s = readJson(dir, path.join('s4', 'journal.json')).steps.find((x) => x.id === 'D1-purchase')
  assert(s.state === 'submitted' && s.txHash, 'D1-purchase should be submitted+txHash')
  assert(mockEvm.counts.purchase === 1, 'a receipt timeout must not trigger a resend')
  const { report, exitCode } = await runner.runOrResume(true, { runId: 's4' })
  assert(exitCode === 0 && report.status === 'passed', `resume did not pass: ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(mockEvm.counts.purchase === 1, `purchase broadcasts after resume ${mockEvm.counts.purchase} ≠ 1`)
})

test('S5 on-chain reverted (unknown) re-entry — read-only verification, no new writes, never passed', async () => {
  let triggered = false
  const { runner, mockEvm, dir } = await setup({
    faults: { revertOn: (ctx) => { if (ctx.fn === 'purchase' && !triggered) { triggered = true; return true } return false } },
  })
  await expectExit(runner.runOrResume(false, { runId: 's5', cap: '0.2', price: '0.01', paths: 'd1' }), 2, 'S5 first run')
  const before = JSON.stringify(mockEvm.counts)
  await expectExit(runner.runOrResume(true, { runId: 's5' }), 2, 'S5 re-entry')
  assert(JSON.stringify(mockEvm.counts) === before, `unknown re-entry must not broadcast: ${before} → ${JSON.stringify(mockEvm.counts)}`)
  const { report, exitCode } = await runner.reportOnly({ runId: 's5' })
  assert(report.status === 'blocked', `status ${report.status} ≠ blocked`)
  assert(exitCode === 2, `exitCode ${exitCode} ≠ 2`)
  assert(report.gates.find((g) => g.name === 'noOpenOrUnknownSteps')?.pass === false, 'the unknown gate should fail')
})

test('S6 D2 rollback path standalone — zero purchase broadcasts, zero deals, funds reconciled', async () => {
  const { runner, mockEvm } = await setup({})
  const { report, exitCode } = await runner.runOrResume(false, { runId: 's6', cap: '0.2', price: '0.01', paths: 'd2' })
  assert(exitCode === 0 && report.status === 'passed', `d2 did not pass: ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(mockEvm.counts.purchase === undefined, `the rollback path must not broadcast purchase: ${mockEvm.counts.purchase}`)
  assert(mockEvm.counts.createRevision === 2 && mockEvm.counts.delist === 1, `createRevision/delist broadcasts ${mockEvm.counts.createRevision}/${mockEvm.counts.delist} ≠ 2/1`)
  assert(report.funds.A?.diff === '0' && report.funds.C?.diff === '0', `funds ledger not reconciled: A ${report.funds.A?.diff} / C ${report.funds.C?.diff}`)
  assert(report.ordersCreated.length === 0, 'the rollback path has no deal orders')
})

test('S7 insufficient budget — input-legality check rejects, zero broadcasts', async () => {
  const { runner, mockEvm } = await setup({})
  await expectExit(runner.runOrResume(false, { runId: 's7', cap: '0.001', price: '0.01', paths: 'd1,d2,a' }), 2, 'S7')
  assert(Object.keys(mockEvm.counts).length === 0, `broadcasts happened: ${JSON.stringify(mockEvm.counts)}`)
})

test('S8 codeMismatch — pre-write guard rejects, zero broadcasts', async () => {
  const s = await setup({})
  s.mockEvm.state.codeBad = TEST
  await expectExit(s.runner.runOrResume(false, { runId: 's8', cap: '0.2', price: '0.01', paths: 'd1' }), 2, 'S8')
  assert(Object.keys(s.mockEvm.counts).length === 0, `broadcasts happened: ${JSON.stringify(s.mockEvm.counts)}`)
})

test('S9 partially executed paths — report says incomplete, never passed', async () => {
  const { runner, dir, mockEvm } = await setup({})
  // hand-crafted: input freezes paths=['d1','a'], journal has only D1-list planned
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.join(dir, 's9'), { recursive: true })
  writeFileSync(path.join(dir, 's9', 'input.json'), JSON.stringify({
    runId: 's9', suite: 'direct-sales-v1', commit: 'test-commit-0123456789', chainId: 870, instances: { main: MAIN, test: TEST },
    registry: REG, mailbox: MBX, mailboxDeployBlock: 40, roles: { A: A_ADDR, C: C_ADDR },
    price: '0.01', cap: '0.2', capWei: String(2n * 10n ** 17n), paths: ['d1', 'a'],
    baseline: { balanceA: String(5n * AI3), balanceC: String(1n * AI3), contractMain: '0', contractTest: '0' },
  }))
  writeFileSync(path.join(dir, 's9', 'journal.json'), JSON.stringify({ runId: 's9', steps: [{ id: 'D1-list', state: 'planned' }], spend: { gas: '0', fees: '0', consensus: '0', escrow: '0' } }))
  const { report, exitCode } = await runner.reportOnly({ runId: 's9' })
  assert(report.status === 'incomplete', `status ${report.status} ≠ incomplete`)
  assert(exitCode === 2, `exitCode ${exitCode} ≠ 2`)
  assert(report.gates.find((g) => g.name === 'requiredPathsComplete')?.pass === false, 'the mandatory-paths gate should fail')
  // resume after the fault clears — D1 re-runs and A is added; no path is skipped
  const { report: r2, exitCode: e2 } = await runner.runOrResume(true, { runId: 's9' })
  assert(e2 === 0 && r2.status === 'passed', `resume did not pass: ${r2.status}`)
  assert(mockEvm.counts.purchase === 2, `purchase ${mockEvm.counts.purchase} ≠ 2 (one each for D1+A)`)
})

test('S10 preflight gate: codeMatch=false must fail', async () => {
  const s = await setup({})
  s.mockEvm.state.codeBad = MAIN
  const { report, exitCode } = await s.runner.preflight({})
  assert(exitCode === 1, `exitCode ${exitCode} ≠ 1`)
  const g = report.gates.find((x) => x.name === 'salesCode_auto-evm-mainnet-direct-sales')
  assert(g && g.pass === false, 'the salesCode gate should fail')
})

// ---------- runner ----------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`✗ ${name}\n  ${e?.stack ?? e}`)
  }
}
console.log(failed === 0 ? `\nall ${tests.length} scenarios passed (pure offline, zero cost)` : `\n${failed}/${tests.length} scenarios failed`)
process.exitCode = failed === 0 ? 0 : 1
