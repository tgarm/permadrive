// Chain-side badge (unified color rule): consensus = teal, EVM = violet.
// Usage: any UI element mentioning "wallet / balance / fees / transactions"
// whose meaning belongs to one chain gets a nearby ChainTag (or a
// .txt-consensus / .txt-evm text color) — so users can form a passive memory
// of "which chain this money/fee lives on" without parsing terminology.
// Both theme tokens live in styles.css: --chain-consensus / --chain-evm.

import { useI18n } from '../i18n'

export function ChainTag({ chain }: { chain: 'consensus' | 'evm' }) {
  const { t } = useI18n()
  return <span className={`chain-tag ${chain}`}>{chain === 'consensus' ? t('common.chainConsensus') : t('common.chainEvm')}</span>
}
