// FileRegistryV2 helper operations (Node side):
//   node registry-v2.mjs info                          (address / fee rates / owner / treasury)
//   node registry-v2.mjs entries <address>
//   node registry-v2.mjs quote <size>
//   node registry-v2.mjs code                          (compares against the v2 compiled artifact)
//   node registry-v2.mjs selftest                      (mainnet semantic tests, real txs, dust-level cost)
// Reads go over the public RPC; writes are locally signed with the EVM account derived from CHAIN_MNEMONIC.

import { readFileSync } from 'node:fs'
import { decodeEventLog } from 'viem'
import { autoEvm, clients, deploymentV2, ai3, patchImmutables } from './lib/chain.mjs'
import { REGISTRY_ABI } from '../../frontend/src/lib/registry-abi.ts'

const RPC = 'https://auto-evm.mainnet.autonomys.xyz/ws'
const ARTIFACT = new URL('../../contracts/out/FileRegistryV2.json', import.meta.url).pathname

const { address: signer, publicClient, walletClient } = clients()
const REGISTRY = deploymentV2().address
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))

const pretty = (_, v) => (typeof v === 'bigint' ? v.toString() : v)

async function receiptOf(hash) {
  const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (r.status !== 'success') throw new Error(`tx ${r.status}: ${hash}`)
  return r
}

function feeFromReceipt(receipt) {
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics })
      if (ev.eventName === 'FeePaid') return ev.args.amount
    } catch {
      /* not an event of this contract */
    }
  }
  return null
}

async function expectRevert(label, fn, needle) {
  try {
    await fn()
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (msg.toLowerCase().includes(needle.toLowerCase())) {
      console.log(`  ✓ ${label} → revert ${needle}`)
      return
    }
    throw new Error(`${label}: expected revert ${needle}, got: ${msg.slice(0, 200)}`)
  }
  throw new Error(`${label}: expected revert ${needle}, but the tx succeeded`)
}

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'info') {
  const [fpb, mf, owner, treasury] = await Promise.all(
    ['feePerByte', 'minFee', 'owner', 'treasury'].map((f) =>
      publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: f }),
    ),
  )
  console.log(JSON.stringify({ address: REGISTRY, feePerByte: fpb, minFee: mf, owner, treasury }, pretty, 2))
} else if (cmd === 'entries') {
  const entries = await publicClient.readContract({
    address: REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'entries',
    args: [args[0]],
  })
  console.log(JSON.stringify(entries, pretty, 2))
} else if (cmd === 'quote') {
  const q = await publicClient.readContract({
    address: REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'quote',
    args: [BigInt(args[0])],
  })
  console.log(`quote(${args[0]} bytes) = ${q} wei = ${ai3(q)}`)
} else if (cmd === 'code') {
  const code = await publicClient.getCode({ address: REGISTRY })
  const dep = deploymentV2()
  const expected = patchImmutables(artifact, dep.treasury ?? dep.deployer)
  console.log('code match:', code === expected ? '✓ identical (after immutable patch)' : '✗')
} else if (cmd === 'selftest') {
  console.log('== FileRegistryV2 semantic selftest (real mainnet txs, fees paid to treasury = self) ==')
  console.log('contract:', REGISTRY, '· signer:', signer)
  const [fpb, mf] = await Promise.all([
    publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'feePerByte' }),
    publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'minFee' }),
  ])
  const treasury = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'treasury' })
  const before = await publicClient.getBalance({ address: treasury })

  // 0. Idempotent pre-cleanup: an interrupted previous selftest may have left test entries behind
  const ownCleanup = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'entries', args: [signer] })
  for (const e of ownCleanup) {
    if (!e.name.startsWith('v2-selftest')) continue
    await receiptOf(
      await walletClient.writeContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'remove', account: walletClient.account, args: [e.manifestCid] }),
    )
    console.log(`  ⤺ pre-cleanup: removing leftover ${e.name}`)
  }

  // 1. quote formula
  const q1 = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'quote', args: [1n] })
  const q1m = await publicClient.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'quote', args: [1048576n],
  })
  if (q1 !== mf) throw new Error(`quote(1) != minFee (${q1} vs ${mf})`)
  if (q1m !== 1048576n * fpb) throw new Error(`quote(1MB) != size×feePerByte`)
  console.log(`  ✓ quote formula: 1B → floor ${ai3(q1)}; 1MB → ${ai3(q1m)} (5% model)`)

  const CID_A = 'bafkr-selftest-v2-entry-a'
  const CID_B = 'bafkr-selftest-v2-entry-b'
  // Payer snapshot: after pre-cleanup, before the two registers (the `before` above only serves the treasury≠signer branch)
  const payerBefore = await publicClient.getBalance({ address: signer })
  const reg = (cid, name, size, value) =>
    walletClient.writeContract({
      address: REGISTRY, abi: REGISTRY_ABI, functionName: 'register', account: walletClient.account,
      args: [cid, 0, name, size], value,
    })

  // 2. minFee path + overpay refund: size=1 takes the floor; the extra 0.001 AI3 must be refunded
  const hashA = await reg(CID_A, 'v2-selftest-a', 1n, mf + 10n ** 15n)
  const rA = await receiptOf(hashA)
  const feeA = feeFromReceipt(rA)
  if (feeA !== mf) throw new Error(`FeePaid != minFee (${feeA} vs ${mf}) — overpay not accounted per quote`)
  console.log(`  ✓ register (floor path, overpay refunded): FeePaid = ${ai3(feeA)} · gas ${rA.gasUsed}`)

  // 3. bySize path: billed at 1MB
  const hashB = await reg(CID_B, 'v2-selftest-b', 1048576n, q1m)
  const rB = await receiptOf(hashB)
  const feeB = feeFromReceipt(rB)
  if (feeB !== q1m) throw new Error('FeePaid(1MB) != quote(1MB)')
  console.log(`  ✓ register (bySize path): FeePaid = ${ai3(feeB)} · gas ${rB.gasUsed}`)

  // 4. Funds-flow verification: the 1e15 wei of overpay was refunded. When treasury ≠ payer,
  //    check the treasury delta directly; during development treasury == signer (balance
  //    mixed with gas), so verify precisely from the payer side instead:
  //    net change = -(Σfee) - Σ(gasUsed×effectiveGasPrice)
  const gasCost = (r) => r.gasUsed * (r.effectiveGasPrice ?? 0n)
  if (treasury.toLowerCase() !== signer.toLowerCase()) {
    const after = await publicClient.getBalance({ address: treasury })
    const delta = after - before
    if (delta !== feeA + feeB) throw new Error(`treasury delta ${delta} != ${feeA + feeB} (refund path leaks funds)`)
    console.log(`  ✓ treasury received ${ai3(delta)} = Σ FeePaid (the overpay was indeed refunded to the payer)`)
  } else {
    // fee paid to self → net zero; the net change must equal exactly the gas of the two txs.
    // If the 1e15 overpay were not refunded, or the treasury transfer leaked, this equation
    // would break.
    const signerAfter = await publicClient.getBalance({ address: signer })
    const expected = payerBefore - gasCost(rA) - gasCost(rB)
    if (signerAfter !== expected) {
      throw new Error(`signer net change mismatch: ${signerAfter} != ${expected} (overpay not refunded, or the funds flow is wrong)`)
    }
    console.log(`  ✓ payer net change = pure gas (fee paid to self nets 0, overpay indeed refunded)`)
  }

  // 5. underpay revert
  await expectRevert('underpay', () => reg('bafkr-selftest-v2-underpay', 'x', 1048576n, q1m - 1n), 'InsufficientFee')

  // 6. DuplicateEntry revert
  await expectRevert('DuplicateEntry', () => reg(CID_A, 'v2-selftest-a', 1n, mf), 'DuplicateEntry')

  // 7. entries decoding (6-field Entry including feePaid)
  const entries = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'entries', args: [signer] })
  const cidSet = new Set(entries.map((e) => e.manifestCid))
  if (!cidSet.has(CID_A) || !cidSet.has(CID_B)) throw new Error('entries is missing test entries')
  if (entries.find((e) => e.manifestCid === CID_B).feePaid !== feeB) throw new Error('Entry.feePaid does not match the FeePaid event')
  console.log(`  ✓ entries view: ${entries.length} entries, Entry.feePaid correct`)

  // 8. setFee boundaries: the original values can be re-set; exceeding the cap reverts; the
  //    non-owner path would need another address (only the cap is verified here)
  const setFee = (fpb_, mf_) =>
    walletClient.writeContract({
      address: REGISTRY, abi: REGISTRY_ABI, functionName: 'setFee', account: walletClient.account, args: [fpb_, mf_],
    })
  await receiptOf(await setFee(fpb, mf))
  await expectRevert('rate cap', () => setFee(2n * 10n ** 13n + 1n, mf), 'FeeRateTooHigh')
  console.log('  ✓ setFee: owner re-set with the original values succeeded; above MAX_FEE_PER_BYTE reverts')

  // 9. Cleanup: remove → count drops → NotFound
  const rm = (cid) =>
    walletClient.writeContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'remove', account: walletClient.account, args: [cid] })
  await receiptOf(await rm(CID_A))
  await receiptOf(await rm(CID_B))
  const countAfter = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'count', args: [signer] })
  if (countAfter !== 0n) throw new Error(`after remove, count=${countAfter}`)
  await expectRevert('NotFound', () => rm(CID_A), 'NotFound')
  console.log('  ✓ remove cleanup: count=0; repeated remove → NotFound')

  console.log('== all selftest checks passed ==')
} else {
  console.log('usage: registry-v2.mjs info | entries <address> | quote <size> | code | selftest')
}
