// C01 offline test: EVM injected-wallet event lifecycle.
//  - attachEvmWalletEvents: accountsChanged/chainChanged dispatch to handlers;
//    cleanup detaches; providers without on/removeListener degrade silently
//  - connectEvmWallet: a successful connect returns a signer with chainId=870;
//    a 4902 switch falls back to wallet_addEthereumChain; still on a foreign
//    chain after switching → evmWrongChain
//  - walletClientFor guard: injected + chainId≠870 → evmChainMismatch (writes
//    rejected, reads unaffected); chainId=870 / undefined / local → allowed
// Zero network dependencies (providers are fully mocked, viem clients are only
// constructed, never requested).
//   node wallet-events-test.mjs

import assert from 'node:assert'

// config.ts loadConfig has no localStorage in Node — stub it onto the
// default-config path
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const evmM = await import('../../frontend/src/lib/wallet/injected-evm.ts')
const regM = await import('../../frontend/src/lib/registry.ts')
const { attachEvmWalletEvents, connectEvmWallet } = evmM
const { walletClientFor } = regM

let passed = 0
const ok = (cond, label) => {
  if (!cond) {
    console.error(`FAIL ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`ok - ${label}`)
}

// mock EIP-1193: programmable request plus a simple listener table exposing
// on/removeListener/emit
function makeMockProvider(requestHandler) {
  const listeners = new Map()
  return {
    listeners,
    request: (args) => requestHandler(args),
    on: (event, cb) => {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
    },
    removeListener: (event, cb) => {
      const arr = listeners.get(event) ?? []
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
      listeners.set(event, arr)
    },
    emit: (event, payload) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(payload)
    },
  }
}

const ADDR_A = '0x1111111111111111111111111111111111111111'
const ADDR_B = '0x2222222222222222222222222222222222222222'

// ---- attachEvmWalletEvents ----

{
  const provider = makeMockProvider(() => {})
  const seen = { accounts: null, chain: null }
  const detach = attachEvmWalletEvents(provider, {
    onAccountsChanged: (a) => (seen.accounts = a),
    onChainChanged: (c) => (seen.chain = c),
  })
  provider.emit('accountsChanged', [ADDR_A])
  provider.emit('chainChanged', '0x1')
  ok(seen.accounts?.[0] === ADDR_A, 'accountsChanged dispatches to handler')
  ok(seen.chain === '0x1', 'chainChanged dispatches hex chainId')
  detach()
  provider.emit('accountsChanged', [ADDR_B])
  provider.emit('chainChanged', '0x366')
  ok(seen.accounts?.[0] === ADDR_A && seen.chain === '0x1', 'cleanup detaches both listeners')
  ok(provider.listeners.get('accountsChanged')?.length === 0, 'listener table empty after cleanup')
}

{
  // the same handler must not register twice (re-attach scenario: switching
  // signers detaches the old listeners first)
  const provider = makeMockProvider(() => {})
  let calls = 0
  const detach1 = attachEvmWalletEvents(provider, { onAccountsChanged: () => calls++, onChainChanged: () => {} })
  detach1()
  attachEvmWalletEvents(provider, { onAccountsChanged: () => calls++, onChainChanged: () => {} })
  provider.emit('accountsChanged', [ADDR_A])
  ok(calls === 1, 're-attach after cleanup does not double-fire')
}

{
  // low-quality provider without on/removeListener — attach and cleanup both
  // degrade silently instead of throwing
  const bare = { request: async () => {} }
  const detach = attachEvmWalletEvents(bare, { onAccountsChanged: () => {}, onChainChanged: () => {} })
  detach()
  ok(true, 'provider without on/removeListener degrades silently')
}

// ---- connectEvmWallet ----

{
  const provider = makeMockProvider(({ method }) => {
    if (method === 'eth_requestAccounts') return [ADDR_A]
    if (method === 'wallet_switchEthereumChain') return null
    if (method === 'eth_chainId') return '0x366' // 870
    throw new Error(`unexpected ${method}`)
  })
  const signer = await connectEvmWallet({ name: 'Mock', label: 'Mock', provider })
  ok(signer.kind === 'injected' && signer.address === ADDR_A, 'connect returns injected signer')
  ok(signer.chainId === 870, 'connect records verified chainId 870 (C01)')
}

{
  // 4902 → the wallet_addEthereumChain fallback still reaches a verified connect
  const added = []
  const provider = makeMockProvider(({ method, params }) => {
    if (method === 'eth_requestAccounts') return [ADDR_A]
    if (method === 'wallet_switchEthereumChain') {
      const e = new Error('unrecognized chain')
      e.code = 4902
      throw e
    }
    if (method === 'wallet_addEthereumChain') {
      added.push(params)
      return null
    }
    if (method === 'eth_chainId') return '0x366'
    throw new Error(`unexpected ${method}`)
  })
  const signer = await connectEvmWallet({ name: 'Mock', label: 'Mock', provider })
  ok(added.length === 1 && signer.chainId === 870, '4902 falls back to addEthereumChain then verifies 870')
}

{
  // switch succeeded but eth_chainId reports a foreign chain → the connect
  // fails (no signer carrying a wrong chain is ever produced)
  const provider = makeMockProvider(({ method }) => {
    if (method === 'eth_requestAccounts') return [ADDR_A]
    if (method === 'wallet_switchEthereumChain') return null
    if (method === 'eth_chainId') return '0x1'
    throw new Error(`unexpected ${method}`)
  })
  await assert.rejects(
    () => connectEvmWallet({ name: 'Mock', label: 'Mock', provider }),
    /evmWrongChain/,
    'connect on wrong chain rejects',
  )
  ok(true, 'connect on wrong chain rejects with evmWrongChain')
}

// ---- walletClientFor write guard (foreign chain blocks writes, with a reason) ----

const injectedBase = { kind: 'injected', address: ADDR_A, provider: makeMockProvider(() => {}), label: 'Mock' }

{
  let threw = null
  try {
    walletClientFor({ ...injectedBase, chainId: 1 })
  } catch (e) {
    threw = e
  }
  ok(threw && /evmChainMismatch/.test(threw.message), 'injected on foreign chain rejected by write guard')
}
ok(Boolean(walletClientFor({ ...injectedBase, chainId: 870 })), 'injected on 870 passes write guard')
ok(Boolean(walletClientFor({ ...injectedBase })), 'injected without chainId passes guard (legacy tolerance)')
ok(
  Boolean(
    walletClientFor({
      kind: 'local',
      address: ADDR_B,
      account: { address: ADDR_B, signMessage: async () => '0x', signTransaction: async () => '0x', signTypedData: async () => '0x' },
      label: 'local',
    }),
  ),
  'local signer bypasses chain guard (talks to our RPC directly)',
)

console.log(`\n${passed} assertions passed`)
