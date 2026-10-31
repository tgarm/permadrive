// Wallet bar: the two signer stacks connect independently.
//  Substrate — extension wallet (auto-wallet: Talisman / SubWallet / Polkadot.js,
//              production path) or local key (dev / acceptance path; the mnemonic
//              is kept in memory only and is lost on refresh)
//  EVM —       injected browser wallet (MetaMask etc., production path) or local
//              key (m/44'/60' derivation of the same mnemonic, dev / acceptance path)

import { useEffect, useState } from 'react'
import { useWallet } from '@autonomys/auto-wallet-react'
import type { Signer } from '@polkadot/api/types'
import { useSigner } from '../signer-context'
import { ChainTag } from './ChainTag'
import { createLocalSigner } from '../lib/wallet/local-keyring'
import { createLocalEvmSigner } from '../lib/wallet/local-evm'
import { connectInjectedEvm, hasInjectedEvm } from '../lib/wallet/injected-evm'
import { t } from '../i18n'

// Signer labels are stable identifiers written by the lib layer; they map to
// display names in the current locale here. Extension wallet names (Talisman
// etc.) are proper nouns and render as-is.
function signerName(label: string): string {
  if (label === 'local') return t('wallet.labelLocal')
  if (label === 'injected') return t('wallet.labelInjected')
  return label
}

export function WalletBar() {
  const wallet = useWallet()
  const { active, setActive, evm, setEvm } = useSigner()
  const [mode, setMode] = useState<'extension' | 'local' | null>(null)
  const [localSigner, setLocalSigner] = useState<Awaited<ReturnType<typeof createLocalSigner>> | null>(null)
  const [mnemonic, setMnemonic] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [showDev, setShowDev] = useState(false)
  const [evmError, setEvmError] = useState<string | null>(null)
  const [devEvm, setDevEvm] = useState<'none' | 'local' | 'injected'>('none')

  // Derive the active signer: the user-selected mode wins; clear it if its source becomes invalid
  useEffect(() => {
    if (mode === 'extension') {
      const acc = wallet.selectedAccount
      if (wallet.isConnected && acc && wallet.injector?.signer) {
        setActive({
          kind: 'extension',
          address: acc.address,
          // extension-inject bundles its own copy of @polkadot/types: the Signer
          // interfaces are structurally identical but nominally distinct types,
          // fully compatible at runtime — cast to the api-side type
          signer: wallet.injector.signer as Signer,
          label: wallet.selectedWallet ?? 'extension',
        })
        return
      }
      setMode(null)
    }
    if (mode === 'local' && localSigner) {
      setActive(localSigner)
      return
    }
    setActive(null)
  }, [mode, wallet.isConnected, wallet.selectedAccount, wallet.injector, wallet.selectedWallet, localSigner, setActive])

  const useLocalMnemonicBoth = async () => {
    setLocalError(null)
    setEvmError(null)
    try {
      const signer = await createLocalSigner(mnemonic.trim())
      setLocalSigner(signer)
      setMode('local')
      const evmSigner = await createLocalEvmSigner(mnemonic.trim())
      setEvm(evmSigner)
      setDevEvm('local')
    } catch (e) {
      setLocalError((e as Error).message)
    }
  }

  const connectInjected = async () => {
    setEvmError(null)
    try {
      const signer = await connectInjectedEvm()
      setEvm(signer)
      setDevEvm('injected')
    } catch (e) {
      setEvmError((e as Error).message)
    }
  }

  return (
    <div className="wallet-bar">
      <div className="wallet-section">
        {/* chain color rule: consensus = teal, EVM = violet — the two wallet
            columns are distinguishable at a glance */}
        <div className="wallet-section-title">
          <ChainTag chain="consensus" /> {t('wallet.substrateTitle')}
        </div>
        {!wallet.isConnected ? (
          wallet.availableWallets.length === 0 ? (
            <span className="muted">{t('wallet.noExtension')}</span>
          ) : (
            <div className="wallet-buttons">
              {wallet.availableWallets.map((w) => (
                <button key={w.extensionName} className="btn ghost small" onClick={() => wallet.connectWallet(w.extensionName)}>
                  {w.title}
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="wallet-connected">
            {wallet.accounts.length > 1 ? (
              <select value={wallet.selectedAccount?.address ?? ''} onChange={(e) => wallet.selectAccount(e.target.value)}>
                {wallet.accounts.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name ? `${a.name} · ` : ''}
                    {a.address.slice(0, 10)}…{a.address.slice(-6)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="mono">
                {wallet.selectedAccount?.address.slice(0, 12)}…{wallet.selectedAccount?.address.slice(-8)}
              </span>
            )}
            <button className="btn ghost small" onClick={() => wallet.disconnectWallet()}>
              {t('common.disconnect')}
            </button>
          </div>
        )}
        {wallet.connectionError && <div className="error-text">{wallet.connectionError}</div>}
      </div>

      <div className="wallet-section">
        <div className="wallet-section-title">
          <ChainTag chain="evm" /> {t('wallet.registryTitle')}
        </div>
        {evm ? (
          <div className="wallet-connected">
            <span className="mono">
              {evm.address.slice(0, 10)}…{evm.address.slice(-6)}
            </span>
            <button
              className="btn ghost small"
              onClick={() => {
                setEvm(null)
                setDevEvm('none')
              }}
            >
              {t('common.disconnect')}
            </button>
          </div>
        ) : hasInjectedEvm() ? (
          <button className="btn ghost small" onClick={() => void connectInjected()}>
            {t('wallet.connectEvm')}
          </button>
        ) : (
          <span className="muted">{t('wallet.noEvmExtension')}</span>
        )}
        {evmError && <div className="error-text">{evmError}</div>}
      </div>

      <button className="btn link small" onClick={() => setShowDev((v) => !v)}>
        {showDev ? t('wallet.devHide') : t('wallet.devToggle')}
      </button>

      {showDev && (
        <div className="wallet-section dev">
          <div className="wallet-section-title">{t('wallet.devTitle')}</div>
          {localSigner ? (
            <div className="wallet-connected">
              <span className="mono">
                {localSigner.address.slice(0, 12)}…{localSigner.address.slice(-8)}
              </span>
              {devEvm === 'local' && evm && <span className="mono"> · {evm.address.slice(0, 8)}…{t('wallet.evmSuffix')}</span>}
              <button
                className="btn ghost small"
                onClick={() => {
                  setLocalSigner(null)
                  setMode(null)
                  setMnemonic('')
                  if (devEvm === 'local') {
                    setEvm(null)
                    setDevEvm('none')
                  }
                }}
              >
                {t('wallet.clear')}
              </button>
            </div>
          ) : (
            <div className="local-mnemonic">
              <input
                type="password"
                placeholder={t('wallet.mnemonicPlaceholder')}
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void useLocalMnemonicBoth()}
              />
              <button className="btn small" disabled={!mnemonic.trim()} onClick={() => void useLocalMnemonicBoth()}>
                {t('wallet.useBoth')}
              </button>
            </div>
          )}
          {localError && <div className="error-text">{localError}</div>}
        </div>
      )}

      <div className={`active-signer ${active || evm ? 'on' : ''}`}>
        {!active && !evm
          ? t('wallet.noSigner')
          : (
            <>
              {active && <span className="txt-consensus">{t('wallet.substrateLabel', [signerName(active.label), active.address.slice(0, 10) + '…'])}</span>}
              {active && evm && ' ｜ '}
              {evm && <span className="txt-evm">{t('wallet.evmLabel', [signerName(evm.label), evm.address.slice(0, 8) + '…'])}</span>}
            </>
          )}
      </div>
    </div>
  )
}
