// Progressive disclosure (UX convention): the visible copy keeps only "how to
// use it / what it costs / is it safe" — mechanisms and rationale live behind
// the "?" affordance for users who want depth. Cross-cutting comparisons and
// the overall story live on the About page; the vault's full principles are in
// VAULT.md. Same rule for all pages: few words by default, more on expansion.

import type { ReactNode } from 'react'
import { t } from '../i18n'

export function Hint({ children, label }: { children: ReactNode; label?: string }) {
  const resolved = label ?? t('common.hintLabel')
  return (
    <details className="hint">
      <summary aria-label={resolved} title={resolved}>
        ?
      </summary>
      <div className="hint-body">{children}</div>
    </details>
  )
}
