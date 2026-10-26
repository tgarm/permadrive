// Endpoint and throttle configuration: mainnet by default, user-overridable on
// the Settings page (persisted in localStorage). A manifest only records the
// network identifier ("mainnet"), never embedded endpoints — endpoints belong
// to application config.
// P2/P3: the Auto-EVM RPC and FileRegistry addresses are overridable the same
// way (defaults are the mainnet official endpoints and the deployment
// artifacts of the scripts/p2 and scripts/p3 deploys).

export interface AppConfig {
  rpcUrl: string
  indexerUrl: string
  minIntervalMs: number
  evmRpcUrl: string
  /** FileRegistry v2 (with register fee) — default read/write address */
  registryAddress: string
  /** FileRegistry v1 (older, feeless, read-only) — for migrating old registries and recovery fallback */
  registryV1Address: string
}

export const DEFAULT_CONFIG: AppConfig = {
  rpcUrl: 'https://rpc.mainnet.subspace.foundation/ws',
  indexerUrl: 'wss://indexer.mainnet.autonomys.xyz/ws',
  minIntervalMs: 1600,
  evmRpcUrl: 'https://auto-evm.mainnet.autonomys.xyz/ws',
  // FileRegistry v2 mainnet deployment (contracts/deployments.json auto-evm-mainnet-v2, 2026-10-26)
  registryAddress: '0x79a22e5dc2e0613d8e9b491a1a51038b9197b185',
  // FileRegistry v1 mainnet deployment (P2, 2026-10-26, frozen read-only)
  registryV1Address: '0x1751f7534b85417da6e093a2e85b4b7b90ee2e4a',
}

// The v1-era default registryAddress. Anyone whose localStorage still holds
// this value (i.e. never customized it) should follow the new default to v2,
// otherwise they would silently stay on v1.
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
      registryV1Address: parsed.registryV1Address || DEFAULT_CONFIG.registryV1Address,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
