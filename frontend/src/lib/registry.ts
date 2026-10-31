// FileRegistry v2 contract interactions (Auto-EVM; register is payable:
// fee = max(minFee, size x feePerByte), overpayment is refunded, the fee goes
// straight to the treasury). DuplicateEntry is treated as "already registered"
// (idempotent semantics); every other error propagates.
// The frozen v1 contract lives only in on-chain history (deployments.json) —
// it never had a public launch, so the frontend no longer integrates it
// (operator decision, 2026-10-27).

import { createPublicClient, createWalletClient, custom, http, type PublicClient, type WalletClient } from 'viem'
import { loadConfig } from './config.ts'
import { AUTO_EVM_CHAIN_ID, autoEvmChain } from './evm.ts'
import { REGISTRY_ABI } from './registry-abi.ts'
import type { EvmSigner } from './wallet/types.ts'
import { t } from '../i18n/core.ts'

export interface RegistryEntry {
  manifestCid: string
  height: number
  name: string
  size: bigint
  registeredAt: bigint
  feePaid: bigint
}

let publicClientCache: { rpcUrl: string; client: PublicClient } | null = null

export function registryPublicClient(): PublicClient {
  const rpcUrl = loadConfig().evmRpcUrl
  if (publicClientCache?.rpcUrl === rpcUrl) return publicClientCache.client
  const client = createPublicClient({ chain: autoEvmChain, transport: http(rpcUrl) })
  publicClientCache = { rpcUrl, client }
  return client
}

function registryAddress(): `0x${string}` {
  const addr = loadConfig().registryAddress
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) {
    throw new Error(t('errors.registryNotConfigured'))
  }
  return addr as `0x${string}`
}

export function walletClientFor(signer: EvmSigner): WalletClient {
  // After an in-wallet network switch, an injected signer must not write to
  // the wrong chain — every provider-backed write is rejected (reads go
  // through our own HTTP RPC and are unaffected). chainId is kept fresh by
  // the WalletBar chainChanged listener; switching back to 870 re-enables
  // writes automatically. We never switch chains on the user's behalf.
  if (signer.kind === 'injected' && signer.chainId !== undefined && signer.chainId !== AUTO_EVM_CHAIN_ID) {
    throw new Error(t('errors.evmChainMismatch', [String(signer.chainId)]))
  }
  if (signer.kind === 'injected') {
    if (!signer.provider) throw new Error(t('errors.injectedNoProvider'))
    return createWalletClient({ chain: autoEvmChain, transport: custom(signer.provider), account: signer.address as `0x${string}` })
  }
  if (!signer.account) throw new Error(t('errors.localNoAccount'))
  return createWalletClient({
    chain: autoEvmChain,
    transport: http(loadConfig().evmRpcUrl),
    account: signer.account,
  })
}

// Wait for a write tx to land in a block (registry writes do not participate in
// confirmation-depth logic — the EVM domain produces blocks fast, so a receipt
// is already a strong signal)
export async function waitWritten(hash: `0x${string}`): Promise<void> {
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(t('errors.registryTxFailed', [receipt.status, hash]))
}

// writeContract's account must be given explicitly (nullable in the client's
// generic type): the injected path passes the address (signing inside the
// extension), the local path passes the Account object (local signing)
export const accountOf = (signer: EvmSigner) =>
  signer.kind === 'injected' ? (signer.address as `0x${string}`) : signer.account!

export async function fetchEntries(owner: string): Promise<RegistryEntry[]> {
  const raw = (await registryPublicClient().readContract({
    address: registryAddress(),
    abi: REGISTRY_ABI,
    functionName: 'entries',
    args: [owner as `0x${string}`],
  })) as RegistryEntry[]
  return raw
}

export async function getEvmBalance(address: string): Promise<bigint> {
  return registryPublicClient().getBalance({ address: address as `0x${string}` })
}

/** Contract fee parameters (shown and compared on the About page; feePerByte is
 * adjusted by the owner to follow the consensus-chain rate, MAX_FEE_PER_BYTE is
 * the hard anti-rug cap) */
export interface RegistryParams {
  feePerByte: bigint
  minFee: bigint
  maxFeePerByte: bigint
}

export async function registryParams(): Promise<RegistryParams> {
  const client = registryPublicClient()
  const address = registryAddress()
  const [feePerByte, minFee, maxFeePerByte] = await Promise.all(
    (['feePerByte', 'minFee', 'MAX_FEE_PER_BYTE'] as const).map((f) =>
      client.readContract({ address, abi: REGISTRY_ABI, functionName: f }),
    ),
  )
  return { feePerByte, minFee, maxFeePerByte }
}

/** Register-fee quote for the v2 contract (max(minFee, size × feePerByte), in wei) */
export async function quoteRegisterFee(size: number): Promise<bigint> {
  return registryPublicClient().readContract({
    address: registryAddress(),
    abi: REGISTRY_ABI,
    functionName: 'quote',
    args: [BigInt(size)],
  })
}

export interface RegisterArgs {
  manifestCid: string
  height: number
  name: string
  size: number
}

export interface RegisterResult {
  txHash: string
  alreadyRegistered: boolean
  /** dev fee actually paid (wei); null when already registered (idempotent skip) */
  fee: bigint | null
}

export async function registerFile(
  signer: EvmSigner,
  args: RegisterArgs,
  opts: { fee?: bigint } = {},
): Promise<RegisterResult> {
  const wallet = walletClientFor(signer)
  try {
    const fee = opts.fee ?? (await quoteRegisterFee(args.size))
    const hash = await wallet.writeContract({
      address: registryAddress(),
      abi: REGISTRY_ABI,
      functionName: 'register',
      args: [args.manifestCid, args.height, args.name, BigInt(args.size)],
      value: fee,
      chain: autoEvmChain,
      account: accountOf(signer),
    })
    await waitWritten(hash)
    return { txHash: hash, alreadyRegistered: false, fee }
  } catch (e) {
    // On-chain dedup hit: content addressing makes manifestCid stable, so
    // duplicate syncs are the norm, not an error
    // (the revert auto-refunds; only gas is spent)
    if (String((e as Error).message).includes('DuplicateEntry')) return { txHash: '', alreadyRegistered: true, fee: null }
    throw e
  }
}

export async function removeFile(signer: EvmSigner, manifestCid: string): Promise<string> {
  const wallet = walletClientFor(signer)
  const hash = await wallet.writeContract({
    address: registryAddress(),
    abi: REGISTRY_ABI,
    functionName: 'remove',
    args: [manifestCid],
    chain: autoEvmChain,
    account: accountOf(signer),
  })
  await waitWritten(hash)
  return hash
}
