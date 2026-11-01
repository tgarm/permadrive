import { getManifestPublishMeta } from '../lib/manifestPublish'
import { useState, useSyncExternalStore } from 'react'
import { useSigner } from '../signer-context'
import { useChain } from '../chain-context'
import { quoteRegisterFee, registryPublicClient } from '../lib/registry'
import { getWalletBalance, subscribeWalletBalances } from '../lib/wallet/balance-cache'
import { formatAi3 } from '../lib/bytes'
import type { Manifest } from '../lib/manifest'
import { prepareUpload, estimateFee } from '../lib/publish'
import { useI18n } from '../i18n'

export function FundingStatus({ manifest }: { manifest?: Manifest }) {
  const { active, evm } = useSigner()
  const { connect } = useChain()
  const { t } = useI18n()
  const storage = useSyncExternalStore(subscribeWalletBalances, () => getWalletBalance('consensus', active?.address))
  const evmBalance = useSyncExternalStore(subscribeWalletBalances, () => getWalletBalance('evm', evm?.address))
  const [state, setState] = useState<{ identity: string; fee: bigint; gas: bigint; storageFee: bigint | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const identity = manifest?.rootCid ?? ''
  const visible = state?.identity === identity ? state : null
  const refresh = async () => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      const [fee, gasPrice] = await Promise.all([quoteRegisterFee(manifest?.file.size ?? 0), registryPublicClient().getGasPrice()])
      const gas = 250_000n * gasPrice
      let storageFee: bigint | null = null
      if (manifest && !(await getManifestPublishMeta(manifest.rootCid))) {
        const api = await connect()
        const packed = await prepareUpload(new File([JSON.stringify(manifest)], `${manifest.rootCid}.manifest.json`, { type: 'application/json' }))
        storageFee = (await estimateFee(api, packed.totalBytes)).shannons
      } else if (manifest) storageFee = 0n
      setState({ identity, gas, storageFee, fee })
    } catch { setError(true) } finally { setBusy(false) }
  }
  if (!manifest || !evm) return null
  return <section className="card" data-testid="funding-status">
    <div className="card-head"><h3><span aria-hidden="true">◈ </span>{t('funding.title')}</h3>
      <button className="btn small" disabled={busy} aria-busy={busy} onClick={() => void refresh()}>{t(busy ? 'funding.loading' : 'funding.refresh')}</button>
    </div>
    <p className="muted">{manifest.file.name}</p>
    {visible && <div className="fee-summary">
      <div className="fee-tile"><span aria-hidden="true">▤</span><div><span>{t('funding.estimate')}</span><strong>{formatAi3(visible.fee)} AI3</strong></div></div>
      <div className="fee-tile"><span aria-hidden="true">⚡</span><div><span>{t('funding.gasReserve')}</span><strong>≈ {formatAi3(visible.gas)} AI3</strong></div></div>
      {visible.storageFee != null && visible.storageFee > 0n && <div className="fee-tile"><span aria-hidden="true">▣</span><div><span>{t('funding.manifestFee')}</span><strong>≈ {formatAi3(visible.storageFee)} AI3</strong></div></div>}
      <p>{evmBalance === undefined ? t('funding.balanceUnknown') : visible.fee + visible.gas > evmBalance ? t('funding.shortfall', [formatAi3(visible.fee + visible.gas - evmBalance)]) : t('funding.ready')}</p>
      {visible.storageFee != null && visible.storageFee > 0n && storage !== undefined && visible.storageFee > storage && <p>{t('funding.storageShortfall', [formatAi3(visible.storageFee - storage)])}</p>}
    </div>}
    {error && <p role="alert">{t('funding.failed')}</p>}
    {visible && <p className="muted">{t('funding.warning')}</p>}
    <a href="https://xdm-bridge.ai3.land/" target="_blank" rel="noopener noreferrer">{t('funding.bridge')}</a>
  </section>
}
