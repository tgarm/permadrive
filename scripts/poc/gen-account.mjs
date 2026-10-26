// Generates a chain account (sr25519), writes it to .env (gitignored), prints addresses.
// The SS58 prefix differs by network: Autonomys mainnet = 6094 (addresses start with su…),
// taurus/chronos testnet = 6093 (addresses start with so…) — same account (same public key),
// just different display formats. Use the address format matching the network you fund.
// Funding: on mainnet, send mainnet AI3 to the mainnet-format address; the testnet token has
// no public faucet for now (see README).

import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { Keyring } from '@polkadot/api'
import { mnemonicGenerate } from '@polkadot/util-crypto'

const ENV_FILE = new URL('./.env', import.meta.url).pathname
const MAINNET_SS58 = 6094
const TESTNET_SS58 = 6093 // taurus / chronos

let mnemonic
if (existsSync(ENV_FILE)) {
  const m = readFileSync(ENV_FILE, 'utf8').match(/CHAIN_MNEMONIC\s*=\s*"?([^"\n]+?)"?\s*$/m)
  if (m) {
    mnemonic = m[1]
    console.log('using existing CHAIN_MNEMONIC from .env')
  }
}
if (!mnemonic) {
  mnemonic = mnemonicGenerate()
  const line = `CHAIN_MNEMONIC=${mnemonic}\n`
  writeFileSync(ENV_FILE, existsSync(ENV_FILE) ? '\n' + line : line)
  console.log('new mnemonic written to scripts/poc/.env (gitignored)')
}

const { cryptoWaitReady } = await import('@polkadot/util-crypto')
await cryptoWaitReady()

const keyring = new Keyring({ type: 'sr25519' })
const pair = keyring.addFromMnemonic(mnemonic)
const mainnetAddr = new Keyring({ type: 'sr25519', ss58Format: MAINNET_SS58 }).createFromUri(mnemonic).address
const testnetAddr = new Keyring({ type: 'sr25519', ss58Format: TESTNET_SS58 }).createFromUri(mnemonic).address

console.log('\npublic key         :', '0x' + Buffer.from(pair.publicKey).toString('hex'))
console.log('address (MAINNET 6094):', mainnetAddr, '← use this for mainnet transfers')
console.log('address (TESTNET 6093):', testnetAddr, '(taurus/chronos)')
console.log('address (generic 42)  :', pair.address)

// Balance on the connected chain (CHAIN_RPC); tolerates being offline
try {
  const { connectApi } = await import('./lib/chain.mjs')
  const api = await connectApi()
  const { data } = await api.query.system.account(pair.address)
  console.log('free balance       :', data.free.toHuman(), `(on ${api.rpc.system.chain.toString()})`)
  await api.disconnect()
} catch (e) {
  console.log('(chain unreachable, skip balance check:', e.message.slice(0, 80) + ')')
}
