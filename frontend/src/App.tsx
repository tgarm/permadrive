import { useState } from 'react'
import { WalletProvider } from '@autonomys/auto-wallet-react'
import { ChainProvider } from './chain-context'
import { SignerProvider } from './signer-context'
import { LanguageSelect } from './components/LanguageSelect'
import { WalletBar } from './components/WalletBar'
import { ThemeToggle } from './components/ThemeToggle'
import { FilesPage } from './pages/FilesPage'
import { SharePage } from './pages/SharePage'
import { MessagesPage } from './pages/MessagesPage'
import { NotesPage } from './pages/NotesPage'
import { VaultPage } from './pages/VaultPage'
import { AboutPage } from './pages/AboutPage'
import { SettingsPage } from './pages/SettingsPage'
import { parseShareHash, type ShareLinkParams } from './lib/shareLink'
import { useI18n } from './i18n'

type Tab = 'files' | 'share' | 'messages' | 'notes' | 'vault' | 'about' | 'settings'

function Shell() {
  // Deep links: parse location.hash once on mount; a `#/s?...` hash makes
  // share the initial tab and passes the parameters to SharePage. The hash is
  // kept, never cleared (the landing view is read-only and idempotent, a
  // refresh re-parses, transactions only fire on explicit clicks; no
  // hashchange listener in the MVP — pasting a new link applies on refresh).
  const [tab, setTab] = useState<Tab>(() => (parseShareHash(location.hash).ok ? 'share' : 'files'))
  const [deepLink] = useState<ShareLinkParams | null>(() => {
    const parsed = parseShareHash(location.hash)
    return parsed.ok ? parsed.params : null
  })
  const { t } = useI18n() // each component subscribes to locale changes (same convention as xdm-bridge)
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <h1>PermaDrive</h1>
            <p className="tagline">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="header-side">
          <LanguageSelect />
          <ThemeToggle />
          <WalletBar />
        </div>
      </header>
      <nav className="tabs">
        <button className={tab === 'files' ? 'tab active' : 'tab'} onClick={() => setTab('files')}>
          {t('app.nav.files')}
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
        ) : tab === 'share' ? (
          <SharePage deepLink={deepLink} />
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
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <WalletProvider config={{ dappName: 'PermaDrive' }}>
      <SignerProvider>
        <ChainProvider>
          <Shell />
        </ChainProvider>
      </SignerProvider>
    </WalletProvider>
  )
}
