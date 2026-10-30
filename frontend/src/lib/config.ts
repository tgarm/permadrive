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
  /** Paywall v1 (paid-download escrow) — affected by an overwrite-seller flaw,
   *  frozen read-only: only refunds/confirm/withdraw for existing orders;
   *  new listings/purchases go through v2 */
  paywallAddress: string
  paywallDeployBlock: number
  /** Paywall v2 order model — seller namespace + order snapshots. Once
   *  deployed and filled in it becomes the active instance; empty (default)
   *  keeps v1 as the only active instance (current behavior) */
  paywallV2Address: string
  paywallV2DeployBlock: number
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
  // Paywall v1 main instance (contracts/deployments.json auto-evm-mainnet-paywall, 2026-10-30;
  // 3d/3d) — frozen read-only after the seller-overwrite flaw; refund/confirm/withdraw kept
  paywallAddress: '0xb51be7a5cc1a03fd51892d9db1fc942aa164405a',
  paywallDeployBlock: 5314515,
  // Paywall v2 (order-model redesign) — filled in by the deploy script / Settings after deployment
  paywallV2Address: '',
  paywallV2DeployBlock: 0,
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
      paywallAddress: parsed.paywallAddress || DEFAULT_CONFIG.paywallAddress,
      paywallDeployBlock: Number(parsed.paywallDeployBlock) > 0 ? Number(parsed.paywallDeployBlock) : DEFAULT_CONFIG.paywallDeployBlock,
      paywallV2Address: typeof parsed.paywallV2Address === 'string' ? parsed.paywallV2Address : DEFAULT_CONFIG.paywallV2Address,
      paywallV2DeployBlock: Number(parsed.paywallV2DeployBlock) > 0 ? Number(parsed.paywallV2DeployBlock) : DEFAULT_CONFIG.paywallV2DeployBlock,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
