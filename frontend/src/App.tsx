import { useState } from 'react'
import { WalletProvider } from '@autonomys/auto-wallet-react'
import { ChainProvider } from './chain-context'
import { SignerProvider } from './signer-context'
import { WalletBar } from './components/WalletBar'
import { FilesPage } from './pages/FilesPage'
import { SettingsPage } from './pages/SettingsPage'

type Tab = 'files' | 'settings'

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
        <WalletBar />
      </header>
      <nav className="tabs">
        <button className={tab === 'files' ? 'tab active' : 'tab'} onClick={() => setTab('files')}>
          My Files
        </button>
        <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>
      <main>{tab === 'files' ? <FilesPage /> : <SettingsPage />}</main>
      <footer className="app-footer muted">
        Files are published on-chain via system.remark and archived permanently by the DSN farmer network · the manifest is your retrieval credential — keep it safe
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
