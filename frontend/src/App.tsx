import { useState } from 'react'
import { WalletProvider } from '@autonomys/auto-wallet-react'
import { ChainProvider } from './chain-context'
import { SignerProvider } from './signer-context'
import { WalletBar } from './components/WalletBar'
import { ThemeToggle } from './components/ThemeToggle'
import { FilesPage } from './pages/FilesPage'
import { NotesPage } from './pages/NotesPage'
import { VaultPage } from './pages/VaultPage'
import { AboutPage } from './pages/AboutPage'
import { SettingsPage } from './pages/SettingsPage'

type Tab = 'files' | 'notes' | 'vault' | 'about' | 'settings'

function Shell() {
  const [tab, setTab] = useState<Tab>('files')
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <h1>PermaDrive</h1>
            <p className="tagline">Permanent storage on Autonomys · No backend · No accounts</p>
          </div>
        </div>
        <div className="header-side">
          <ThemeToggle />
          <WalletBar />
        </div>
      </header>
      <nav className="tabs">
        <button className={tab === 'files' ? 'tab active' : 'tab'} onClick={() => setTab('files')}>
          My Files
        </button>
        <button className={tab === 'notes' ? 'tab active' : 'tab'} onClick={() => setTab('notes')}>
          Notes
        </button>
        <button className={tab === 'vault' ? 'tab active' : 'tab'} onClick={() => setTab('vault')}>
          Vault
        </button>
        <button className={tab === 'about' ? 'tab active' : 'tab'} onClick={() => setTab('about')}>
          About
        </button>
        <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>
      <main>
        {tab === 'files' ? (
          <FilesPage />
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
        Files and texts are published on-chain via system.remark and archived permanently by the DSN farmer network · the manifest is your retrieval credential · the vault envelope only ever holds ciphertext — keep the keystore file offline
        <br />
        Part of the AI3.LAND toolset:
        <a href="https://xdm-bridge.ai3.land/" target="_blank" rel="noreferrer noopener">
          XDM Bridge
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
