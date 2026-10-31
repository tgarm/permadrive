// Wallet bar: the two signer stacks connect independently.
//  Autonomys Consensus — extension wallet (auto-wallet: Talisman / SubWallet /
//              Polkadot.js, production path) or local key (dev / acceptance
//              path; the mnemonic is kept in memory only and is lost on refresh)
//  Auto EVM —   injected browser wallet (EIP-6963 multi-wallet discovery:
//              MetaMask etc., production path) or local key (m/44'/60'
//              derivation of the same mnemonic, dev / acceptance path)
// Both columns connect the same way: one button per wallet, labeled with the
// wallet's display name.

import { useEffect, useState } from 'react'
import { useWallet } from '@autonomys/auto-wallet-react'
import type { Signer } from '@polkadot/api/types'
import { useSigner } from '../signer-context'
import { ChainTag } from './ChainTag'
import { createLocalSigner } from '../lib/wallet/local-keyring'
import { createLocalEvmSigner } from '../lib/wallet/local-evm'
import { attachEvmWalletEvents, connectEvmWallet, discoverEvmWallets, type DiscoveredEvmWallet } from '../lib/wallet/injected-evm'
import { AUTO_EVM_CHAIN_ID } from '../lib/evm'
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
  const [evmWallets, setEvmWallets] = useState<DiscoveredEvmWallet[] | null>(null)

  // Display name for the active-signer strip: an extension wallet's label is
  // its extensionName (e.g. "talisman") — show the title (e.g. "Talisman"),
  // matching the connect buttons; fall back to signerName when not found
  const substrateName = (label: string): string =>
    wallet.availableWallets.find((w) => w.extensionName === label)?.title ?? signerName(label)

  // EVM wallet discovery (EIP-6963 + legacy fallback): once on mount and again
  // after a disconnect (covers wallets that become ready after page load and
  // wallets installed/enabled while connecting)
  useEffect(() => {
    if (evm) return
    let alive = true
    void discoverEvmWallets().then((list) => {
      if (alive) setEvmWallets(list)
    })
    return () => {
      alive = false
    }
  }, [evm])

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

  const connectEvm = async (w: DiscoveredEvmWallet) => {
    setEvmError(null)
    try {
      const signer = await connectEvmWallet(w)
      setEvm(signer)
      setDevEvm('injected')
    } catch (e) {
      setEvmError((e as Error).message)
    }
  }

  // Follow the injected wallet's account/network changes — an in-wallet
  // account switch updates the signer address in place (provider/label stay,
  // every feature re-reads by address); a wallet-side disconnect (empty
  // array) disconnects the signer; a network switch only refreshes chainId,
  // writes are rejected by the registry.walletClientFor guard (the UI notice
  // below explains), switching back to 870 re-enables automatically.
  // Functional updates keep the handlers free of stale signer snapshots;
  // cleanup detaches on switch/disconnect.
  const evmProvider = evm?.kind === 'injected' ? evm.provider : undefined
  useEffect(() => {
    if (!evmProvider) return
    return attachEvmWalletEvents(evmProvider, {
      onAccountsChanged: (accounts) => {
        if (accounts.length === 0) {
          setEvm((prev) => (prev?.kind === 'injected' ? null : prev))
          setDevEvm((d) => (d === 'injected' ? 'none' : d))
        } else {
          setEvm((prev) =>
            prev?.kind === 'injected' && prev.address !== accounts[0] ? { ...prev, address: accounts[0] } : prev,
          )
        }
      },
      onChainChanged: (chainIdHex) => {
        const chainId = Number.parseInt(chainIdHex, 16)
        if (Number.isNaN(chainId)) return
        setEvm((prev) => (prev?.kind === 'injected' && prev.chainId !== chainId ? { ...prev, chainId } : prev))
      },
    })
  }, [evmProvider, setEvm])

  // Chain-mismatch notice (same source of truth as the write guard): when the
  // wallet is on a different network, say plainly that EVM actions are paused
  const evmChainMismatch = evm?.kind === 'injected' && evm.chainId !== undefined && evm.chainId !== AUTO_EVM_CHAIN_ID

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
        ) : evmWallets === null ? null : evmWallets.length === 0 ? (
          <span className="muted">{t('wallet.noEvmExtension')}</span>
        ) : (
          <div className="wallet-buttons">
            {evmWallets.map((w, i) => (
              <button key={`${w.label}-${i}`} className="btn ghost small" onClick={() => void connectEvm(w)}>
                {w.name}
              </button>
            ))}
          </div>
        )}
        {evmError && <div className="error-text">{evmError}</div>}
        {evmChainMismatch && <div className="error-text">{t('errors.evmChainMismatch', [String(evm?.chainId ?? '')])}</div>}
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
                {localSigner.address.slice(0, 12)}…{t('wallet.substrateSuffix')}
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
              {active && <span className="txt-consensus">{t('wallet.substrateLabel', [substrateName(active.label), active.address.slice(0, 10) + '…'])}</span>}
              {active && evm && ' ｜ '}
              {evm && <span className="txt-evm">{t('wallet.evmLabel', [signerName(evm.label), evm.address.slice(0, 8) + '…'])}</span>}
            </>
          )}
      </div>
    </div>
  )
}
