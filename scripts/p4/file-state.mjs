// FileState mainnet selftest (2026-11-03). Real transactions (gas-only, no
// fee); re-runs pick a fresh CID automatically.
//   node file-state.mjs
//
// Flow (main instance): a fresh CID (selftest- prefix, matching no real
// registry entry — FileState is permissionless and decoupled from registry
// existence):
//   setHidden(true) → isHidden/hiddenFlags readback → Hidden event check
//   → same-value replay no-op (receipt has zero logs) → setHidden(false) →
//   Unhidden event
//   → setProp writes the diff.kind digest → prop/props readback → same-value
//   replay no-op → value=0 clear
//   → namespace isolation (another account reading this account's hidden is
//   always false)
// Note: setHidden is a value=0 write and never triggers the domain estimator's
// OutOfFund false positive (that only affects value>0 calls), so no explicit
// gas is needed.

import { readFileSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3 } from '../p3/lib/chain.mjs'
import { keccak256, toHex, decodeEventLog } from 'viem'

const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const FS = deployments['auto-evm-mainnet-file-state']
if (!FS) throw new Error('deployments.json lacks auto-evm-mainnet-file-state — run deploy-file-state.mjs first')
const abi = JSON.parse(readFileSync(new URL('../../contracts/out/FileState.json', import.meta.url).pathname, 'utf8')).abi

const A = clients(0)
const B = clients(1)
console.log('A (owner):', A.address, '·', ai3(await A.publicClient.getBalance({ address: A.address })))
console.log('B (second namespace):', B.address)
console.log('fileState:', FS.address)

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

const read = (c, fn, args = []) => c.publicClient.readContract({ address: FS.address, abi, functionName: fn, args })
async function write(c, fn, args = []) {
  const hash = await c.walletClient.writeContract({ address: FS.address, abi, functionName: fn, args, chain: autoEvm })
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(`${fn} tx ${receipt.status}`)
  return receipt
}
const eventsOf = (receipt) =>
  receipt.logs.filter((l) => l.address.toLowerCase() === FS.address.toLowerCase()).map((l) => decodeEventLog({ abi, data: l.data, topics: l.topics }))
const pk = (name) => keccak256(toHex(name))
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

const cid = `selftest-filestate-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

// ---------- hide round trip ----------
{
  const rx = await write(A, 'setHidden', [cid, true])
  ok((await read(A, 'isHidden', [A.address, cid])) === true, 'setHidden(true) → isHidden true (mainnet readback)')
  const evs = eventsOf(rx)
  ok(evs.length === 1 && evs[0].eventName === 'Hidden' && evs[0].args.owner === A.address && evs[0].args.manifestCid === cid, 'Hidden event owner/manifestCid correct')
  const flags = await read(A, 'hiddenFlags', [A.address, [cid, `${cid}-other`]])
  ok(flags.length === 2 && flags[0] === true && flags[1] === false, 'hiddenFlags batch readback (unmarked false)')

  const rx2 = await write(A, 'setHidden', [cid, true])
  ok(rx2.logs.length === 0, 'same-value replay no-op (zero logs, replay-safe)')

  const rx3 = await write(A, 'setHidden', [cid, false])
  ok((await read(A, 'isHidden', [A.address, cid])) === false, 'setHidden(false) → isHidden false')
  const evs3 = eventsOf(rx3)
  ok(evs3.length === 1 && evs3[0].eventName === 'Unhidden', 'Unhidden event correct')
}

// ---------- props layer (diff/compression reserve slots) ----------
{
  const key = pk('prop.diff.kind')
  const val = pk('text-line')
  const rx = await write(A, 'setProp', [cid, key, val])
  ok((await read(A, 'prop', [A.address, cid, key])) === val, 'setProp → prop write-read consistent (mainnet)')
  const evs = eventsOf(rx)
  ok(evs.length === 1 && evs[0].eventName === 'PropSet' && evs[0].args.propKey === key && evs[0].args.value === val, 'PropSet event fields correct')
  const vals = await read(A, 'props', [A.address, cid, [key, pk('prop.compression')]])
  ok(vals.length === 2 && vals[0] === val && vals[1] === ZERO32, 'props batch readback (unset 0x0)')
  const rx2 = await write(A, 'setProp', [cid, key, val])
  ok(rx2.logs.length === 0, 'setProp same-value replay no-op')
  await write(A, 'setProp', [cid, key, ZERO32])
  ok((await read(A, 'prop', [A.address, cid, key])) === ZERO32, 'value=0x0 clears the property')
}

// ---------- namespace isolation ----------
{
  const cid2 = `selftest-filestate-iso-${Date.now()}`
  await write(A, 'setHidden', [cid2, true])
  ok((await read(B, 'isHidden', [B.address, cid2])) === false, 'B namespace unaffected by A\u2019s mark')
  ok((await read(A, 'isHidden', [A.address, cid2])) === true, 'A\u2019s own mark preserved')
  await write(A, 'setHidden', [cid2, false]) // tidy up (selftest CID has no real entry)
}

console.log(`\nAll ${passed} assertions passed (real mainnet transactions, gas-only)`)
process.exit(0)
