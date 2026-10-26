// P2 · XDM transfer: consensus-chain AI3 → Auto-EVM (transporter.transfer).
// Arrival takes ~10 minutes (100 domain blocks); this script only ensures the source-chain
// tx gets included and confirmed.
// EVM recipient = BIP44 m/44'/60'/0'/0/0 derivation of CHAIN_MNEMONIC (viem, same default
// path as ethers) — same origin as the Substrate sr25519 account but a different curve;
// one mnemonic manages both sides.
//
// Measured findings (2026-10-26):
//  - Mainnet metadata natively defines all transporter types, so the custom type set from
//    ai3-xdm-bridge is NOT needed, and neither is @autonomys/auto-xdm — plain objects
//    work as-is
//  - A bare WsProvider/HttpProvider fires several requests the moment it connects and hits
//    rate limiting (public nodes rate-limit by frequency; while banned even system_chain
//    is refused), so a paced provider is mandatory (same as P1)
// Usage: npm run xdm-transfer -- [--amount AI3 amount, default 1 (protocol minimum)]

import { readFileSync, existsSync } from 'node:fs'
import { ApiPromise, Keyring } from '@polkadot/api'
import { mnemonicToAccount } from 'viem/accounts'
import { PacedHttpProvider, RawRpc, sleep } from './lib/rpc.mjs'

const CONSENSUS_RPC = 'https://rpc.mainnet.subspace.foundation/ws'
const EVM_DOMAIN_ID = 0 // Auto-EVM

const argv = process.argv.slice(2)
const amountIdx = argv.indexOf('--amount')
const amountAi3 = amountIdx >= 0 ? Number(argv[amountIdx + 1]) : 1

const mnemonic = (() => {
  if (process.env.CHAIN_MNEMONIC) return process.env.CHAIN_MNEMONIC
  const envFile = new URL('../poc/.env', import.meta.url).pathname
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*CHAIN_MNEMONIC\s*=\s*"?([^"\n]+?)"?\s*$/m)
    if (m) return m[1]
  }
  throw new Error('missing CHAIN_MNEMONIC in scripts/poc/.env')
})()

const { cryptoWaitReady } = await import('@polkadot/util-crypto')
await cryptoWaitReady()

const pair = new Keyring({ type: 'sr25519' }).addFromMnemonic(mnemonic)
const evmAccount = mnemonicToAccount(mnemonic) // m/44'/60'/0'/0/0
console.log('substrate signer :', pair.address)
console.log('evm recipient    :', evmAccount.address)
if (!(amountAi3 >= 1)) throw new Error(`XDM protocol minimum is 1 AI3, got ${amountAi3}`)
const amountWei = BigInt(amountAi3 * 1e6) * 10n ** 12n // via integers to avoid floating-point rounding error
console.log('amount           :', amountAi3, 'AI3')

// Warm-up probe: rate-limit bans can last tens of minutes; send a single light request first (5s interval) to confirm availability
const probe = new RawRpc(CONSENSUS_RPC, { minIntervalMs: 5000, maxRetries: 8 })
console.log('probe            :', await probe.call('system_chain', []))

const api = await ApiPromise.create({
  provider: new PacedHttpProvider(CONSENSUS_RPC, { minIntervalMs: 2000 }),
  noInitWarn: true,
})

async function main() {
  const { data } = await api.query.system.account(pair.address)
  console.log('consensus balance:', (Number(data.free.toBigInt()) / 1e18).toFixed(4), 'AI3')

  const tx = api.tx.transporter.transfer(
    { chainId: { Domain: EVM_DOMAIN_ID }, accountId: { AccountId20: evmAccount.address } },
    amountWei,
  )

  const nonce = (await api.rpc.system.accountNextIndex(pair.address)).toNumber()
  await tx.signAsync(pair, { nonce })
  const txHash = tx.hash.toHex()
  console.log('signed tx        :', txHash, 'nonce', nonce)

  // After submission, scan the best chain for the inclusion block and wait 12 confirmations
  // (finality lags badly — never wait for finalized)
  await api.rpc.author.submitExtrinsic(tx.toHex())
  const start = (await api.rpc.chain.getHeader()).number.toNumber()
  let inclusion = null
  const deadline = Date.now() + 8 * 60_000
  while (!inclusion && Date.now() < deadline) {
    const header = await api.rpc.chain.getHeader()
    for (let h = start; h <= header.number.toNumber() && !inclusion; h++) {
      const bh = await api.rpc.chain.getBlockHash(h)
      if (bh.toHex() === '0x' + '0'.repeat(64)) continue
      const block = await api.rpc.chain.getBlock(bh)
      if (block.block.extrinsics.some((ex) => ex.hash.toHex() === txHash)) inclusion = { height: h, hash: bh.toHex() }
    }
    if (!inclusion) await sleep(6000)
  }
  if (!inclusion) throw new Error('tx not included within the timeout (may still be in the pool — do not resubmit with the same nonce; rescan later)')
  console.log('in block         : #', inclusion.height, inclusion.hash)

  while (Date.now() < deadline) {
    const header = await api.rpc.chain.getHeader()
    if (header.number.toNumber() >= inclusion.height + 12) {
      const canonical = await api.rpc.chain.getBlockHash(inclusion.height)
      if (canonical.toHex() !== inclusion.hash) throw new Error('inclusion block was reorged away, needs inspection')
      console.log('confirmed        : 12 blocks + canonical ✓')
      console.log('\nEVM side will receive the funds in ~10 minutes (100 domain blocks). Balance check:')
      console.log(`curl -s -X POST https://auto-evm.mainnet.autonomys.xyz/ws -H 'Content-Type: application/json' \\`)
      console.log(`  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["${evmAccount.address}","latest"]}'`)
      return
    }
    await sleep(6000)
  }
  throw new Error('timed out waiting for confirmation depth')
}

try {
  await main()
} finally {
  await api.disconnect()
}
