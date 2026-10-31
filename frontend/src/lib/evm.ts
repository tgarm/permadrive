// Auto-EVM (Autonomys mainnet EVM domain) constants and chain definition.
// chainId 870, CORS fully open so browsers can connect directly, gas ~10 gwei
// (a single registry write costs <0.0001 AI3, no fee confirmation dialog
// needed). Chain metadata aligned with the official auto-drive
// packages/ui/src/constants/evm.ts and ai3-xdm-bridge constants.js.

import { defineChain } from 'viem'

export const AUTO_EVM_CHAIN_ID = 870

export const autoEvmChain = defineChain({
  id: AUTO_EVM_CHAIN_ID,
  name: 'Auto EVM',
  nativeCurrency: { name: 'AI3', symbol: 'AI3', decimals: 18 },
  rpcUrls: { default: { http: [] } }, // filled from runtime config (Settings can override the endpoint)
  blockExplorers: { default: { name: 'Auto EVM Explorer', url: 'https://explorer.auto-evm.mainnet.autonomys.xyz' } },
})

// wallet_addEthereumChain params (used by wallets that have not added Auto-EVM yet).
// chainName is "Auto EVM" rather than "Autonomys" — avoids confusion with the
// consensus chain in the wallet's network list.
export const walletAddChainParams = {
  chainId: '0x366', // 870
  chainName: 'Auto EVM',
  nativeCurrency: { name: 'AI3', symbol: 'AI3', decimals: 18 },
  rpcUrls: ['https://auto-evm.mainnet.autonomys.xyz/ws'],
  blockExplorerUrls: ['https://explorer.auto-evm.mainnet.autonomys.xyz'],
}

export const explorerAddressUrl = (address: string): string =>
  `https://explorer.auto-evm.mainnet.autonomys.xyz/address/${address}`
