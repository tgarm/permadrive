// Chain connection singleton context: lazy connection (the mainnet RPC is
// probed only when first needed), throttled end to end. After Settings changes
// an endpoint, call disconnect(); the next connect picks up the new config.

import { ApiPromise } from '@polkadot/api'
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { connectApi } from './lib/chain'
import { loadConfig } from './lib/config'

interface ChainState {
  api: ApiPromise | null
  status: 'idle' | 'connecting' | 'ready' | 'error'
  error: string | null
  chainName: string | null
  bestBlock: number | null
  byteFeeShannons: bigint | null
  connect: () => Promise<ApiPromise>
  disconnect: () => Promise<void>
}

const ChainContext = createContext<ChainState | null>(null)

export function ChainProvider({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<ApiPromise | null>(null)
  const [status, setStatus] = useState<ChainState['status']>('idle')
  const [error, setError] = useState<string | null>(null)
  const [chainName, setChainName] = useState<string | null>(null)
  const [byteFeeShannons, setByteFeeShannons] = useState<bigint | null>(null)
  const ref = useRef<{ api: ApiPromise | null; promise: Promise<ApiPromise> | null }>({ api: null, promise: null })

  const connect = useCallback(async (): Promise<ApiPromise> => {
    if (ref.current.api?.isConnected) return ref.current.api
    if (ref.current.promise) return ref.current.promise
    setStatus('connecting')
    setError(null)
    const cfg = loadConfig()
    const promise = connectApi(cfg.rpcUrl, { minIntervalMs: cfg.minIntervalMs })
      .then(async (connected) => {
        ref.current.api = connected
        setApi(connected)
        setChainName((await connected.rpc.system.chain()).toString())
        const fee = await connected.query.transactionFees.transactionByteFee()
        const json = fee.toJSON() as { current?: string | number }
        setByteFeeShannons(BigInt(json.current ?? 0))
        setStatus('ready')
        return connected
      })
      .catch((e: unknown) => {
        setStatus('error')
        setError((e as Error).message ?? String(e))
        ref.current.promise = null
        throw e
      })
    ref.current.promise = promise
    return promise
  }, [])

  const disconnect = useCallback(async () => {
    ref.current.promise = null
    const current = ref.current.api
    ref.current.api = null
    setApi(null)
    setStatus('idle')
    setChainName(null)
    setByteFeeShannons(null)
    if (current) await current.disconnect()
  }, [])

  return (
    <ChainContext.Provider value={{ api, status, error, chainName, bestBlock: null, byteFeeShannons, connect, disconnect }}>
      {children}
    </ChainContext.Provider>
  )
}

export function useChain(): ChainState {
  const ctx = useContext(ChainContext)
  if (!ctx) throw new Error('useChain must be used within ChainProvider')
  return ctx
}
