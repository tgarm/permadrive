// FileState offline adversarial tests (2026-11-03) — local ganache EVM (npm
// devDependency), zero mainnet funds. Alternative: LOCAL_EVM_RPC pointing at a
// running anvil.
//   node file-state-test.mjs            # in-process ganache (random port), auto-shutdown
//   LOCAL_EVM_RPC=http://127.0.0.1:8545 node file-state-test.mjs   # reuse a running instance
//
// Accounts: A/B/C, three independent owner namespaces (FileState has no
// permission surface — no owner/treasury).
// Covered scenarios:
//   t01 setHidden(true/false) state + Hidden/Unhidden event args
//   t02 same-value set is an idempotent no-op (no events)
//   t03 owner namespace isolation (mutually invisible, no override surface)
//   t04 hiddenFlags batch: mixed set/unset, order-aligned, empty array
//   t05 arbitrary string CIDs can be marked (permissionless, long/special chars)
//   t06 repeated toggles keep state and events consistent
//   t07 setProp/prop write-read consistency + PropSet event (owner/propKey indexed)
//   t08 props batch: order-aligned, unset returns 0x0
//   t09 setProp value=0x0 clear semantics + same-value idempotent no-op
//   t10 props namespace isolation; same cid multi propKey / cross-cid same propKey never overwrite
//   t11 hidden and props facets on the same cid never interfere
//   t12 gas log (first set / no-op / setProp / large hiddenFlags array)
//
// The contract has no revert path (no permissions, no validation) — no expectRevert.

import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/FileState.json', import.meta.url).pathname, 'utf8'))
// "test test …" mnemonic — ganache prefunded accounts, same source as anvil defaults
const MNEMONIC = 'test test test test test test test test test test test junk'

// ---- local EVM lifecycle (default in-process ganache; LOCAL_EVM_RPC for external anvil) ----

const EXTERNAL_RPC = process.env.LOCAL_EVM_RPC || process.env.ANVIL_RPC || null
let server = null
let rpcUrl = EXTERNAL_RPC
if (!rpcUrl) {
  const ganache = (await import('ganache')).default
  // Random ports can still collide (EADDRINUSE) — retry on a new port
  for (let attempt = 0; ; attempt++) {
    const port = 46000 + Math.floor(Math.random() * 8000)
    const candidate = ganache.server({ chain: { chainId: 1337 }, wallet: { mnemonic: MNEMONIC }, logging: { quiet: true } })
    try {
      await candidate.listen(port)
      server = candidate
      rpcUrl = `http://127.0.0.1:${port}`
      break
    } catch (e) {
      if (e?.code === 'EADDRINUSE' && attempt < 4) continue
      throw e
    }
  }
}
// ganache's close() has a known throw quirk on the exit path — swallow it; process exit reclaims everything
const cleanup = async () => { if (server) { try { await server.close() } catch { /* ignore */ } server = null } }
process.on('SIGINT', () => { void cleanup(); process.exit(130) })

// ---- viem clients ----

const localChain = defineChain({
  id: 1337,
  name: 'local-evm',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const ACCOUNT_KEYS = [
  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80n, // #0
  0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690dn, // #1
  0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffban, // #2
]
function clientFor(i) {
  const account = privateKeyToAccount(`0x${ACCOUNT_KEYS[i].toString(16).padStart(64, '0')}`)
  return {
    account,
    address: account.address,
    publicClient: createPublicClient({ chain: localChain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, chain: localChain, transport: http(rpcUrl) }),
  }
}
const A = clientFor(0)
const B = clientFor(1)
const C = clientFor(2)
console.log('local evm:', rpcUrl)
console.log('A:', A.address)
console.log('B:', B.address)
console.log('C:', C.address)

// ---- deploy (FileState has no constructor args) ----

const hash = await A.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [], chain: localChain })
const deployRx = await A.publicClient.waitForTransactionReceipt({ hash })
if (deployRx.status !== 'success') throw new Error('deploy failed')
const PC = artifact.abi
const ADDR = deployRx.contractAddress
console.log('FileState:', ADDR, `· block ${deployRx.blockNumber} · gas ${deployRx.gasUsed}`)

const read = (c, fn, args = []) => c.publicClient.readContract({ address: ADDR, abi: PC, functionName: fn, args })
async function write(c, fn, args = []) {
  const h = await c.walletClient.writeContract({ address: ADDR, abi: PC, functionName: fn, args, chain: localChain })
  const rx = await c.publicClient.waitForTransactionReceipt({ hash: h })
  if (rx.status !== 'success') throw new Error(`${fn} tx ${rx.status}`)
  return rx
}
const eventsOf = (rx) => rx.logs.map((l) => { try { return decodeEventLog({ abi: PC, data: l.data, topics: l.topics }) } catch { return null } }).filter(Boolean)
// propKey convention matches the frontend: keccak256(readable name)
const pk = (name) => keccak256(toHex(name))

// ---- assertions ----

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    void cleanup()
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const CID1 = 'bafkr6abcdef11111111111111111111111111111111111111111111111111111'
const CID2 = 'bafkr6abcdef22222222222222222222222222222222222222222222222222222'
const CID3 = 'bafkr6abcdef33333333333322222222222222222222222222222222222222222'
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

// t01 setHidden state + events
{
  const rx = await write(B, 'setHidden', [CID1, true])
  ok((await read(B, 'isHidden', [B.address, CID1])) === true, 't01a setHidden(true) → isHidden true')
  const evs = eventsOf(rx)
  ok(evs.length === 1 && evs[0].eventName === 'Hidden', 't01b exactly one Hidden event')
  ok(evs[0].args.owner === B.address && evs[0].args.manifestCid === CID1, 't01c Hidden event owner/manifestCid correct')
  const rx2 = await write(B, 'setHidden', [CID1, false])
  ok((await read(B, 'isHidden', [B.address, CID1])) === false, 't01d setHidden(false) → isHidden false')
  const evs2 = eventsOf(rx2)
  ok(evs2.length === 1 && evs2[0].eventName === 'Unhidden' && evs2[0].args.manifestCid === CID1, 't01e Unhidden event correct')
}

// t02 same-value idempotent no-op: no events
{
  await write(B, 'setHidden', [CID2, true])
  const rx = await write(B, 'setHidden', [CID2, true])
  ok(rx.logs.length === 0, 't02a repeated setHidden(same value) emits no event')
  ok((await read(B, 'isHidden', [B.address, CID2])) === true, 't02b state preserved')
  const rx3 = await write(B, 'setHidden', [CID2, false])
  const rx3b = await write(B, 'setHidden', [CID2, false])
  ok(rx3b.logs.length === 0, 't02c repeated setHidden(false, same value) emits no event')
}

// t03 owner namespace isolation
{
  await write(B, 'setHidden', [CID3, true])
  ok((await read(C, 'isHidden', [B.address, CID3])) === true, 't03a C reading B\u2019s mark with explicit owner sees true')
  ok((await read(C, 'isHidden', [C.address, CID3])) === false, 't03b C\u2019s own namespace unaffected')
  await write(C, 'setHidden', [CID3, false])
  ok((await read(C, 'isHidden', [B.address, CID3])) === true, 't03c C writing its own namespace does not touch B\u2019s mark')
  ok((await read(A, 'isHidden', [A.address, CID3])) === false, 't03d A namespace defaults to unmarked')
}

// t04 hiddenFlags batch
{
  await write(A, 'setHidden', [CID1, true])
  await write(A, 'setHidden', [CID3, true])
  const flags = await read(A, 'hiddenFlags', [A.address, [CID1, CID2, CID3]])
  ok(flags.length === 3 && flags[0] === true && flags[1] === false && flags[2] === true, 't04a hiddenFlags mixed query order-aligned, unmarked false')
  const empty = await read(A, 'hiddenFlags', [A.address, []])
  ok(Array.isArray(empty) && empty.length === 0, 't04b empty array returns empty array')
}

// t05 arbitrary string CIDs can be marked (permissionless, no registry existence check)
{
  const weird = 'not-even-a-cid special:chars?&#üöä-Ωλ'
  const long = 'x'.repeat(512)
  await write(A, 'setHidden', [weird, true])
  await write(A, 'setHidden', [long, true])
  ok((await read(A, 'isHidden', [A.address, weird])) === true, 't05a special-char strings can be marked')
  ok((await read(A, 'isHidden', [A.address, long])) === true, 't05b over-long strings can be marked')
  const flags = await read(A, 'hiddenFlags', [A.address, [weird, long]])
  ok(flags[0] === true && flags[1] === true, 't05c batch view agrees with single query')
}

// t06 repeated toggles stay consistent
{
  const cid = 'bafkr6toggle000000000000000000000000000000000000000000000000000001'
  const names = []
  for (const v of [true, false, true]) {
    const rx = await write(A, 'setHidden', [cid, v])
    const evs = eventsOf(rx)
    names.push(evs[0]?.eventName)
  }
  ok(names.join(',') === 'Hidden,Unhidden,Hidden', 't06a consecutive toggles emit the right event sequence')
  ok((await read(A, 'isHidden', [A.address, cid])) === true, 't06b final state correct')
}

// t07 setProp/prop write-read consistency + event
{
  const key1 = pk('prop.diff.kind')
  const val1 = pk('text-line')
  const rx = await write(A, 'setProp', [CID1, key1, val1])
  ok((await read(A, 'prop', [A.address, CID1, key1])) === val1, 't07a setProp → prop write-read consistent')
  const evs = eventsOf(rx)
  ok(evs.length === 1 && evs[0].eventName === 'PropSet', 't07b exactly one PropSet event')
  ok(evs[0].args.owner === A.address && evs[0].args.propKey === key1 && evs[0].args.value === val1, 't07c PropSet event fields correct')
  ok(evs[0].args.manifestCid === CID1, 't07d PropSet event manifestCid correct')
}

// t08 props batch: order-aligned, unset returns 0x0
{
  const k1 = pk('prop.diff.kind')
  const k2 = pk('prop.diff.base')
  const k3 = pk('prop.compression')
  const v1 = pk('text-line')
  const v2 = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  await write(A, 'setProp', [CID2, k1, v1])
  await write(A, 'setProp', [CID2, k2, v2])
  const vals = await read(A, 'props', [A.address, CID2, [k1, k2, k3]])
  ok(vals.length === 3 && vals[0] === v1 && vals[1] === v2 && vals[2] === ZERO32, 't08a props batch order-aligned, unset 0x0')
  const empty = await read(A, 'props', [A.address, CID2, []])
  ok(Array.isArray(empty) && empty.length === 0, 't08b empty array returns empty array')
}

// t09 value=0x0 clear semantics + same-value idempotent no-op
{
  const key = pk('prop.diff.kind')
  await write(A, 'setProp', [CID3, key, pk('text-line')])
  const rxClear = await write(A, 'setProp', [CID3, key, ZERO32])
  ok((await read(A, 'prop', [A.address, CID3, key])) === ZERO32, 't09a value=0x0 clears the property')
  ok(eventsOf(rxClear).length === 1, 't09b clearing still emits PropSet (value=0)')
  const rxAgain = await write(A, 'setProp', [CID3, key, ZERO32])
  ok(rxAgain.logs.length === 0, 't09c rewriting the same (cleared) value emits no event')
}

// t10 props namespace isolation and key combinations
{
  const k = pk('prop.diff.base')
  const vB = pk('owner-b-base')
  const vC = pk('owner-c-base')
  await write(B, 'setProp', [CID1, k, vB])
  await write(C, 'setProp', [CID1, k, vC])
  ok((await read(B, 'prop', [B.address, CID1, k])) === vB, 't10a B namespace value independent')
  ok((await read(C, 'prop', [C.address, CID1, k])) === vC, 't10b C namespace value independent')
  const kOther = pk('prop.compression')
  const vOther = pk('zlib-9')
  await write(B, 'setProp', [CID1, kOther, vOther])
  ok((await read(B, 'prop', [B.address, CID1, k])) === vB && (await read(B, 'prop', [B.address, CID1, kOther])) === vOther, 't10c same cid different propKeys never overwrite each other')
  await write(B, 'setProp', [CID2, k, pk('other-cid-base')])
  ok((await read(B, 'prop', [B.address, CID1, k])) === vB, 't10d different cids same propKey never cross-contaminate')
}

// t11 hidden and props facets on the same cid never interfere
{
  const cid = 'bafkr6face00000000000000000000000000000000000000000000000000001'
  const k = pk('prop.diff.kind')
  const v = pk('text-line')
  await write(B, 'setProp', [cid, k, v])
  await write(B, 'setHidden', [cid, true])
  ok((await read(B, 'isHidden', [B.address, cid])) === true, 't11a hidden facet independently writable')
  ok((await read(B, 'prop', [B.address, cid, k])) === v, 't11b props value unaffected by hidden writes')
  await write(B, 'setProp', [cid, k, pk('binary')])
  ok((await read(B, 'isHidden', [B.address, cid])) === true, 't11c hidden value unaffected by props writes')
}

// t12 gas log
{
  const cid = 'bafkr6gas000000000000000000000000000000000000000000000000000000001'
  const first = await write(A, 'setHidden', [cid, true])
  const noop = await write(A, 'setHidden', [cid, true])
  const prop = await write(A, 'setProp', [cid, pk('prop.diff.kind'), pk('text-line')])
  const bigList = Array.from({ length: 50 }, (_, i) => `bafkr6batch${String(i).padStart(45, '0')}`)
  const flags = await A.publicClient.readContract({ address: ADDR, abi: PC, functionName: 'hiddenFlags', args: [A.address, bigList] })
  ok(flags.length === 50, 't12a 50-item batch query works')
  console.log(`gas: setHidden first ${first.gasUsed} · no-op ${noop.gasUsed} · setProp ${prop.gasUsed} · deploy ${deployRx.gasUsed}`)
  ok(first.gasUsed > noop.gasUsed, 't12b first set costs more than a no-op')
}

console.log(`\nAll ${passed} assertions passed`)
await cleanup()
process.exit(0)
