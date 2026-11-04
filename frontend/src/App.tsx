import { useState } from 'react'
import { ConsensusWalletProvider } from './consensus-wallet-context'
import { ChainProvider } from './chain-context'
import { SignerProvider } from './signer-context'
import { LanguageSelect } from './components/LanguageSelect'
import { WalletBar } from './components/WalletBar'
import { ThemeToggle } from './components/ThemeToggle'
import { FilesPage } from './pages/FilesPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { SharePage } from './pages/SharePage'
import { MessagesPage } from './pages/MessagesPage'
import { NotesPage } from './pages/NotesPage'
import { VaultPage } from './pages/VaultPage'
import { AboutPage } from './pages/AboutPage'
import { SettingsPage } from './pages/SettingsPage'
import { parseShareHash } from './lib/shareLink'
import { useI18n } from './i18n'

type Tab = 'files' | 'discover' | 'share' | 'messages' | 'notes' | 'vault' | 'about' | 'settings'

function Shell() {
  // Deep links: parse location.hash once on mount; a `#/s?...` hash makes
  // share the initial tab and passes the parameters to SharePage. The hash is
  // kept, never cleared (the landing view is read-only and idempotent, a
  // refresh re-parses, transactions only fire on explicit clicks; no
  // hashchange listener in the MVP — pasting a new link applies on refresh).
  // When the hash looks like a share link (#/s prefix) but fails to parse,
  // still land on the share tab and render an explicit error (D11 acceptance:
  // invalid parameters are rejected with a clear error, never a silent
  // fall-back to the upload page).
  const [deepLink, deepLinkError] = (() => {
    const parsed = parseShareHash(location.hash)
    if (parsed.ok) return [parsed.params, null] as const
    return [null, location.hash.startsWith('#/s') ? parsed.reason : null] as const
  })()
  const [tab, setTab] = useState<Tab>(() => (deepLink || deepLinkError ? 'share' : 'files'))
  const { t } = useI18n() // each component subscribes to locale changes (same convention as xdm-bridge)
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          {/* Header logo and favicon are the same file (family rule shared with xdm-bridge) */}
          <img src="./favicon.svg" alt="" className="brand-logo" />
          <div>
            <h1>PermaDrive</h1>
            <p className="tagline">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="header-side">
          <LanguageSelect />
          <ThemeToggle />
        </div>
        <WalletBar />
      </header>
      <nav className="tabs">
        <button className={tab === 'files' ? 'tab active' : 'tab'} onClick={() => setTab('files')}>
          {t('app.nav.files')}
        </button>
        <button className={tab === 'discover' ? 'tab active' : 'tab'} onClick={() => setTab('discover')}>
          {t('app.nav.discover')}
        </button>
        <button className={tab === 'share' ? 'tab active' : 'tab'} onClick={() => setTab('share')}>
          {t('app.nav.share')}
        </button>
        <button className={tab === 'messages' ? 'tab active' : 'tab'} onClick={() => setTab('messages')}>
          {t('app.nav.messages')}
        </button>
        <button className={tab === 'notes' ? 'tab active' : 'tab'} onClick={() => setTab('notes')}>
          {t('app.nav.notes')}
        </button>
        <button className={tab === 'vault' ? 'tab active' : 'tab'} onClick={() => setTab('vault')}>
          {t('app.nav.vault')}
        </button>
        <button className={tab === 'about' ? 'tab active' : 'tab'} onClick={() => setTab('about')}>
          {t('app.nav.about')}
        </button>
        <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
          {t('app.nav.settings')}
        </button>
      </nav>
      <main>
        {tab === 'files' ? (
          <FilesPage />
        ) : tab === 'discover' ? (
          <DiscoverPage />
        ) : tab === 'share' ? (
          <SharePage deepLink={deepLink} parseError={deepLinkError} />
        ) : tab === 'messages' ? (
          <MessagesPage />
        ) : tab === 'notes' ? (
          <NotesPage />
        ) : tab === 'vault' ? (
          <VaultPage />
        ) : tab === 'about' ? (
          <AboutPage />
        ) : (
          <SettingsPage />
        )}
      </main>
      <footer className="app-footer muted">
        {t('app.footer.privacy')}
        <br />
        {t('app.footer.toolset')}
        <a href="https://xdm-bridge.ai3.land/" target="_blank" rel="noreferrer noopener">
          {t('app.footer.xdmBridge')}
        </a>
        {' · '}
        <a href="https://ai3.land/" target="_blank" rel="noreferrer noopener">ai3.land</a>
        {' · '}
        <a href="https://github.com/tgarm/permadrive" target="_blank" rel="noreferrer noopener">
          {t('app.footer.source')}
        </a>
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <ConsensusWalletProvider>
      <SignerProvider>
        <ChainProvider>
          <Shell />
        </ChainProvider>
      </SignerProvider>
    </ConsensusWalletProvider>
  )
}
