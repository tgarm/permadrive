import assert from 'node:assert/strict'
import { encodeAddress } from '../../frontend/node_modules/@polkadot/util-crypto/index.js'
import { consensusAccounts, connectConsensusWallet, discoverConsensusWallets } from '../../frontend/src/lib/wallet/injected-consensus.ts'

const key = new Uint8Array(32).fill(1)
const ss58 = encodeAddress(key, 42), expected = encodeAddress(key, 6094)
const evm = '0x' + '11'.repeat(20)
assert.throws(() => encodeAddress(evm, 6094), /Expected a valid key to convert/ )
const mixed = [{ address: evm, type: 'ethereum' }, { address: ss58, name: 'Consensus', type: 'sr25519' }, { address: 'malformed' }, { address: expected }]
assert.deepEqual(consensusAccounts(mixed).map((a) => a.address), [expected])
assert.deepEqual(consensusAccounts([{ address: evm }]), [])
assert.deepEqual(consensusAccounts([{ address: '0x' + '22'.repeat(33), type: 'ecdsa' }]), [])
assert.deepEqual(consensusAccounts([{ address: '0x' + '22'.repeat(32), type: 'ethereum' }]), [])
assert.deepEqual(consensusAccounts([{ address: '0x' + '22'.repeat(32), type: 'ed25519' }]).map((a) => a.address), [encodeAddress(new Uint8Array(32).fill(34), 6094)])
let enables = 0
const signer = { signPayload: async () => { throw new Error('Connecting must not sign') } }
const extension = { enable: async (name) => { enables++; assert.equal(name, 'PermaDrive'); return { signer, accounts: { get: async () => mixed } } } }
const wallets = discoverConsensusWallets({ 'subwallet-js': extension })
assert.equal(wallets.length, 1)
assert.equal(enables, 0)
const connected = await connectConsensusWallet(wallets[0])
assert.equal(enables, 1)
assert.equal(connected.injector.signer, signer)
assert.equal(connected.accounts[0].address, expected)
await assert.rejects(connectConsensusWallet({ ...wallets[0], extension: { enable: async () => ({ signer, accounts: { get: async () => [{ address: evm }] } }) } }), /Substrate|noConsensusAccounts/)
await assert.rejects(connectConsensusWallet({ ...wallets[0], extension: { enable: async () => { throw new Error('User rejected') } } }), /User rejected/)
console.log('Consensus wallet filtering, discovery, connection and rejection checks passed')
