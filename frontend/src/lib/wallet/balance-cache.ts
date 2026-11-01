type Chain = 'consensus' | 'evm'
const balances = new Map<string, bigint>()
const listeners = new Set<() => void>()
const keyOf = (chain: Chain, address: string) => `${chain}:${address}`

/** Share wallet-bar snapshots with fee estimates; estimates must not refetch balances. */
export function getWalletBalance(chain: Chain, address?: string): bigint | undefined {
  return address ? balances.get(keyOf(chain, address)) : undefined
}
export function setWalletBalance(chain: Chain, address: string, amount: bigint | undefined): void {
  const key = keyOf(chain, address)
  if (balances.get(key) === amount) return
  if (amount === undefined) balances.delete(key)
  else balances.set(key, amount)
  listeners.forEach((notify) => notify())
}
export function subscribeWalletBalances(notify: () => void): () => void {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}
