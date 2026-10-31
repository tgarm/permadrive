// DirectSales offline adversarial tests — local ganache EVM (npm devDependency),
// zero mainnet funds, evm_increaseTime time travel built in. Alternative:
// point LOCAL_EVM_RPC at an already-running anvil.
//   node direct-sales-test.mjs            # starts/stops an in-process ganache node
//   LOCAL_EVM_RPC=http://127.0.0.1:8545 node direct-sales-test.mjs   # reuse a running node
//
// Accounts: A=owner/treasury, B=seller, C=buyer, D=attacker/second buyer,
// P=delivery service (simulated locally).
// Scenarios:
//   t01 normal direct purchase (Seller mode): exact three-way split, order
//       snapshot, zero funds retained by the contract
//   t02 revision model: reprice = new revision; stale expectedRevision rejected;
//       old orders unaffected
//   t03 exact payment: overpay/underpay both rejected (no overpay-refund path)
//   t04 platform-fee slippage: maxPlatformBps protection
//   t05 namespace isolation: D cannot touch/overwrite B's listings and orders
//   t06 global listing log (append-only): first listing appends;
//       delist/relist does not append twice
//   t07 delist / delist of an unlisted key / relist
//   t08 provider mode (EIP-712 provider attestation, local service P):
//       signature verifies, three-way split, P may markKeySent; the buyer may not
//   t09 attestation adversarial: wrong signer / wrong chain / wrong contract /
//       expired / bps over cap / bad length / replay
//   t10 revoke: blocks new purchases; delivery authority for existing orders
//       preserved (both the revoke and the expiry paths)
//   t11 rejecting recipient reverts everything: treasury / providerPayout
//       rejecting → whole purchase reverts, zero residue
//   t12 reentrancy: seller contract reenters purchase on receive → lock rejects,
//       outer frame rolls back with zero residue
//   t13 ratings: actual buyers only, self-purchase forbidden, vote change
//       subtracts before adding (no stacking), same vote idempotent, product
//       totals vs service dimension (per order snapshot provider) split,
//       distinct buyer count
//   t14 rounding: floor remainder goes to the seller, Σ splits == price
//   t15 historical orders/quotes unaffected by later changes (owner rate change
//       only affects new revisions)
//   t16 global invariant: contract balance always 0 (direct sales has no escrow,
//       no credits)
//   t17 zero price / boundaries: BadPrice, nonexistent order NotPurchased,
//       duplicate markKeySent BadState
//   t18 identical address combos: seller==treasury merges to full price,
//       providerPayout==seller
//
// Balance assertions: treasury(A) ≠ every operating signer, so native balance
// deltas are asserted exactly; each signer's own gas is deducted via gasOf(rx).
// Order ids are always read from on-chain orderCount, never computed by hand.

import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/DirectSales.json', import.meta.url).pathname, 'utf8'))
// ReentrantSeller attack contract (bytecode embedded; test-only, compiled out of
// band, deliberately not part of contracts/): reenters purchase when receiving
// the seller payout, expecting the noReentry lock to reject it and the outer
// frame to roll back entirely.
const REENTRANT = {
  abi: [
    { inputs: [{ internalType: 'address', name: 'sales_', type: 'address' }], stateMutability: 'nonpayable', type: 'constructor' },
    { inputs: [{ internalType: 'bytes32', name: 'lid', type: 'bytes32' }, { internalType: 'uint256', name: 'rid', type: 'uint256' }], name: 'buyReentrant', outputs: [], stateMutability: 'payable', type: 'function' },
    { inputs: [{ internalType: 'bytes32', name: 'fileKey_', type: 'bytes32' }, { internalType: 'uint96', name: 'price_', type: 'uint96' }], name: 'list', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  ],
  bytecode: '0x60a06040526001805460ff60601b19166c0100000000000000000000000017905534801561002c57600080fd5b5060405161062738038061062783398101604081905261004b9161005c565b6001600160a01b031660805261008c565b60006020828403121561006e57600080fd5b81516001600160a01b038116811461008557600080fd5b9392505050565b6080516105666100c16000396000818160c10152818160f3015281816102a201528181610395015261044f01526105666000f3fe6080604052600436106100595760003560e01c80630325884d14610202578063922469eb14610222578063a0fe97e31461025f578063aace52fe14610290578063ab159381146102dc578063d74ae351146102ef57600080fd5b366101fd57600154600160601b900460ff16156101fb576001805460ff60601b19169055600080546040516bffffffffffffffffffffffff193060601b16602082015260348101919091526054016040516020818303038152906040528051906020012090507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03166396405db76000837f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031663d4a93c26866040518263ffffffff1660e01b815260040161013f91815260200190565b602060405180830381865afa15801561015c573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061018091906104b9565b60015460405160e086901b6001600160e01b0319168152600481019390935260248301919091526001600160601b031660448201526107d060648201526000608482015260a4016000604051808303818588803b1580156101e057600080fd5b505af11580156101f4573d6000803e3d6000fd5b5050505050505b005b600080fd5b34801561020e57600080fd5b506101fb61021d3660046104d2565b610313565b34801561022e57600080fd5b50600154610242906001600160601b031681565b6040516001600160601b0390911681526020015b60405180910390f35b34801561026b57600080fd5b5060015461028090600160601b900460ff1681565b6040519015158152602001610256565b34801561029c57600080fd5b506102c47f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b039091168152602001610256565b6101fb6102ea36600461050e565b6103fe565b3480156102fb57600080fd5b5061030560005481565b604051908152602001610256565b6000828155600180546bffffffffffffffffffffffff19166001600160601b03841690811790915560405163b18ea78760e01b815260048101859052602481019190915260448101829052606481018290526084810182905260a4810182905260c4810182905260e481018290526101206101048201526101248101919091527f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03169063b18ea7879061014401600060405180830381600087803b1580156103e257600080fd5b505af11580156103f6573d6000803e3d6000fd5b505050505050565b60018054600160601b60ff60601b198216179091556040516396405db760e01b815260048101849052602481018390526001600160601b0390911660448201526107d06064820152600060848201527f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316906396405db790349060a4016000604051808303818588803b15801561049c57600080fd5b505af11580156104b0573d6000803e3d6000fd5b50505050505050565b6000602082840312156104cb57600080fd5b5051919050565b600080604083850312156104e557600080fd5b8235915060208301356001600160601b038116811461050357600080fd5b809150509250929050565b6000806040838503121561052157600080fd5b5050803592602090910135915056fea26469706673582212203ce4e280b403743b697e978df5b865c624e304feed859facd6bf47160298e9b764736f6c63430008260033'
}
// "test test …" mnemonic — prefunded identically by ganache and anvil defaults;
// five accounts derived deterministically
const MNEMONIC = 'test test test test test test test test test test test junk'

// ---- local EVM lifecycle (in-process ganache by default; LOCAL_EVM_RPC attaches an external node) ----

const EXTERNAL_RPC = process.env.LOCAL_EVM_RPC || process.env.ANVIL_RPC || null
let server = null
let rpcUrl = EXTERNAL_RPC
if (!rpcUrl) {
  const ganache = (await import('ganache')).default
  // even a random port can collide (EADDRINUSE) — retry on a fresh port
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
// ganache's close() is known to throw on the exit path — swallow it; process
// teardown reclaims everything anyway
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
  0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365an, // #3
  0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656en, // #4
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
const A = clientFor(0) // owner / treasury
const B = clientFor(1) // seller
const C = clientFor(2) // buyer
const D = clientFor(3) // attacker / second buyer
const P = clientFor(4) // delivery service (simulated locally)
console.log('local evm:', rpcUrl)
console.log('A (owner/treasury):', A.address)
console.log('B (seller)        :', B.address)
console.log('C (buyer)         :', C.address)
console.log('D (attacker)      :', D.address)
console.log('P (provider)      :', P.address)

// ---- deployment (DirectSales(treasury=A)) ----

const hash = await A.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [A.address], chain: localChain })
const deployRx = await A.publicClient.waitForTransactionReceipt({ hash })
if (deployRx.status !== 'success') throw new Error('deploy failed')
const PC = artifact.abi
const ADDR = deployRx.contractAddress
console.log('DirectSales:', ADDR, `· block ${deployRx.blockNumber} · gas ${deployRx.gasUsed}`)

const read = (fn, args = []) => A.publicClient.readContract({ address: ADDR, abi: PC, functionName: fn, args })
async function write(c, fn, args = [], value = 0n) {
  const h = await c.walletClient.writeContract({ address: ADDR, abi: PC, functionName: fn, args, chain: localChain, ...(value ? { value } : {}) })
  const rx = await c.publicClient.waitForTransactionReceipt({ hash: h })
  if (rx.status !== 'success') throw new Error(`${fn} tx ${rx.status}`)
  return rx
}
const gasOf = (rx) => rx.gasUsed * (rx.effectiveGasPrice ?? 0n)
const bal = (c) => c.publicClient.getBalance({ address: c.address })
const key = (tag) => keccak256(toHex(`direct-sales-test-${tag}`))
// keccak256(abi.encodePacked(seller, fileKey)) — 20B address + 32B hash concatenated (same derivation as the contract)
const lidOf = (seller, fk) => keccak256(`0x${seller.slice(2).toLowerCase()}${fk.slice(2).toLowerCase().padStart(64, '0')}`)
const ZERO = '0x0000000000000000000000000000000000000000'
const errText = (e) => {
  const parts = []
  let cur = e
  for (let d = 0; cur && d < 8; d++) {
    parts.push(String(cur.shortMessage || cur.message || cur))
    if (cur.details) parts.push(String(cur.details))
    if (cur.data?.result) parts.push(String(cur.data.result))
    cur = cur.cause
  }
  return parts.join(' | ')
}
// ganache reverts only return the 4-byte selector (no error name) — build a
// selector→name map and match on either channel (error name or selector hex)
const errSel = {}
for (const item of PC) {
  if (item.type === 'error') {
    const sig = `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(',')})`
    errSel[keccak256(toHex(sig)).slice(2, 10)] = item.name
  }
}
async function expectRevert(fn, reason) {
  try {
    await fn()
  } catch (e) {
    const s = errText(e)
    const sel = Object.keys(errSel).find((k) => errSel[k] === reason)
    if (s.includes(reason) || (sel && s.includes(sel))) return
    throw new Error(`expected revert(${reason}) but got: ${s.slice(0, 240)}`)
  }
  throw new Error(`expected revert(${reason}) but the transaction succeeded`)
}
const travel = async (seconds) => {
  await A.publicClient.request({ method: 'evm_increaseTime', params: [Number(seconds)] })
  await A.publicClient.request({ method: 'evm_mine' })
}
const eventsOf = (rx) => rx.logs.map((l) => { try { return decodeEventLog({ abi: PC, data: l.data, topics: l.topics }) } catch { return null } }).filter(Boolean)

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

const PRICE = 10n ** 16n // 0.01 ETH (local)
const BPS0 = 1000 // default platformBps (uint16 → viem decodes to number)

// order(id) convenience read (explicit named orderOf read — public struct getters return unnamed tuples)
async function order(id) {
  const [revision, price, platformBps, providerBps, state, purchasedAt, buyer, seller, provider, providerPayout, fileKey] = await read('orderOf', [id])
  return { revision, price, platformBps, providerBps, state, purchasedAt, buyer, seller, provider, providerPayout, fileKey }
}
async function rating(lid) {
  const [up, down, buyers] = await read('ratingOf', [lid])
  return { up, down, buyers }
}
// EIP-712 provider attestation (signed by the local service P; domain = PermaDrive DirectSales v1 @ ADDR)
const ATTEST_TYPES = {
  ProviderAttestation: [
    { name: 'seller', type: 'address' },
    { name: 'fileKey', type: 'bytes32' },
    { name: 'revision', type: 'uint256' },
    { name: 'price', type: 'uint96' },
    { name: 'providerPayout', type: 'address' },
    { name: 'providerBps', type: 'uint16' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
}
async function signAttestation(signerClient, msg, domain = { name: 'PermaDrive DirectSales', version: '1', chainId: 1337, verifyingContract: ADDR }) {
  return signerClient.walletClient.signTypedData({ account: signerClient.account, domain, types: ATTEST_TYPES, primaryType: 'ProviderAttestation', message: msg })
}
const now = async () => Number((await A.publicClient.getBlock()).timestamp)

// ---- t01 normal direct purchase (Seller mode): exact three-way split, order snapshot, zero retained funds ----
const FK1 = key('t01')
const LID1 = lidOf(B.address, FK1)
await write(B, 'createRevision', [FK1, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t01-terms')), 0, '0x'])
ok((await read('currentRevision', [LID1])) === 1n, 't01 list readback (currentRevision=1, seller namespace)')
ok((await read('listingCount')) === 1n && (await read('listingLog', [0n])) === LID1, 't01 listingLog[0] = LID1 (appended on first listing)')
{
  const [a0, b0, c0] = [await bal(A), await bal(B), await bal(C)]
  const rx = await write(C, 'purchase', [LID1, 1n, PRICE, 2000, 5000], PRICE)
  const [a1, b1, c1] = [await bal(A), await bal(B), await bal(C)]
  const fee = (PRICE * BigInt(BPS0)) / 10000n
  ok(a1 - a0 === fee, `t01 treasury receives exactly the platform fee ${fee}`)
  ok(b1 - b0 === PRICE - fee, 't01 seller receives exactly the net (price - platform fee)')
  ok(c0 - c1 === PRICE + gasOf(rx), 't01 buyer net spend = price + gas (no escrow, no refund pool)')
  const oid = await read('orderCount')
  const o = await order(oid)
  ok(o.state === 0 && o.price === PRICE && o.buyer === C.address && o.seller === B.address && o.provider === ZERO && o.platformBps === BPS0 && o.revision === 1n, 't01 order readback: full snapshot (Paid)')
  const r = await rating(LID1)
  ok(r.up === 0n && r.down === 0n && r.buyers === 1n, 't01 ratingOf: unrated shows 0/0/0 (no synthetic default praise), distinct buyers 1')
}
ok((await A.publicClient.getBalance({ address: ADDR })) === 0n, 't01 contract balance 0 (pay-and-split, no retained funds)')

// ---- t02 revision model ----
{
  await write(B, 'createRevision', [FK1, PRICE * 2n, ZERO, ZERO, 0, 0, keccak256(toHex('t02-terms')), 0, '0x'])
  ok((await read('currentRevision', [LID1])) === 2n, 't02 reprice = new revision (currentRevision=2)')
  ok((await read('listingCount')) === 1n, 't02 a new revision on the same listing does not append to listingLog again')
  await expectRevert(() => write(C, 'purchase', [LID1, 1n, PRICE * 2n, 2000, 5000], PRICE * 2n), 'NotCurrentRevision')
  ok(true, 't02 expectedRevision=old revision → NotCurrentRevision (a swap between viewing and signing is rejected)')
  await expectRevert(() => write(C, 'purchase', [LID1, 2n, PRICE, 2000, 5000], PRICE * 2n), 'PriceTooHigh')
  ok(true, 't02 maxPrice=old price → PriceTooHigh')
  await write(C, 'purchase', [LID1, 2n, PRICE * 2n, 2000, 5000], PRICE * 2n)
  const oid = await read('orderCount')
  const o = await order(oid)
  ok(o.revision === 2n && o.price === PRICE * 2n && o.platformBps === BPS0, 't02 purchase on the new revision (snapshot = revision 2)')
}

// ---- t03 exact payment: overpay/underpay both rejected ----
{
  await expectRevert(() => write(C, 'purchase', [LID1, 2n, PRICE * 2n, 2000, 5000], PRICE * 2n + 1n), 'ExactPaymentRequired')
  ok(true, 't03 overpaying 1 wei → ExactPaymentRequired (no overpay-refund path)')
  await expectRevert(() => write(C, 'purchase', [LID1, 2n, PRICE * 2n, 2000, 5000], PRICE * 2n - 1n), 'ExactPaymentRequired')
  ok(true, 't03 underpaying 1 wei → ExactPaymentRequired')
}

// ---- t04 platform-fee slippage ----
{
  await expectRevert(() => write(C, 'purchase', [LID1, 2n, PRICE * 2n, 999, 5000], PRICE * 2n), 'BpsTooHighPlatform')
  ok(true, 't04 maxPlatformBps=999 < 1000 → BpsTooHighPlatform')
  await write(C, 'purchase', [LID1, 2n, PRICE * 2n, 1000, 5000], PRICE * 2n)
  ok(true, 't04 maxPlatformBps=1000 → purchase succeeds')
}

// ---- t05 namespace isolation ----
{
  const FKD = key('t05-d')
  const FKB = key('t05-b')
  const LIDD = lidOf(D.address, FKD)
  const LIDB = lidOf(B.address, FKB)
  await write(D, 'createRevision', [FKD, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t05-d')), 0, '0x'])
  await write(B, 'createRevision', [FKB, PRICE * 3n, ZERO, ZERO, 0, 0, keccak256(toHex('t05-b')), 0, '0x'])
  ok((await read('currentRevision', [LIDD])) === 1n && (await read('currentRevision', [LIDB])) === 1n, 't05 two sellers coexist on the same fileKey (separate namespaces)')
  await write(C, 'purchase', [LIDB, 1n, PRICE * 3n, 2000, 5000], PRICE * 3n)
  const oid = await read('orderCount')
  const o = await order(oid)
  ok(o.seller === B.address && o.buyer === C.address, 't05 buyer purchases explicitly from B')
  await expectRevert(() => write(D, 'markKeySent', [oid]), 'NotOrderSellerOrProvider')
  ok(true, 't05 D markKeySent(B order) rejected (order snapshot seller/provider)')
  // D delisting their own listing does not affect B (delist works on msg.sender's namespace)
  await write(D, 'delist', [FKD])
  ok((await read('currentRevision', [LIDB])) === 1n, 't05 D delist(FKD) clears only their own pointer; B listing unaffected')
}

// ---- t06 global listing log (append-only) ----
{
  // listings so far: t01 B-FK1 (1) + t05 D-FKD (2) + t05 B-FKB (3)
  ok((await read('listingCount')) === 3n, 't06 listingCount=3 (B new revision on the same fileKey not double-counted)')
  ok((await read('listingLog', [2n])) === lidOf(B.address, key('t05-b')), 't06 listingLog[2] = t05-b listing (appended on first listing)')
  // delist → relist must not append again
  await write(B, 'delist', [FK1])
  await write(B, 'createRevision', [FK1, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t06-relist')), 0, '0x'])
  ok((await read('listingCount')) === 3n, 't06 after delist/relist listingCount still 3 (append-only idempotence)')
}

// ---- t07 delist / relist ----
{
  await expectRevert(() => write(B, 'delist', [key('t07-never-listed')]), 'NotListed')
  ok(true, 't07 delist of an unlisted key → NotListed')
  await write(B, 'delist', [FK1]) // relisted in t06 (rid=3); delist again here
  ok((await read('currentRevision', [LID1])) === 0n, 't07 after delist currentRevision=0')
  await expectRevert(() => write(C, 'purchase', [LID1, 3n, PRICE, 2000, 5000], PRICE), 'NotListed')
  ok(true, 't07 new purchases rejected after delist')
  await write(B, 'createRevision', [FK1, PRICE * 2n, ZERO, ZERO, 0, 0, keccak256(toHex('t07-relist')), 0, '0x'])
  await write(C, 'purchase', [LID1, 4n, PRICE * 2n, 2000, 5000], PRICE * 2n)
  ok(true, 't07 purchasable again after relist (revision 4)')
}

// ---- t08 provider mode (EIP-712 provider attestation, local service P) ----
const FK8 = key('t08')
const LID8 = lidOf(B.address, FK8)
const TERMS8 = keccak256(toHex('t08-service-terms'))
const attestExpiry = BigInt((await now()) + 3600)
const ATTEST8 = await signAttestation(P, {
  seller: B.address, fileKey: FK8, revision: 1n, price: PRICE,
  providerPayout: P.address, providerBps: 2000, termsHash: TERMS8, expiry: attestExpiry,
})
await write(B, 'createRevision', [FK8, PRICE, P.address, P.address, 2000, 1, TERMS8, attestExpiry, ATTEST8])
ok((await read('currentRevision', [LID8])) === 1n, 't08 provider-mode listing (EIP-712 attestation verifies, cross-checked against the contract DOMAIN_SEPARATOR)')
{
  const [a0, b0, p0, c0] = [await bal(A), await bal(B), await bal(P), await bal(C)]
  const rx = await write(C, 'purchase', [LID8, 1n, PRICE, 2000, 5000], PRICE)
  const [a1, b1, p1, c1] = [await bal(A), await bal(B), await bal(P), await bal(C)]
  const fee = PRICE / 10n // platformBps 1000
  const pfee = (PRICE * 2000n) / 10000n
  ok(a1 - a0 === fee && p1 - p0 === pfee && b1 - b0 === PRICE - fee - pfee, 't08 exact three-way split: treasury/platformFee, provider/providerFee, seller/net')
  ok(c0 - c1 === PRICE + gasOf(rx), 't08 buyer net spend = price + gas')
  const oid = await read('orderCount')
  const o = await order(oid)
  ok(o.provider === P.address && o.providerPayout === P.address && o.providerBps === 2000, 't08 order snapshots the three provider params')
  await expectRevert(() => write(C, 'markKeySent', [oid]), 'NotOrderSellerOrProvider')
  ok(true, 't08 buyer markKeySent rejected')
  await write(P, 'markKeySent', [oid])
  ok((await order(oid)).state === 1, 't08 provider markKeySent → KeySent')
  // leave one Paid order for t10 existing-order authorization checks
  await write(C, 'purchase', [LID8, 1n, PRICE, 2000, 5000], PRICE)
}

// ---- t09 attestation adversarial ----
{
  const FK9 = key('t09')
  const expiry = BigInt((await now()) + 3600)
  const msg9 = { seller: B.address, fileKey: FK9, revision: 1n, price: PRICE, providerPayout: P.address, providerBps: 1000, termsHash: TERMS8, expiry }
  const forged = await signAttestation(D, msg9) // D forges (the seller cannot accept an order on the service's behalf)
  await expectRevert(() => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, expiry, forged]), 'BadAttestation')
  ok(true, 't09 wrong signer (D forging) → BadAttestation')
  const wrongChain = await signAttestation(P, msg9, { name: 'PermaDrive DirectSales', version: '1', chainId: 1, verifyingContract: ADDR })
  await expectRevert(() => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, expiry, wrongChain]), 'BadAttestation')
  ok(true, 't09 wrong-chain signature (chainId=1) → BadAttestation (domain binding)')
  const wrongContract = await signAttestation(P, msg9, { name: 'PermaDrive DirectSales', version: '1', chainId: 1337, verifyingContract: '0x000000000000000000000000000000000000dead' })
  await expectRevert(() => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, expiry, wrongContract]), 'BadAttestation')
  ok(true, 't09 wrong-contract signature (verifyingContract) → BadAttestation')
  await expectRevert(async () => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, BigInt((await now()) - 10), ATTEST8]), 'AttestationExpired')
  ok(true, 't09 expired attestation (expiry < now) → AttestationExpired (rejected up front by createRevision)')
  const AT9 = await signAttestation(P, msg9)
  await expectRevert(() => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 5001, 1, TERMS8, expiry, AT9]), 'BpsTooHigh')
  ok(true, 't09 providerBps=5001 > MAX(5000) → BpsTooHigh (service-fee cap policy)')
  await expectRevert(() => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, expiry, AT9.slice(0, 130)]), 'BadAttestation')
  ok(true, 't09 attestation length 64B (missing v) → BadAttestation')
  // list with a correct signature (rid=1), then replay the same signature for rid=2 → revision binding rejects it (one signature, one use)
  await write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, expiry, AT9])
  ok((await read('currentRevision', [lidOf(B.address, FK9)])) === 1n, 't09 listing with a correct attestation succeeds')
  await expectRevert(() => write(B, 'createRevision', [FK9, PRICE, P.address, P.address, 1000, 1, TERMS8, expiry, AT9]), 'BadAttestation')
  ok(true, 't09 replaying the old-revision signature for a new revision → BadAttestation (revision binding)')
}

// ---- t10 revoke: blocks new purchases; existing-order delivery authority preserved (revoke and expiry paths) ----
{
  const paidOid = await read('orderCount') // the Paid order left over from t08
  ok((await order(paidOid)).state === 0, 't10 precondition: existing order is Paid')
  await expectRevert(() => write(D, 'revoke', [LID8]), 'NotProvider')
  ok(true, 't10 non-provider revoke → NotProvider')
  const rx = await write(P, 'revoke', [LID8])
  ok(eventsOf(rx).some((e) => e.eventName === 'ProviderRevocation'), 't10 provider revoke → ProviderRevocation event')
  const rx2 = await write(P, 'revoke', [LID8])
  ok(!eventsOf(rx2).some((e) => e.eventName === 'ProviderRevocation'), 't10 duplicate revoke is idempotent (no second event)')
  await expectRevert(() => write(C, 'purchase', [LID8, 1n, PRICE, 2000, 5000], PRICE), 'ProviderRevoked')
  ok(true, 't10 purchase after revoke → ProviderRevoked')
  await write(P, 'markKeySent', [paidOid])
  ok((await order(paidOid)).state === 1, 't10 after revoke the existing order keeps its delivery authority (provider can still register)')
  // expiry path: another provider listing — after expiry new purchases are rejected while existing delivery is preserved
  const FK10 = key('t10-expiry')
  const LID10 = lidOf(B.address, FK10)
  const exp10 = BigInt((await now()) + 60)
  const AT10 = await signAttestation(P, { seller: B.address, fileKey: FK10, revision: 1n, price: PRICE, providerPayout: P.address, providerBps: 500, termsHash: TERMS8, expiry: exp10 })
  await write(B, 'createRevision', [FK10, PRICE, P.address, P.address, 500, 1, TERMS8, exp10, AT10])
  await write(C, 'purchase', [LID10, 1n, PRICE, 2000, 5000], PRICE)
  const beforeExp = await read('orderCount')
  await travel(61)
  await expectRevert(() => write(C, 'purchase', [LID10, 1n, PRICE, 2000, 5000], PRICE), 'AttestationExpired')
  ok(true, 't10 purchase after expiry → AttestationExpired (expiry blocks new purchases)')
  await write(P, 'markKeySent', [beforeExp])
  ok((await order(beforeExp)).state === 1, 't10 the provider can still deliver pre-expiry orders (historical authority preserved)')
}

// ---- t11 rejecting recipient reverts everything ----
{
  // rejecting contract (runtime = PUSH1 0 DUP1 REVERT): initcode returns 600080fd
  const REVERTER_INIT = '0x63600080fd6000526004601cf3'
  const h = await A.walletClient.sendTransaction({ data: REVERTER_INIT, chain: localChain })
  const rx = await A.publicClient.waitForTransactionReceipt({ hash: h })
  const REVERTER = rx.contractAddress
  ok((await A.publicClient.getCode({ address: REVERTER })) === '0x600080fd', 't11 rejecting contract deployed (any call → REVERT)')
  // instance 2: treasury=rejecting contract → platform-fee transfer fails → whole purchase reverts, zero residue
  const h2 = await A.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [REVERTER], chain: localChain })
  const rx2 = await A.publicClient.waitForTransactionReceipt({ hash: h2 })
  const ADDR2 = rx2.contractAddress
  const read2 = (fn, args = []) => A.publicClient.readContract({ address: ADDR2, abi: PC, functionName: fn, args })
  const write2 = async (c, fn, args = [], value = 0n) => {
    const hh = await c.walletClient.writeContract({ address: ADDR2, abi: PC, functionName: fn, args, chain: localChain, ...(value ? { value } : {}) })
    return c.publicClient.waitForTransactionReceipt({ hash: hh })
  }
  const FK11 = key('t11')
  const LID11 = lidOf(B.address, FK11)
  await write2(B, 'createRevision', [FK11, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t11')), 0, '0x'])
  const [b0, c0] = [await bal(B), await bal(C)] // captured after the listing gas, before the purchase (B gas stays out of the assertions)
  const orderCount0 = await read2('orderCount')
  await expectRevert(() => write2(C, 'purchase', [LID11, 1n, PRICE, 2000, 5000], PRICE), 'TransferFailed')
  ok(true, 't11 treasury rejects → purchase reverts entirely (TransferFailed)')
  ok((await read2('orderCount')) === orderCount0, 't11 orderCount unchanged (no "payment succeeded but only partially split")')
  ok((await A.publicClient.getBalance({ address: ADDR2 })) === 0n, 't11 instance-2 contract balance 0')
  ok((await bal(B)) === b0 && (await bal(C)) === c0, 't11 seller/buyer untouched (revert happens during estimation: zero transfers, zero gas, zero residue)')
  // instance 1: provider mode with payout=rejecting contract → provider-fee transfer fails → whole purchase reverts
  const FK11P = key('t11-payout')
  const LID11P = lidOf(B.address, FK11P)
  const exp11 = BigInt((await now()) + 3600)
  const AT11 = await signAttestation(P, { seller: B.address, fileKey: FK11P, revision: 1n, price: PRICE, providerPayout: REVERTER, providerBps: 1000, termsHash: TERMS8, expiry: exp11 })
  await write(B, 'createRevision', [FK11P, PRICE, P.address, REVERTER, 1000, 1, TERMS8, exp11, AT11])
  const orderCount1 = await read('orderCount')
  const [b1, p1] = [await bal(B), await bal(P)]
  await expectRevert(() => write(C, 'purchase', [LID11P, 1n, PRICE, 2000, 5000], PRICE), 'TransferFailed')
  ok((await read('orderCount')) === orderCount1, 't11 providerPayout rejects → whole purchase reverts, zero residue')
  ok((await bal(B)) === b1 && (await bal(P)) === p1, 't11 seller/provider received nothing')
  ok((await A.publicClient.getBalance({ address: ADDR })) === 0n, 't11 instance-1 contract balance still 0')
}

// ---- t12 reentrancy: seller contract reenters purchase on receive → lock rejects, outer frame rolls back ----
{
  const hh = await A.walletClient.deployContract({ abi: REENTRANT.abi, bytecode: REENTRANT.bytecode, args: [ADDR], chain: localChain })
  const rrx = await A.publicClient.waitForTransactionReceipt({ hash: hh })
  const ATTK = rrx.contractAddress
  await A.walletClient.writeContract({ address: ATTK, abi: REENTRANT.abi, functionName: 'list', args: [key('t12'), PRICE], chain: localChain })
  const LID12 = lidOf(ATTK, key('t12'))
  const rid = await read('currentRevision', [LID12])
  const orderCount0 = await read('orderCount')
  // the inner reentry is rejected by the noReentry lock → receive reverts → outer seller transfer fails → TransferFailed
  await expectRevert(
    () => C.walletClient.writeContract({ address: ATTK, abi: REENTRANT.abi, functionName: 'buyReentrant', args: [LID12, rid], chain: localChain, value: PRICE })
      .then((h) => C.publicClient.waitForTransactionReceipt({ hash: h })),
    'TransferFailed',
  )
  ok(true, 't12 reentrant purchase rejected by the noReentry lock (outer seller transfer fails → full rollback)')
  ok((await read('orderCount')) === orderCount0, 't12 orderCount unchanged')
  ok((await A.publicClient.getBalance({ address: ADDR })) === 0n, 't12 contract balance 0 (reentrancy cannot extract funds)')
}

// ---- t13 ratings: actual buyers only, self-purchase forbidden, subtract-then-add vote change, same-vote idempotence, dimension split ----
{
  // C rates order 1 (t01, seller mode provider=0) positively
  await write(C, 'rate', [1n, true])
  ok((await rating(LID1)).up === 1n && (await rating(LID1)).down === 0n, 't13 C positive rating → product totals up=1')
  ok((await read('serviceUp', [LID1, ZERO])) === 1n, 't13 service dimension (provider=0) up=1')
  await write(C, 'rate', [1n, true])
  ok((await rating(LID1)).up === 1n, 't13 resubmitting the same vote is idempotent (no stacking)')
  await expectRevert(() => write(D, 'rate', [1n, true]), 'NotBuyer')
  ok(true, 't13 non-buyer rate → NotBuyer')
  await write(C, 'rate', [1n, false]) // change to negative (order 2 shares the lid — the changed vote still counts once)
  const r = await rating(LID1)
  ok(r.up === 0n && r.down === 1n, 't13 change to negative → up -1, down +1 (subtract first, then add; no stacking)')
  // self-purchase forbidden: B buys their own listing
  const FKS = key('t13-self')
  const LIDS = lidOf(B.address, FKS)
  await write(B, 'createRevision', [FKS, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t13-self')), 0, '0x'])
  await write(B, 'purchase', [LIDS, 1n, PRICE, 2000, 5000], PRICE)
  const selfOid = await read('orderCount')
  ok((await rating(LIDS)).buyers === 0n, 't13 seller self-purchase does not count toward distinct buyers')
  await expectRevert(() => write(B, 'rate', [selfOid, true]), 'SelfRating')
  ok(true, 't13 self-purchase rate → SelfRating')
  // provider dimension split: C rates the t08 order (provider=P; still ratable after KeySent — ratings have no delivery precondition)
  const t08Oid = await read('orderCount') - 2n // the second t08 order
  await write(C, 'rate', [t08Oid, true])
  ok((await read('serviceUp', [LID8, P.address])) === 1n && (await rating(LID8)).up === 1n, 't13 P service dimension up=1 (product totals also up=1)')
  ok((await read('serviceUp', [LID1, ZERO])) === 0n, 't13 the seller-mode counter is unaffected by the P dimension (split)')
  await write(C, 'rate', [t08Oid, false])
  ok((await read('serviceDown', [LID8, P.address])) === 1n && (await read('serviceUp', [LID8, P.address])) === 0n, 't13 change to negative: service dimension subtracts first, then adds')
  // distinct buyers: fresh D listing, C purchases (buyers=1); D self-purchase not counted; C rates negatively before delivery
  const FKD2 = key('t13-d')
  const LIDD = lidOf(D.address, FKD2)
  await write(D, 'createRevision', [FKD2, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t13-d')), 0, '0x'])
  await write(C, 'purchase', [LIDD, 1n, PRICE, 2000, 5000], PRICE)
  ok((await rating(LIDD)).buyers === 1n, 't13 after C purchases buyers=1')
  await write(D, 'purchase', [LIDD, 1n, PRICE, 2000, 5000], PRICE) // D self-purchase
  ok((await rating(LIDD)).buyers === 1n, 't13 D self-purchase not counted (still 1)')
  const cOrder = await findBuyerOrder(LIDD, C.address)
  await write(C, 'rate', [cOrder, false])
  ok((await rating(LIDD)).down === 1n && (await rating(LIDD)).up === 0n, 't13 C rates LIDD negatively (undelivered buyer may rate negatively, down=1)')
}
// find a buyer's order id on a listing (the order backing the vote; test helper, scans down from orderCount)
async function findBuyerOrder(lid, buyer) {
  const count = await read('orderCount')
  for (let i = count; i >= 1n; i--) {
    const o = await order(i)
    if (o.buyer === buyer && lidOf(o.seller, o.fileKey) === lid) return i
  }
  throw new Error(`findBuyerOrder: no order found for ${buyer} on ${lid}`)
}

// ---- t14 rounding: floor remainder goes to the seller, Σ splits == price ----
{
  const FK14 = key('t14')
  const LID14 = lidOf(B.address, FK14)
  await write(B, 'createRevision', [FK14, 999n, ZERO, ZERO, 0, 0, keccak256(toHex('t14')), 0, '0x'])
  const [a0, b0] = [await bal(A), await bal(B)]
  await write(C, 'purchase', [LID14, 1n, 999n, 2000, 5000], 999n)
  const [a1, b1] = [await bal(A), await bal(B)]
  ok(a1 - a0 === 99n, 't14 platform fee floor(999×1000/10000)=99 (remainder not the platform\'s)')
  ok(b1 - b0 === 900n, 't14 seller net 900 (remainder goes to the seller)')
  ok(a1 - a0 + (b1 - b0) === 999n, 't14 Σ splits == price (no dust retained)')
}

// ---- t15 historical orders/quotes unaffected by later changes ----
{
  await write(A, 'setPlatformBps', [0])
  ok((await read('platformBps')) === 0, 't15 owner setPlatformBps(0)')
  const FK15 = key('t15')
  const LID15 = lidOf(B.address, FK15)
  await write(B, 'createRevision', [FK15, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t15')), 0, '0x'])
  const rev15 = await read('revisionOf', [LID15, 1n])
  ok(rev15[2] === 0, 't15 the new revision snapshots platformBps=0 (rate changes only affect new quotes)')
  const rev1 = await read('revisionOf', [LID1, 1n])
  ok(rev1[2] === BPS0, 't15 the old revision snapshot still has platformBps 1000 (quotes are stable)')
  const o2 = await order(2n)
  ok(o2.platformBps === BPS0, 't15 completed orders keep their fee snapshot')
  await write(B, 'markKeySent', [2n])
  ok((await order(2n)).state === 1, 't15 historical order markKeySent works as usual')
  await write(A, 'setPlatformBps', [BPS0]) // restore the default
}

// ---- t16 global invariant: contract balance always 0 ----
{
  ok((await A.publicClient.getBalance({ address: ADDR })) === 0n, 't16 instance-1 contract balance 0 (direct sales: no escrow, no credits)')
}

// ---- t17 zero price / boundaries ----
{
  // price=0 listings rejected (delisting goes through delist, never a 0 price)
  await expectRevert(async () => write(B, 'createRevision', [key('t17-zero'), 0n, ZERO, ZERO, 0, 0, keccak256(toHex('t17')), 0, '0x']), 'BadPrice')
  ok(true, 't17 price=0 listing → BadPrice (delisting is exclusively the delist semantics)')
  // nonexistent order: KeySent/rate both rejected (enum default must not impersonate a real order)
  await expectRevert(() => write(B, 'markKeySent', [999999n]), 'NotPurchased')
  ok(true, 't17 markKeySent on a nonexistent order → NotPurchased (enum default Paid does not impersonate a purchase)')
  await expectRevert(() => write(C, 'rate', [999999n, true]), 'NotPurchased')
  ok(true, 't17 rate on a nonexistent order → NotPurchased')
  // duplicate markKeySent: registering after KeySent → BadState
  await write(B, 'createRevision', [key('t17-ks'), PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t17-ks')), 0, '0x'])
  const LID17 = lidOf(B.address, key('t17-ks'))
  await write(C, 'purchase', [LID17, 1n, PRICE, 2000, 5000], PRICE)
  const oid17 = await read('orderCount')
  await write(B, 'markKeySent', [oid17])
  await expectRevert(() => write(B, 'markKeySent', [oid17]), 'BadState')
  ok(true, 't17 duplicate markKeySent → BadState (state machine is irreversible)')
}

// ---- t18 identical address combos: seller == treasury / providerPayout == seller ----
{
  // A is the treasury and lists their own sale: after C purchases, A receives platform fee + seller net = full price
  const FK18 = key('t18-self-treasury')
  const LID18 = lidOf(A.address, FK18)
  await write(A, 'createRevision', [FK18, PRICE, ZERO, ZERO, 0, 0, keccak256(toHex('t18')), 0, '0x'])
  const [a0, c0] = [await bal(A), await bal(C)]
  const rx = await write(C, 'purchase', [LID18, 1n, PRICE, 2000, 5000], PRICE)
  const [a1, c1] = [await bal(A), await bal(C)]
  ok(a1 - a0 === PRICE, 't18 seller==treasury: A receives exactly the full price (fee+net merged at one address; A is not the tx sender so no gas, exact equals price)')
  ok(c0 - c1 === PRICE + gasOf(rx), 't18 buyer net spend unchanged (= price + gas)')
  // providerPayout == seller combo: provider mode with payout pointing at the seller themselves
  const FK18P = key('t18-payout-seller')
  const LID18P = lidOf(B.address, FK18P)
  const exp18 = BigInt((await now()) + 3600)
  const AT18 = await signAttestation(P, { seller: B.address, fileKey: FK18P, revision: 1n, price: PRICE, providerPayout: B.address, providerBps: 2000, termsHash: TERMS8, expiry: exp18 })
  await write(B, 'createRevision', [FK18P, PRICE, P.address, B.address, 2000, 1, TERMS8, exp18, AT18])
  const [b0, p0] = [await bal(B), await bal(P)]
  await write(C, 'purchase', [LID18P, 1n, PRICE, 2000, 5000], PRICE)
  const [b1, p1] = [await bal(B), await bal(P)]
  const fee18 = PRICE / 10n
  ok(b1 - b0 === PRICE - fee18, 't18 providerPayout==seller: B receives everything but the platform fee (net + service share merged at one address)')
  ok(p1 - p0 === 0n, 't18 P receives no share (payout points at the seller)')
}

await cleanup()
console.log(`\nAll ${passed} assertions passed ✓ (DirectSales adversarial tests)`)
process.exit(0)
