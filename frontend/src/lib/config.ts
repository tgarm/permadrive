// Endpoint and throttle configuration: mainnet by default, user-overridable on
// the Settings page (persisted in localStorage). A manifest only records the
// network identifier ("mainnet"), never embedded endpoints — endpoints belong
// to application config.
// The Auto-EVM RPC and FileRegistry addresses are overridable the same
// way (defaults are the mainnet official endpoints and the deployment
// artifacts of the scripts/p2 and scripts/p3 deploys).

export interface AppConfig {
  rpcUrl: string
  indexerUrl: string
  minIntervalMs: number
  evmRpcUrl: string
  /** FileRegistry v2 (with register fee) — default read/write address; the frozen v1 stays out of the config (never publicly launched, its history lives on-chain and in deployments.json) */
  registryAddress: string
  /** Mailbox (on-chain private messages) */
  mailboxAddress: string
  /** Mailbox deployment block (the getLogs scan start; baked in at deploy time) */
  mailboxDeployBlock: number
  /** DirectSales (direct sales: pay-and-split, no refunds, ratings).
   *  Once set, sharing is available (seller actions live in the per-file share
   *  panel, buyer actions in the Share tab); empty means direct sales is
   *  unavailable. (The paid-download escrow frontend was removed entirely on
   *  2026-10-31; the v1/v2 contracts stay on-chain and in deployments.json as
   *  history — there is no frontend entry anymore.) */
  salesAddress: string
  salesDeployBlock: number
  /** PublicPublisher (public = 1 wei dust-price sale + a Published event that
   *  makes the file key public). When empty, both the public entry and the
   *  public log reads are disabled (for-sale actions via DirectSales are
   *  unaffected). Reader trust domain: only events emitted by this address
   *  are trusted; cursor keys include this address. */
  publicPublisherAddress: string
  publicPublisherDeployBlock: number
}

export const DEFAULT_CONFIG: AppConfig = {
  rpcUrl: 'https://rpc.mainnet.subspace.foundation/ws',
  indexerUrl: 'wss://indexer.mainnet.autonomys.xyz/ws',
  minIntervalMs: 1600,
  evmRpcUrl: 'https://auto-evm.mainnet.autonomys.xyz/ws',
  // FileRegistry v2 mainnet deployment (contracts/deployments.json auto-evm-mainnet-v2, 2026-10-26)
  registryAddress: '0x79a22e5dc2e0613d8e9b491a1a51038b9197b185',
  // Mailbox mainnet deployment (contracts/deployments.json auto-evm-mainnet-mailbox, 2026-10-29)
  mailboxAddress: '0x3446abe95edc17e4056a28d7c5fb10d579395200',
  mailboxDeployBlock: 5311071,
  // DirectSales mainnet deployment (contracts/deployments.json auto-evm-mainnet-direct-sales, 2026-10-31)
  salesAddress: '0x4321c47c84fd38c8bff8ca33cf0a0592f3a2ee9b',
  salesDeployBlock: 5331816,
  // PublicPublisher — empty by default: the public entry stays disabled until
  // deployed; after deployment fill in the address and block from
  // deployments.json (auto-evm-mainnet-public-publisher)
  publicPublisherAddress: '',
  publicPublisherDeployBlock: 0,
}

// A few dev/acceptance devices stored the v1 address as registryAddress back
// when it was the default. v1 is retired — normalize those to the new default.
const LEGACY_V1_DEFAULT = '0x1751f7534b85417da6e093a2e85b4b7b90ee2e4a'

const STORAGE_KEY = 'permadrive.config'

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      rpcUrl: parsed.rpcUrl || DEFAULT_CONFIG.rpcUrl,
      indexerUrl: parsed.indexerUrl || DEFAULT_CONFIG.indexerUrl,
      minIntervalMs: Number(parsed.minIntervalMs) > 0 ? Number(parsed.minIntervalMs) : DEFAULT_CONFIG.minIntervalMs,
      evmRpcUrl: parsed.evmRpcUrl || DEFAULT_CONFIG.evmRpcUrl,
      registryAddress:
        parsed.registryAddress && parsed.registryAddress !== LEGACY_V1_DEFAULT
          ? parsed.registryAddress
          : DEFAULT_CONFIG.registryAddress,
      mailboxAddress: parsed.mailboxAddress || DEFAULT_CONFIG.mailboxAddress,
      mailboxDeployBlock: Number(parsed.mailboxDeployBlock) > 0 ? Number(parsed.mailboxDeployBlock) : DEFAULT_CONFIG.mailboxDeployBlock,
      salesAddress: typeof parsed.salesAddress === 'string' ? parsed.salesAddress : DEFAULT_CONFIG.salesAddress,
      salesDeployBlock: Number(parsed.salesDeployBlock) > 0 ? Number(parsed.salesDeployBlock) : DEFAULT_CONFIG.salesDeployBlock,
      publicPublisherAddress:
        typeof parsed.publicPublisherAddress === 'string' ? parsed.publicPublisherAddress : DEFAULT_CONFIG.publicPublisherAddress,
      publicPublisherDeployBlock:
        Number(parsed.publicPublisherDeployBlock) > 0 ? Number(parsed.publicPublisherDeployBlock) : DEFAULT_CONFIG.publicPublisherDeployBlock,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
