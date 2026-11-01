import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { connectConsensusWallet, consensusAccounts, discoverConsensusWallets, type ConsensusAccount, type ConsensusInjector, type ConsensusWallet } from './lib/wallet/injected-consensus'
import { t } from './i18n'

interface Connection {
  selectedWallet: string
  selectedAccount: ConsensusAccount | null
  accounts: ConsensusAccount[]
  injector: ConsensusInjector
}
interface State {
  isConnected: boolean
  isLoading: boolean
  connectionError: string | null
  selectedWallet: string | null
  selectedAccount: ConsensusAccount | null
  accounts: ConsensusAccount[]
  injector: ConsensusInjector | null
  availableWallets: ConsensusWallet[]
  connectWallet: (name: string) => Promise<void>
  disconnectWallet: () => void
  selectAccount: (address: string) => void
}
const Context = createContext<State | null>(null)
const PREFERENCE = 'permadrive-consensus-account'

export function ConsensusWalletProvider({ children }: { children: ReactNode }) {
  const [availableWallets, setAvailable] = useState<ConsensusWallet[]>([])
  const [connection, setConnection] = useState<Connection | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [connectionError, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const connecting = useRef(false)
  const unsubscribe = useRef<(() => void) | null>(null)
  const stopSubscription = () => {
    try { unsubscribe.current?.() } catch { /* Extension may already be closed. */ }
    unsubscribe.current = null
  }
  useEffect(() => {
    const detect = () => setAvailable(discoverConsensusWallets())
    detect()
    window.addEventListener('load', detect)
    const timers = [300, 1000, 3000].map((delay) => setTimeout(detect, delay))
    return () => {
      window.removeEventListener('load', detect)
      timers.forEach(clearTimeout)
      sequence.current++
      stopSubscription()
    }
  }, [])

  const connectWallet = async (name: string) => {
    if (connecting.current) return
    const wallet = discoverConsensusWallets().find((w) => w.extensionName === name)
    if (!wallet) { setError(t('wallet.invalidConsensusExtension')); return }
    const seq = ++sequence.current
    connecting.current = true
    setLoading(true)
    setError(null)
    stopSubscription()
    setConnection(null)
    try {
      const { accounts, injector } = await connectConsensusWallet(wallet)
      if (seq !== sequence.current) return
      let preferred: string | null = null
      try { preferred = localStorage.getItem(PREFERENCE) } catch { /* Preferences are optional. */ }
      const selectedAccount = accounts.find((a) => a.address === preferred) ?? accounts[0]
      setConnection({ selectedWallet: name, selectedAccount, accounts, injector })
      if (injector.accounts.subscribe) {
        const stop = await injector.accounts.subscribe((raw) => {
          if (seq !== sequence.current) return
          const updated = consensusAccounts(raw)
          setConnection((prev) => prev ? { ...prev, accounts: updated, selectedAccount: updated.find((a) => a.address === prev.selectedAccount?.address) ?? updated[0] ?? null } : prev)
          setError(updated.length ? null : t('wallet.noConsensusAccounts'))
        })
        if (seq !== sequence.current) { try { stop() } catch { /* Disconnected in the meantime. */ } }
        else unsubscribe.current = stop
      }
    } catch (error) {
      if (seq === sequence.current) {
        setConnection(null)
        setError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (seq === sequence.current) {
        connecting.current = false
        setLoading(false)
      }
    }
  }
  const disconnectWallet = () => {
    sequence.current++
    connecting.current = false
    stopSubscription()
    setLoading(false)
    setConnection(null)
    setError(null)
  }
  const selectAccount = (address: string) => {
    setConnection((prev) => {
      const account = prev?.accounts.find((a) => a.address === address)
      return prev && account ? { ...prev, selectedAccount: account } : prev
    })
    try { localStorage.setItem(PREFERENCE, address) } catch { /* Preferences are optional. */ }
  }
  const value: State = {
    isConnected: !!connection?.selectedAccount,
    isLoading, connectionError, availableWallets, connectWallet, disconnectWallet, selectAccount,
    selectedWallet: connection?.selectedWallet ?? null,
    selectedAccount: connection?.selectedAccount ?? null,
    accounts: connection?.accounts ?? [], injector: connection?.injector ?? null,
  }
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useConsensusWallet(): State {
  const state = useContext(Context)
  if (!state) throw new Error('useConsensusWallet requires ConsensusWalletProvider')
  return state
}
