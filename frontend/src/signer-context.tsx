// Active signer context: written by WalletBar (extension wallet or local key),
// consumed by FilesPage. The dual-signer abstraction lives in
// src/lib/wallet/types.ts — Substrate (publishing remarks) and EVM (P2
// FileRegistry registration) activate independently of each other.

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { EvmSigner, SubstrateSigner } from './lib/wallet/types'

interface SignerState {
  active: SubstrateSigner | null
  setActive: (signer: SubstrateSigner | null) => void
  evm: EvmSigner | null
  setEvm: (signer: EvmSigner | null) => void
}

const SignerContext = createContext<SignerState | null>(null)

export function SignerProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<SubstrateSigner | null>(null)
  const [evm, setEvm] = useState<EvmSigner | null>(null)
  return (
    <SignerContext.Provider value={{ active, setActive, evm, setEvm }}>{children}</SignerContext.Provider>
  )
}

export function useSigner(): SignerState {
  const ctx = useContext(SignerContext)
  if (!ctx) throw new Error('useSigner must be used within SignerProvider')
  return ctx
}
