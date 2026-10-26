// FileRegistry contract interaction (Auto-EVM + dev fee).
// Defaults to v2 (payable register: fee = max(minFee, size × feePerByte),
// overpayment is refunded, the fee goes straight to the treasury); v1 is
// frozen and read-only, kept for migrating old registries and recovery fallback.
// DuplicateEntry is treated as "already registered" (idempotent semantics);
// every other error is rethrown.

import { createPublicClient, createWalletClient, custom, http, type PublicClient, type WalletClient } from 'viem'
import { loadConfig } from './config'
import { autoEvmChain } from './evm'
import { REGISTRY_ABI } from './registry-abi'
import { REGISTRY_V1_ABI } from './registry-abi-v1'
import type { EvmSigner } from './wallet/types'

export type RegistrySource = 'v2' | 'v1'

export interface RegistryEntry {
  manifestCid: string
  height: number
  name: string
  size: bigint
  registeredAt: bigint
  /** v2 entries only (absent from the v1 ABI; migration/recovery code must not depend on it) */
  feePaid?: bigint
}

let publicClientCache: { rpcUrl: string; client: PublicClient } | null = null

export function registryPublicClient(): PublicClient {
  const rpcUrl = loadConfig().evmRpcUrl
  if (publicClientCache?.rpcUrl === rpcUrl) return publicClientCache.client
  const client = createPublicClient({ chain: autoEvmChain, transport: http(rpcUrl) })
  publicClientCache = { rpcUrl, client }
  return client
}

function registryAddress(source: RegistrySource = 'v2'): `0x${string}` {
  const cfg = loadConfig()
  const addr = source === 'v1' ? cfg.registryV1Address : cfg.registryAddress
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) {
    throw new Error(`FileRegistry ${source} address not configured (Settings → on-chain registry, or built in once the mainnet deployment lands)`)
  }
  return addr as `0x${string}`
}

const ABI_FOR: Record<RegistrySource, typeof REGISTRY_ABI | typeof REGISTRY_V1_ABI> = {
  v2: REGISTRY_ABI,
  v1: REGISTRY_V1_ABI,
}

export function walletClientFor(signer: EvmSigner): WalletClient {
  if (signer.kind === 'injected') {
    if (!signer.provider) throw new Error('injected EVM signer is missing a provider')
    return createWalletClient({ chain: autoEvmChain, transport: custom(signer.provider), account: signer.address as `0x${string}` })
  }
  if (!signer.account) throw new Error('local EVM signer is missing an account')
  return createWalletClient({
    chain: autoEvmChain,
    transport: http(loadConfig().evmRpcUrl),
    account: signer.account,
  })
}

// Wait for a write tx to land in a block (registry writes do not participate in
// confirmation-depth logic — the EVM domain produces blocks fast, so a receipt
// is already a strong signal)
async function waitWritten(hash: `0x${string}`): Promise<void> {
  const receipt = await registryPublicClient().waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error(`registry tx failed (${receipt.status}): ${hash}`)
}

// writeContract's account must be given explicitly (nullable in the client's
// generic type): the injected path passes the address (signing inside the
// extension), the local path passes the Account object (local signing)
const accountOf = (signer: EvmSigner) =>
  signer.kind === 'injected' ? (signer.address as `0x${string}`) : signer.account!

export async function fetchEntries(owner: string, source: RegistrySource = 'v2'): Promise<RegistryEntry[]> {
  const raw = (await registryPublicClient().readContract({
    address: registryAddress(source),
    abi: ABI_FOR[source],
    functionName: 'entries',
    args: [owner as `0x${string}`],
  })) as RegistryEntry[]
  return raw
}

export async function getEvmBalance(address: string): Promise<bigint> {
  return registryPublicClient().getBalance({ address: address as `0x${string}` })
}

/** Register-fee quote for the v2 contract (max(minFee, size × feePerByte), in wei) */
export async function quoteRegisterFee(size: number): Promise<bigint> {
  return registryPublicClient().readContract({
    address: registryAddress('v2'),
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
      address: registryAddress('v2'),
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
    address: registryAddress('v2'),
    abi: REGISTRY_ABI,
    functionName: 'remove',
    args: [manifestCid],
    chain: autoEvmChain,
    account: accountOf(signer),
  })
  await waitWritten(hash)
  return hash
}
