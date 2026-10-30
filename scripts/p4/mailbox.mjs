// Mailbox mainnet selftest. Real transactions, idempotent.
//   node mailbox.mjs             # full flow: offline checks → funding → announce ×2 → send → getLogs readback
//   node mailbox.mjs send <text> # manually send a message to A0 (for the browser e2e)
//   node mailbox.mjs read B      # read and decrypt B's inbox (verifies the browser's reply)
//
// Accounts: A = m/44'/60'/0'/0/0 (the project's main account, same as the
// browser); B = index 1 (the selftest counterparty, funded with 0.05 AI3 from
// A automatically when broke). The crypto channel is the real frontend
// boxCrypto.ts (localBoxKeypair/boxEncrypt/boxDecryptWithSecretKey, imported
// directly by Node).

import { readFileSync } from 'node:fs'
import { autoEvm, clients, DEPLOYMENTS, ai3 } from '../p3/lib/chain.mjs'
import {
  localBoxKeypair,
  boxEncrypt,
  boxDecryptWithSecretKey,
  parseEnvelope,
  serializeEnvelope,
} from '../../frontend/src/lib/boxCrypto.ts'

const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const mailbox = deployments['auto-evm-mainnet-mailbox']
if (!mailbox) throw new Error('deployments.json has no auto-evm-mainnet-mailbox — run the mailbox deploy first')
const MAILBOX = mailbox.address
const DEPLOY_BLOCK = Number(mailbox.blockNumber)

const A = clients(0)
const B = clients(1)
console.log('A:', A.address)
console.log('B:', B.address)
console.log('mailbox:', MAILBOX, '@block', DEPLOY_BLOCK)

const abis = JSON.parse(readFileSync(new URL('../../contracts/out/Mailbox.json', import.meta.url).pathname, 'utf8')).abi
const MESSAGE_SENT = {
  type: 'event',
  name: 'MessageSent',
  inputs: [
    { type: 'uint256', indexed: true, name: 'id' },
    { type: 'address', indexed: true, name: 'from' },
    { type: 'address', indexed: true, name: 'to' },
    { type: 'string', indexed: false, name: 'content' },
    { type: 'uint64', indexed: false, name: 'sentAt' },
  ],
}

let passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

// the frontend boxCrypto signing callback (viem HDAccount RFC6979 — deterministic; the 0x hex signature → bytes)
const signWith = (c) => async (message) => {
  const sig = await c.account.signMessage({ message })
  const clean = sig.slice(2)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ---- 1. offline checks: keypair determinism + box round trip + tamper rejection ----
{
  const kpA1 = await localBoxKeypair(signWith(A), A.address)
  const kpA2 = await localBoxKeypair(signWith(A), A.address)
  ok(Buffer.from(kpA1.publicKey).equals(Buffer.from(kpA2.publicKey)), 'local keypair determinism (RFC6979 signature → sha256 → x25519)')
  const kpB = await localBoxKeypair(signWith(B), B.address)
  ok(!Buffer.from(kpA1.publicKey).equals(Buffer.from(kpB.publicKey)), 'different accounts derive different keypairs')
  const msg = new TextEncoder().encode('PermaDrive mailbox selftest secret \u{1F512}')
  const envelope = boxEncrypt(kpB.publicKey, msg)
  ok(
    Buffer.from(boxDecryptWithSecretKey(envelope, kpB.secretKey)).equals(Buffer.from(msg)),
    'box round trip: A→B encrypt/decrypt matches (MetaMask-compatible envelope)',
  )
  const tampered = JSON.parse(serializeEnvelope(envelope))
  tampered.ciphertext = tampered.ciphertext.slice(0, -4) + (tampered.ciphertext.endsWith('AAA=') ? 'BBB=' : 'AAA=')
  let rejected = false
  try {
    boxDecryptWithSecretKey(parseEnvelope(tampered), kpB.secretKey)
  } catch {
    rejected = true
  }
  ok(rejected, 'tampered box ciphertext: decryption rejects')
}

// ---- 2. funding: top up B from A when broke (internal transfer; B is the browser e2e counterparty) ----
const FUND = 5n * 10n ** 16n // 0.05 AI3
const balB = await B.publicClient.getBalance({ address: B.address })
console.log('balance B:', ai3(balB))
if (balB < 10n ** 15n) {
  const hash = await A.walletClient.sendTransaction({ to: B.address, value: FUND, chain: autoEvm })
  const receipt = await A.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  ok(receipt.status === 'success', `funded A→B 0.05 AI3 (tx ${hash.slice(0, 18)}…)`)
} else {
  console.log('· B has gas, skipping the transfer')
}

// ---- 3. announce (idempotent: a matching key costs zero transactions) ----
async function announce(c, label) {
  const kp = await localBoxKeypair(signWith(c), c.address)
  const key = Buffer.from(kp.publicKey).toString('base64')
  const onchain = await c.publicClient.readContract({ address: MAILBOX, abi: abis, functionName: 'keys', args: [c.address] })
  if (onchain === key) {
    console.log(`· ${label}'s encryption pubkey already registered, skipping`)
    return
  }
  const hash = await c.walletClient.writeContract({ address: MAILBOX, abi: abis, functionName: 'announceEncryptionKey', args: [key], chain: autoEvm })
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  ok(receipt.status === 'success', `${label} announceEncryptionKey（tx ${hash.slice(0, 18)}…）`)
}
await announce(A, 'A')
await announce(B, 'B')
{
  const onchainA = await A.publicClient.readContract({ address: MAILBOX, abi: abis, functionName: 'keys', args: [A.address] })
  const kpA = await localBoxKeypair(signWith(A), A.address)
  ok(onchainA === Buffer.from(kpA.publicKey).toString('base64'), 'keys(A) readback = locally derived pubkey (the announced value pairs with the decryption key)')
}

// ---- 4. send + getLogs readback (proves the pipeline; the browser e2e covers the UI separately) ----
export async function sendFromB(text) {
  const kpA = await localBoxKeypair(signWith(A), A.address)
  const kpB = await localBoxKeypair(signWith(B), B.address)
  const envelope = boxEncrypt(kpA.publicKey, new TextEncoder().encode(text))
  const hash = await B.walletClient.writeContract({
    address: MAILBOX,
    abi: abis,
    functionName: 'send',
    args: [A.address, serializeEnvelope(envelope)],
    chain: autoEvm,
  })
  const receipt = await B.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error('send tx failed')
  console.log(`✓ B→A send（tx ${hash.slice(0, 18)}…）: ${text}`)
  return hash
}

export async function readInbox(who, limit = 5) {
  const c = who === 'A' ? A : B
  const kp = await localBoxKeypair(signWith(c), c.address)
  const meLower = c.address.toLowerCase()
  const logs = await c.publicClient.getLogs({
    address: MAILBOX,
    events: [MESSAGE_SENT],
    fromBlock: BigInt(DEPLOY_BLOCK),
    toBlock: 'latest',
    strict: true,
  })
  const mine = logs.filter((l) => l.args.to?.toLowerCase() === meLower).slice(-limit)
  console.log(`${who}'s inbox (last ${mine.length}):`)
  for (const l of mine) {
    let plain
    try {
      plain = new TextDecoder().decode(boxDecryptWithSecretKey(parseEnvelope(l.args.content), kp.secretKey))
    } catch {
      plain = '(decryption failed)'
    }
    console.log(`  #${l.args.id} from ${l.args.from} @${new Date(Number(l.args.sentAt) * 1000).toLocaleString()}: ${plain}`)
  }
  return mine.map((l) => {
    try {
      return new TextDecoder().decode(boxDecryptWithSecretKey(parseEnvelope(l.args.content), kp.secretKey))
    } catch {
      return '(decryption failed)'
    }
  })
}

async function selftest() {
  const text = `PermaDrive mailbox selftest ${Date.now()}`
  await sendFromB(text)
  const inboxA = await readInbox('A')
  ok(inboxA.includes(text), 'getLogs readback: A's inbox decrypts B's original text (E2E — the chain only ever sees ciphertext)')
  console.log(`\nAll ${passed} assertions passed (real mainnet transactions included; re-runs create new messages by design)`)
}

// ---- CLI entry ----
const argv = process.argv.slice(2)
if (argv[0] === 'send') {
  await sendFromB(argv.slice(1).join(' ') || `ping from B ${Date.now()}`)
} else if (argv[0] === 'read') {
  await readInbox(argv[1] ?? 'B', 10)
} else {
  await selftest()
}
