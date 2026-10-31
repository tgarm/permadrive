// P4 · acceptance runner pure-offline fault-injection tests (the acceptance runbook's
// "minimum retest requirements").
//
// Scenarios covered (all zero-network, zero-cost — a mock EVM plus a mock consensus
// chain; asserts: no duplicate broadcasts, no skipped paths, no false "passed"):
//   S1  full first run (c,b,a; the old code hit the price TDZ ReferenceError here)
//   S2  resume without input.json — rejected with zero broadcasts
//   S3  purchase accepted by the node but the response lost — no resend; resume verifies
//       by hash and completes
//   S4  receipt wait timeout — no resend; resume verifies and completes
//   S5  on-chain reverted (unknown) re-entry — read-only verification halts, no new
//       writes, report says blocked (never passed)
//   S6  C/B cross-process wait (exit 3 + nextEligibleAt) then resume — restored from the
//       frozen plan: B not lost, A not run
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
const artifactV2 = JSON.parse(readFileSync(path.join(ROOT, 'contracts/out/PaywallV2.json'), 'utf8'))
const mailboxArtifact = JSON.parse(readFileSync(path.join(ROOT, 'contracts/out/Mailbox.json'), 'utf8'))

const A_ADDR = '0x' + 'a'.repeat(40)
const C_ADDR = '0x' + 'c'.repeat(40)
const MAIN = '0x' + '1'.repeat(40)
const TEST = '0x' + '2'.repeat(40)
const REG = '0x' + '3'.repeat(40)
const MBX = '0x' + '4'.repeat(40)
const V1M = '0x' + '5'.repeat(40)
const V1T = '0x' + '6'.repeat(40)

const AI3 = 10n ** 18n
const GAS_PRICE = 11n * 10n ** 9n
const COMBINED_ABI = [...artifactV2.abi, ...REGISTRY_ABI, ...mailboxArtifact.abi]
const GAS_BY_FN = {
  setPrice: 80_000n, purchase: 150_000n, markDelivered: 60_000n, refund: 90_000n,
  confirmReceipt: 120_000n, release: 120_000n, withdraw: 60_000n,
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
          if (!pendingTx || pendingTx.toHex() !== hex) throw new Error('mock: submitted hex does not match the constructed tx')
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
        const b = getBlockBy(typeof hashHex === 'string' ? hashHex : hashHex.toHex())
        const found = new Map()
        if (b) for (const t of b.txs) for (const e of t.entries) found.set(e.cid, { bytes: e.bytes })
        return { found, block: b }
      },
    },
  }
}

// ---------- mock EVM ----------

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
  const lidOf = (seller, key) => keccak256(encodePacked(['address', 'bytes32'], [seller, key]))

  function paywallContract(cfg) {
    const c = { listings: new Map(), orders: new Map(), orderSeq: 0, credits: new Map(), ...cfg }
    return {
      view(fn, args) {
        if (fn === 'listingPrice') return c.listings.get(lidOf(args[0], args[1]))?.price ?? 0n
        if (fn === 'orders') {
          const o = c.orders.get(Number(args[0]))
          return o ? [getAddress(o.seller), getAddress(o.buyer), o.price, o.feeBps, o.state, BigInt(o.purchasedAt), BigInt(o.deliveredAt)] : ['0x0'.padEnd(42, '0'), '0x0'.padEnd(42, '0'), 0n, 0, 0, 0n, 0n]
        }
        if (fn === 'credits') return c.credits.get(args[0]) ?? 0n
        if (fn === 'deliveryTimeout') return c.deliveryTimeout
        if (fn === 'gracePeriod') return c.gracePeriod
        if (fn === 'feeBps') return c.feeBps
        if (fn === 'treasury') return c.treasury
        if (fn === 'orderCount') return BigInt(c.orderSeq)
        throw new Error(`mock paywall: no view ${fn}`)
      },
      apply(fn, args, from, value, dryRun) {
        const deltas = []
        const logs = []
        const now = () => Math.floor(clock.t / 1000)
        const settle = (orderId, o) => {
          const price = o.price
          const fee = (price * BigInt(o.feeBps)) / 10_000n
          const net = price - fee
          o.state = 3
          c.credits.set(o.seller, (c.credits.get(o.seller) ?? 0n) + net) // real semantics: net lands in credits, withdrawn at A15
          credit(c.treasury, fee, deltas) // the fee goes straight to treasury, immediately spendable
          logs.push({ eventName: 'Released', args: { orderId: BigInt(orderId), net, fee } })
        }
        const guard = (cond, reason) => { if (!cond) throw Object.assign(new Error(reason), { reason }) }
        if (fn === 'setPrice') {
          const lid = lidOf(from, args[0])
          const prev = c.listings.get(lid)?.price ?? 0n
          if (args[1] === 0n) { c.listings.delete(lid); if (prev !== 0n) logs.push({ eventName: 'Unlisted', args: { seller: from, listingId: lid, key: args[0] } }) }
          else { c.listings.set(lid, { seller: from, key: args[0], price: args[1] }); logs.push({ eventName: 'Listed', args: { seller: from, listingId: lid, key: args[0], price: args[1] } }) }
        } else if (fn === 'purchase') {
          const [key, seller, maxPrice] = args
          const l = c.listings.get(lidOf(seller, key))
          guard(l && l.price !== 0n, 'NotListed')
          guard(l.price <= maxPrice, 'PriceTooHigh')
          guard(value >= l.price, 'InsufficientPayment')
          const id = ++c.orderSeq
          c.orders.set(id, { seller, buyer: from, price: l.price, feeBps: c.feeBps, state: 1, purchasedAt: now(), deliveredAt: 0 })
          credit(from, -l.price, deltas); credit(c.self, l.price, deltas)
          logs.push({ eventName: 'Purchased', args: { orderId: BigInt(id), buyer: from, seller, key, price: l.price } })
        } else if (fn === 'markDelivered') {
          const o = c.orders.get(Number(args[0]))
          guard(o && o.seller === from, 'NotSeller'); guard(o.state === 1, 'BadState')
          o.state = 2; o.deliveredAt = now()
          logs.push({ eventName: 'Delivered', args: { orderId: BigInt(args[0]) } })
        } else if (fn === 'refund') {
          const o = c.orders.get(Number(args[0]))
          guard(o && o.buyer === from, 'NotBuyer')
          if (o.state === 1) guard(now() >= o.purchasedAt + Number(c.deliveryTimeout), 'BadState')
          else if (o.state === 2) guard(now() < o.deliveredAt + Number(c.gracePeriod), 'BadState')
          else guard(false, 'BadState')
          o.state = 4
          credit(c.self, -o.price, deltas); credit(from, o.price, deltas)
          logs.push({ eventName: 'Refunded', args: { orderId: BigInt(args[0]), amount: o.price } })
        } else if (fn === 'confirmReceipt') {
          const o = c.orders.get(Number(args[0]))
          guard(o && o.buyer === from, 'NotBuyer'); guard(o.state === 1 || o.state === 2, 'BadState')
          settle(args[0], o)
        } else if (fn === 'release') {
          const o = c.orders.get(Number(args[0]))
          guard(o && o.seller === from, 'NotSeller'); guard(o.state === 2, 'BadState')
          guard(now() >= o.deliveredAt + Number(c.gracePeriod), 'BadState')
          settle(args[0], o)
        } else if (fn === 'withdraw') {
          const amount = c.credits.get(from) ?? 0n
          guard(amount > 0n, 'NothingToWithdraw')
          c.credits.set(from, 0n)
          credit(c.self, -amount, deltas); credit(from, amount, deltas)
          logs.push({ eventName: 'Withdrawn', args: { seller: from, amount } })
        } else throw new Error(`mock paywall: no apply ${fn}`)
        return { deltas, logs }
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

  const testTimeout = BigInt(opts.testTimeout ?? 300)
  const paywallMain = paywallContract({ self: MAIN, treasury: A_ADDR, feeBps: 1000, deliveryTimeout: 3n * 86400n, gracePeriod: 3n * 86400n })
  const paywallTest = paywallContract({ self: TEST, treasury: A_ADDR, feeBps: 1000, deliveryTimeout: testTimeout, gracePeriod: testTimeout })
  const registry = registryContract()
  const mailbox = mailboxContract()
  const contracts = new Map([[MAIN, paywallMain], [TEST, paywallTest], [REG, registry], [MBX, mailbox]])

  const testTimeoutCode = BigInt(opts.testTimeout ?? 300)
  const expectCode = (addr) => patchImmutablesMulti(artifactV2, {
    treasury: A_ADDR,
    deliveryTimeout: addr === MAIN ? 3n * 86400n : testTimeoutCode,
    gracePeriod: addr === MAIN ? 3n * 86400n : testTimeoutCode,
  })

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
        try { c.apply(functionName, args ?? [], addr, value ?? 0n, true) } catch (e) {
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
          const r = contracts.get(req.to).apply(functionName, args, req.account.address, req.value)
          deltas = [[req.account.address, -gas], ...r.deltas]
          logs = r.logs
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

function deployments({ testTimeout = '300' } = {}) {
  return {
    'auto-evm-mainnet-paywall': { address: V1M, blockNumber: '50', deliveryTimeout: '259200', gracePeriod: '259200', treasury: A_ADDR },
    'auto-evm-mainnet-paywall-test': { address: V1T, blockNumber: '55', deliveryTimeout: '259200', gracePeriod: '259200', treasury: A_ADDR },
    'auto-evm-mainnet-paywall-v2': { address: MAIN, txHash: '0x' + '9'.repeat(64), blockNumber: '60', treasury: A_ADDR, deliveryTimeout: (3n * 86400n).toString(), gracePeriod: (3n * 86400n).toString() },
    'auto-evm-mainnet-paywall-v2-test': { address: TEST, txHash: '0x' + '8'.repeat(64), blockNumber: '62', treasury: A_ADDR, deliveryTimeout: testTimeout, gracePeriod: testTimeout === '300' ? '300' : testTimeout },
    'auto-evm-mainnet-v2': { address: REG },
    'auto-evm-mainnet-mailbox': { address: MBX, blockNumber: '40' },
  }
}

async function setup({ faults = {}, testTimeout = '300' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pd-accept-test-'))
  const clock = { t: 1_767_139_200_000 } // fixed start (2026-01-01, deterministic)
  const mockConsensus = makeMockConsensus(clock)
  const mockEvm = makeMockEvm(faults, clock, { testTimeout: Number(testTimeout) })
  const runner = createRunner({
    A: mockEvm.mkClient(A_ADDR),
    C: mockEvm.mkClient(C_ADDR),
    abis: artifactV2.abi,
    mailboxAbis: mailboxArtifact.abi,
    registryAbi: REGISTRY_ABI,
    artifactV2,
    deployments: deployments({ testTimeout }),
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

test('S1 full first run (c,b,a) — TDZ fix + funds reconciled + single submission', async () => {
  const { runner, mockEvm, mockConsensus, dir } = await setup({})
  const { report, exitCode } = await runner.runOrResume(false, { runId: 's1', cap: '0.2', price: '0.01', paths: 'c,b,a' })
  assert(exitCode === 0, `exitCode ${exitCode} · status ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(report.status === 'passed', `status ${report.status}: ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(existsSync(path.join(dir, 's1', 'input.json')), 'input.json was not persisted')
  const input = readJson(dir, path.join('s1', 'input.json'))
  assert(JSON.stringify(input.paths) === JSON.stringify(['c', 'b', 'a']), 'paths were not frozen')
  assert(mockEvm.counts.purchase === 3, `purchase broadcasts ${mockEvm.counts.purchase} ≠ 3`)
  assert(mockEvm.counts.refund === 2, `refund broadcasts ${mockEvm.counts.refund} ≠ 2`)
  assert(mockConsensus.submitCount() === 2, `consensus submission blocks ${mockConsensus.submitCount()} ≠ 2 (single submission)`)
  assert(report.funds.A?.diff === '0' && report.funds.C?.diff === '0', `funds ledger not reconciled: A ${report.funds.A?.diff} / C ${report.funds.C?.diff}`)
  assert(report.finishReserveUsed === false, 'the safe-finish reserve should not have been used')
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
  await expectExit(runner.runOrResume(false, { runId: 's3', cap: '0.2', price: '0.01', paths: 'c' }), 2, 'S3 first run')
  const j1 = readJson(dir, path.join('s3', 'journal.json'))
  const c2 = j1.steps.find((s) => s.id === 'C2-purchase')
  assert(c2.state === 'submitted' && c2.txHash, 'C2 should be submitted+txHash (hash persisted before broadcast)')
  assert(mockEvm.counts.purchase === 1, `purchase broadcasts ${mockEvm.counts.purchase} ≠ 1`)
  // the order actually exists on the (mock) chain — the tx was included
  assert(mockEvm.state.txs.get(c2.txHash)?.receipt.status === 'success', 'the tx should have been accepted by the node')

  const { report, exitCode } = await runner.runOrResume(true, { runId: 's3' })
  assert(exitCode === 0 && report.status === 'passed', `resume did not pass: ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => `${g.name}(${g.detail})`).join('; ')}`)
  assert(mockEvm.counts.purchase === 1, `purchase broadcasts after resume ${mockEvm.counts.purchase} ≠ 1 (duplicate broadcast!)`)
})

test('S4 receipt wait timeout — no resend; resume verifies and completes', async () => {
  let triggered = false
  const { runner, mockEvm, dir } = await setup({
    faults: { waitTimeout: (tx) => { if (tx.ctx.fn === 'purchase' && !triggered) { triggered = true; return true } return false } },
  })
  await expectExit(runner.runOrResume(false, { runId: 's4', cap: '0.2', price: '0.01', paths: 'c' }), 2, 'S4 first run')
  const c2 = readJson(dir, path.join('s4', 'journal.json')).steps.find((s) => s.id === 'C2-purchase')
  assert(c2.state === 'submitted' && c2.txHash, 'C2 should be submitted+txHash')
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
  await expectExit(runner.runOrResume(false, { runId: 's5', cap: '0.2', price: '0.01', paths: 'c' }), 2, 'S5 first run')
  const before = JSON.stringify(mockEvm.counts)
  await expectExit(runner.runOrResume(true, { runId: 's5' }), 2, 'S5 re-entry')
  assert(JSON.stringify(mockEvm.counts) === before, `unknown re-entry must not broadcast: ${before} → ${JSON.stringify(mockEvm.counts)}`)
  const { report, exitCode } = await runner.reportOnly({ runId: 's5' })
  assert(report.status === 'blocked', `status ${report.status} ≠ blocked`)
  assert(exitCode === 2, `exitCode ${exitCode} ≠ 2`)
  assert(report.gates.find((g) => g.name === 'noOpenOrUnknownSteps')?.pass === false, 'the unknown gate should fail')
})

test('S6 C/B cross-process wait then resume — restored from the frozen plan; B not lost, A not run', async () => {
  const { runner, clock, mockEvm, dir } = await setup({ testTimeout: '259200' }) // 3 days → forces exit 3
  let caught = null
  try {
    await runner.runOrResume(false, { runId: 's6', cap: '0.2', price: '0.01', paths: 'c,b' })
  } catch (e) { caught = e }
  assert(caught instanceof Exit && caught.code === 3, `expected exit 3, got ${caught?.code ?? 'none'}: ${caught?.message}`)
  const j1 = readJson(dir, path.join('s6', 'journal.json'))
  assert(j1.pathResults.C?.finalState === 'refunded', 'C should have completed in the first run')
  assert(j1.steps.find((s) => s.id === 'B4-wait-timeout')?.nextEligibleAt, 'B4 should persist nextEligibleAt')
  assert(!j1.steps.some((s) => s.id.startsWith('A')), 'A is not in the frozen plan; no A steps may appear')

  clock.t += 4 * 86400 * 1000 // fast-forward 4 days
  const { report, exitCode } = await runner.runOrResume(true, { runId: 's6' })
  assert(exitCode === 0 && report.status === 'passed', `resume did not pass: ${report.status} · ${report.gates.filter((g) => !g.pass).map((g) => g.name).join(';')}`)
  assert(mockEvm.counts.purchase === 2, `purchase ${mockEvm.counts.purchase} ≠ 2 (C already has 1; B adds 1)`)
  assert(mockEvm.counts.refund === 2, `refund ${mockEvm.counts.refund} ≠ 2`)
  assert(!readJson(dir, path.join('s6', 'journal.json')).steps.some((s) => s.id.startsWith('A')), 'resume must not introduce out-of-plan A steps')
})

test('S7 insufficient budget — input-legality check rejects, zero broadcasts', async () => {
  const { runner, mockEvm } = await setup({})
  await expectExit(runner.runOrResume(false, { runId: 's7', cap: '0.001', price: '0.01', paths: 'c,b,a' }), 2, 'S7')
  assert(Object.keys(mockEvm.counts).length === 0, `broadcasts happened: ${JSON.stringify(mockEvm.counts)}`)
})

test('S8 codeMismatch — pre-write guard rejects, zero broadcasts', async () => {
  const s = await setup({})
  s.mockEvm.state.codeBad = TEST
  await expectExit(s.runner.runOrResume(false, { runId: 's8', cap: '0.2', price: '0.01', paths: 'c' }), 2, 'S8')
  assert(Object.keys(s.mockEvm.counts).length === 0, `broadcasts happened: ${JSON.stringify(s.mockEvm.counts)}`)
})

test('S9 partially executed paths — report says incomplete, never passed', async () => {
  const { runner, dir, mockEvm } = await setup({})
  // hand-crafted: input freezes paths=['c','a'], journal has only C1 planned
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.join(dir, 's9'), { recursive: true })
  writeFileSync(path.join(dir, 's9', 'input.json'), JSON.stringify({
    runId: 's9', commit: 'test-commit-0123456789', chainId: 870, instances: { main: MAIN, test: TEST },
    registry: REG, mailbox: MBX, mailboxDeployBlock: 40, roles: { A: A_ADDR, C: C_ADDR },
    price: '0.01', cap: '0.2', capWei: String(2n * 10n ** 17n), paths: ['c', 'a'],
    baseline: { balanceA: String(5n * AI3), balanceC: String(1n * AI3), creditsMain: '0', creditsTest: '0', contractMain: '0', contractTest: '0' },
  }))
  writeFileSync(path.join(dir, 's9', 'journal.json'), JSON.stringify({ runId: 's9', steps: [{ id: 'C1-list', state: 'planned' }], spend: { gas: '0', fees: '0', consensus: '0', escrow: '0' } }))
  const { report, exitCode } = await runner.reportOnly({ runId: 's9' })
  assert(report.status === 'incomplete', `status ${report.status} ≠ incomplete`)
  assert(exitCode === 2, `exitCode ${exitCode} ≠ 2`)
  assert(report.gates.find((g) => g.name === 'requiredPathsComplete')?.pass === false, 'the mandatory-paths gate should fail')
  // resume after the fault clears — C re-runs and A is added; no path is skipped
  const { report: r2, exitCode: e2 } = await runner.runOrResume(true, { runId: 's9' })
  assert(e2 === 0 && r2.status === 'passed', `resume did not pass: ${r2.status}`)
  assert(mockEvm.counts.purchase === 2, `purchase ${mockEvm.counts.purchase} ≠ 2 (one each for C+A)`)
})

test('S10 preflight gate: codeMatch=false must fail', async () => {
  const s = await setup({})
  s.mockEvm.state.codeBad = MAIN
  const { report, exitCode } = await s.runner.preflight({})
  assert(exitCode === 1, `exitCode ${exitCode} ≠ 1`)
  const g = report.gates.find((x) => x.name === 'v2Code_auto-evm-mainnet-paywall-v2')
  assert(g && g.pass === false, 'the v2Code gate should fail')
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
