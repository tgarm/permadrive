import { setWalletBalance } from '../lib/wallet/balance-cache'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChain } from '../chain-context'
import { formatAi3 } from '../lib/bytes'
import { getEvmBalance } from '../lib/registry'
import { useI18n } from '../i18n'

/** Public-chain reads only; never requests wallet permissions or signatures. */
export function WalletBalance({ chain, address }: { chain: 'consensus' | 'evm'; address?: string }) {
  const { connect } = useChain()
  const { t } = useI18n()
  const request = useRef(0)
  const [state, setState] = useState<{ key: string; amount?: bigint; loading: boolean; failed: boolean } | null>(null)
  const key = `${chain}:${address}`
  const refresh = useCallback(async () => {
    if (!address) return
    setWalletBalance(chain, address, undefined)
    const version = ++request.current
    setState({ key, loading: true, failed: false })
    try {
      let amount: bigint
      if (chain === 'evm') amount = await getEvmBalance(address)
      else {
        const api = await connect()
        const account = (await api.query.system.account(address)).toJSON() as unknown as { data: { free: string; frozen?: string } }
        const available = BigInt(account.data.free) - BigInt(account.data.frozen ?? '0')
        amount = available > 0n ? available : 0n
      }
      if (typeof amount !== 'bigint') throw new Error('Invalid balance response')
      if (request.current === version) {
        setWalletBalance(chain, address, amount)
        setState({ key, amount, loading: false, failed: false })
      }
    } catch {
      if (request.current === version) setState({ key, loading: false, failed: true })
    }
  }, [address, chain, connect, key])
  useEffect(() => {
    void refresh()
    return () => { request.current++; if (address) setWalletBalance(chain, address, undefined) }
  }, [refresh])
  if (!address) return null
  const visible = state?.key === key ? state : null
  return <div className={`wallet-balance txt-${chain}`} data-testid={`wallet-balance-${chain}`}>
    <span role="status">{t(chain === 'consensus' ? 'wallet.availableBalance' : 'wallet.balance')}: {visible?.amount !== undefined ? `${formatAi3(visible.amount)} AI3` : visible?.failed ? t('wallet.balanceFailed') : t('wallet.balanceLoading')}</span>
    <button className="btn ghost small icon" disabled={visible?.loading} onClick={() => void refresh()} aria-label={t('wallet.refreshBalance')} title={t('wallet.refreshBalance')}>⟳</button>
  </div>
}
