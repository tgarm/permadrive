import { test, expect } from '@playwright/test'
import { encodeAddress } from '../../../frontend/node_modules/@polkadot/util-crypto/index.js'
import { readFile } from 'node:fs/promises'
const first = encodeAddress(new Uint8Array(32).fill(1), 42)
const second = encodeAddress(new Uint8Array(32).fill(2), 42)
const firstDisplay = encodeAddress(new Uint8Array(32).fill(1), 6094)
const secondDisplay = encodeAddress(new Uint8Array(32).fill(2), 6094)
const evm = '0x' + '11'.repeat(20)

async function setup(page, accounts) {
  await page.addInitScript(({ accounts, evm }) => {
    localStorage.setItem('locale', 'en')
    window.__accounts = accounts
    window.__enableCalls = 0
    window.__queries = []
    window.__walletRequests = []
    window.injectedWeb3 = { 'subwallet-js': { enable: async () => {
      window.__enableCalls++
      return { accounts: { get: async () => window.__accounts, subscribe: (notify) => { window.__notify = notify; return () => { window.__notify = null } } }, signer: { signPayload: async () => { throw new Error('Unexpected signature') } } }
    } } }
    const provider = { on() {}, removeListener() {}, request: async ({ method }) => {
      window.__walletRequests.push(method)
      if (method === 'eth_requestAccounts') return [evm]
      if (method === 'eth_chainId') return '0x366'
      if (method === 'wallet_switchEthereumChain') return null
      throw new Error(`Unexpected wallet method: ${method}`)
    } }
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: {uuid:'test-evm',name:'Test EVM',rdns:'test.evm',icon:''},provider } })))
  }, { accounts, evm })
  await page.route('**/src/chain-context.tsx', (r) => r.fulfill({ contentType: 'text/javascript', body: `
    const connect=async()=>({query:{system:{account:async address=>{
      window.__queries.push(address);
      if(window.__failBalance)throw new Error('Read unavailable');
      if(window.__delayBalance && address==='${firstDisplay}')return new Promise(resolve=>{window.__oldBalance=()=>resolve({toJSON:()=>({data:{free:'99000000000000000000',frozen:'0'}})})});
      return {toJSON:()=>({data:{free:address==='${firstDisplay}'?'5000000000000000000':'9000000000000000000',frozen:'2000000000000000000'}})};
    }}}});
    export const ChainProvider=({children})=>children;
    export const useChain=()=>({connect,status:'ready'});
  ` }))
  const source = await readFile(new URL('../../../frontend/src/lib/registry.ts', import.meta.url), 'utf8')
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1])
  const replacements = { getEvmBalance: "async()=>{window.__evmReads=(window.__evmReads||0)+1;return BigInt(window.__evmAmount??'1250000000000000000')}", fetchEntries: 'async()=>[]', quoteRegisterFee:'async()=>10000000000000000n', registryPublicClient:'()=>({getGasPrice:async()=>2n})' }
  await page.route('**/src/lib/registry.ts', (r) => r.fulfill({ contentType: 'text/javascript', body: names.map((n) => `export const ${n}=${replacements[n] ?? 'async()=>null'};`).join('\n') }))
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort())
  await page.goto('/')
}
const consensusSection = (page) => page.locator('.wallet-section').filter({ has: page.locator('.chain-tag.consensus') })

test('SubWallet mixed account lists connect only Consensus accounts and show independent AI3 balances', async ({ page }) => {
  await setup(page, [{ address: evm, type: 'ethereum' }, { address: first, name: 'Consensus' }, { address: 'bad' }])
  expect(await page.evaluate(() => window.__enableCalls)).toBe(0)
  await expect(page.getByTestId('wallet-balance-consensus')).toHaveCount(0)
  await consensusSection(page).getByRole('button', { name: 'SubWallet', exact: true }).click()
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('3.0000 AI3')
  await expect(consensusSection(page)).not.toContainText('Expected a valid key')
  expect(await page.evaluate(() => window.__queries)).toEqual([firstDisplay])
  await page.getByRole('button', { name: 'Test EVM', exact: true }).click()
  await expect(page.getByTestId('wallet-balance-evm')).toContainText('1.2500 AI3')
  await page.getByTestId('wallet-balance-consensus').getByRole('button', { name: 'Refresh balance', exact: true }).click()
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('3.0000 AI3')
  expect(await page.evaluate(() => window.__walletRequests)).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId'])
  await page.evaluate((address) => window.__notify([{ address }]), second)
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('7.0000 AI3')
  await page.evaluate(() => { window.__staleNotify = window.__notify })
  await consensusSection(page).getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.evaluate((address) => window.__staleNotify([{ address }]), second)
  await expect(page.getByTestId('wallet-balance-consensus')).toHaveCount(0)
})

test('an EVM-only SubWallet list gives an actionable error and can reconnect after authorizing a Consensus account', async ({ page }) => {
  await setup(page, [{ address: evm }])
  await consensusSection(page).getByRole('button', { name: 'SubWallet', exact: true }).click()
  await expect(consensusSection(page)).toContainText('Create or authorize a Substrate account')
  expect(await page.evaluate(() => window.__queries)).toEqual([])
  await page.evaluate((address) => { window.__accounts = [{ address }] }, first)
  await consensusSection(page).getByRole('button', { name: 'SubWallet', exact: true }).click()
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('3.0000 AI3')
  await expect(consensusSection(page)).not.toContainText('No authorized consensus account')
})

test('a delayed balance response cannot replace the balance of a newly selected Consensus account', async ({ page }) => {
  await setup(page, [{ address: first }])
  await page.evaluate(() => { window.__delayBalance = true })
  await consensusSection(page).getByRole('button', { name: 'SubWallet', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof window.__oldBalance)).toBe('function')
  await page.evaluate((address) => window.__notify([{ address }]), second)
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('7.0000 AI3')
  await page.evaluate(() => window.__oldBalance())
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('7.0000 AI3')
  expect(await page.evaluate(() => window.__queries)).toEqual([firstDisplay, secondDisplay])
})


test('failed balance reads are unavailable rather than zero and support explicit retry', async ({ page }) => {
  await setup(page, [{ address: first }])
  await page.evaluate(() => { window.__failBalance = true })
  await consensusSection(page).getByRole('button', { name: 'SubWallet', exact: true }).click()
  const balance = page.getByTestId('wallet-balance-consensus')
  await expect(balance).toContainText('Unavailable')
  await expect(balance).not.toContainText('0.0000 AI3')
  await page.evaluate(() => { window.__failBalance = false })
  await balance.getByRole('button', { name: 'Refresh balance', exact: true }).click()
  await expect(balance).toContainText('3.0000 AI3')
})


test('fee estimates reuse wallet balance snapshots without fetching balances again', async ({ page }) => {
  await setup(page, [{ address: first }])
  await consensusSection(page).getByRole('button', { name: 'SubWallet', exact: true }).click()
  await expect(page.getByTestId('wallet-balance-consensus')).toContainText('3.0000 AI3')
  await page.getByRole('button', { name:'Test EVM',exact:true }).click()
  await expect(page.getByTestId('wallet-balance-evm')).toContainText('1.2500 AI3')
  await expect(page.getByTestId('funding-status')).toHaveCount(0)
  await page.evaluate(async () => {
    const store = await import('/src/lib/store.ts')
    await store.putManifest({version:2,network:'mainnet',rootCid:'fee-fixture',file:{name:'estimate.txt',size:1,sha256:'00'.repeat(32),mimeType:'text/plain'},encryption:null,nodes:[],txs:[],compression:null,uploader:{address:''},submittedAt:new Date().toISOString(),recovery:{manifestCid:'fee-recovery'}})
    await store.putMeta('manifestPublish:fee-fixture', {manifestCid:'fee-recovery',height:1,txHash:'0x01'})
  })
  await page.reload()
  await page.getByRole('button', {name:'Test EVM',exact:true}).click()
  await page.getByLabel('Current file', {exact:true}).selectOption('fee-fixture')
  const counts = await page.evaluate(() => [window.__queries.length,window.__evmReads])
  const panel = page.getByTestId('funding-status')
  await panel.getByRole('button', {name:'Estimate fees',exact:true}).click()
  await expect(panel).toContainText('0.0100 AI3')
  expect(await page.evaluate(() => [window.__queries.length,window.__evmReads])).toEqual(counts)
  await page.evaluate(() => {window.__evmAmount='0'})
  await page.getByTestId('wallet-balance-evm').getByRole('button', {name:'Refresh balance',exact:true}).click()
  await expect(panel).toContainText('Auto-EVM needs about 0.0100 more AI3.')
})
