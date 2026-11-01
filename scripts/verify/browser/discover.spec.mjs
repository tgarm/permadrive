// Discover tab (2026-11-01): public files browse over Published events. Stubbed
// EVM event scan + retrieval transport, real Discover UI, real WebCrypto for
// the download-decrypt path, real IndexedDB for follows/bookmarks. No wallet:
// discovery is a zero-wallet surface (only eth_accounts/eth_chainId allowed).
//   npm run browser -- --config browser/playwright.config.mjs

import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en')
    window.__walletRequests = []
    const provider = {
      on() {}, removeListener() {},
      async request({ method }) {
        window.__walletRequests.push(method)
        if (method === 'eth_accounts') return []
        if (method === 'eth_chainId') return '0x366'
        throw new Error(`Unexpected wallet action: ${method}`)
      },
    }
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'test-wallet', name: 'Test wallet', rdns: 'test.wallet', icon: '' }, provider },
      }))
    })
  })
})

async function noWalletPrompts(page) {
  const methods = await page.evaluate(() => window.__walletRequests)
  expect(methods.filter((m) => !['eth_accounts', 'eth_chainId'].includes(m))).toEqual([])
}

const SELLER_A = '0x' + 'aa'.repeat(20)
const SELLER_B = '0x' + 'bb'.repeat(20)
const KEY_HEX = '07'.repeat(32)

// Event fixture: three public files, two sellers. cid-c carries the buyers
// signal so Latest (block desc: a,b,c) and Hot (c,a,b) orderings differ.
async function discoverFixture(page) {
  const { webcrypto } = await import('node:crypto')
  const plain = Buffer.from('PermaDrive discover fixture\n')
  const key = new Uint8Array(32).fill(7), iv = new Uint8Array(12).fill(3)
  const aes = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const cipher = [...new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain))]
  const sha = createHash('sha256').update(plain).digest('hex')
  const cipherSha = createHash('sha256').update(Buffer.from(cipher)).digest('hex')
  const ivHex = Buffer.from(iv).toString('hex')

  const event = (manifestCid, seller, fileKey, blockNumber) =>
    ({ fileKey, seller, manifestCid, key: '0x' + KEY_HEX, plainSha256: sha, plainSize: plain.length, manifestHeightHint: 42, txHash: '0x' + '31'.repeat(32), blockNumber })
  const events = [
    event('bafk-discover-a', SELLER_A, '0x' + 'f1'.repeat(32), 100),
    event('bafk-discover-b', SELLER_B, '0x' + 'f2'.repeat(32), 90),
    event('bafk-discover-c', SELLER_A, '0x' + 'f3'.repeat(32), 80),
  ]

  const route = (pattern, body) => page.route(pattern, r => r.fulfill({ contentType: 'text/javascript', body }))
  await route('**/src/chain-context.tsx', 'export const ChainProvider=({children})=>children; const connect=async()=>({}); export const useChain=()=>({connect});')
  // the manifest is assembled per manifestCid (same name and ciphertext, rootCid aligned with the event)
  await route('**/src/lib/manifestRecover.ts', `export async function recoverManifestFromHint(_api, manifestCid){return {version:2,network:'mainnet',rootCid:manifestCid,file:{name:'discovered.txt',size:${plain.length},sha256:'${sha}',mimeType:'text/plain'},encryption:{scheme:'pdenc-v1',iv:'${ivHex}',cipherSha256:'${cipherSha}',cipherSize:${cipher.length}},compression:null,nodes:[],txs:[],uploader:{address:''},submittedAt:new Date().toISOString()}}`)
  await route('**/src/lib/retrieve.ts', `export async function retrieveFile(){return {bytes:new Uint8Array(${JSON.stringify(cipher)}),sha256Match:true}}`)

  async function stub(file, overrides) {
    const src = await readFile(new URL('../../../frontend/src/lib/' + file, import.meta.url), 'utf8')
    const names = [...src.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m => m[1])
    await route('**/src/lib/' + file, names.map(n => `export const ${n}=${overrides[n] ?? 'async()=>null'};`).join('\n'))
  }
  await stub('publicPublisher.ts', {
    publicPublisherActive: '()=>true',
    publicPublisherAddress: `()=> '0x${'55'.repeat(20)}'`,
    listPublishedEvents: `async()=>${JSON.stringify(events)}`,
  })
  await stub('sales.ts', {
    salesActive: '()=>true',
    fetchBuyerCountsByFileKey: `async()=>new Map([['0x${'f3'.repeat(32)}',new Set(['0x01','0x02','0x03'])]])`,
  })
  return { sha }
}

async function gotoDiscover(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Discover', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Discover', exact: true })).toBeVisible()
  await expect(page.locator('.files-table tbody tr')).toHaveCount(3)
}

test('discover feeds load with no wallet and a fixture downloads via real WebCrypto', async ({ page }) => {
  const f = await discoverFixture(page)
  await gotoDiscover(page)
  // Latest: block descending a(100), b(90), c(80)
  const rows = page.locator('.files-table tbody tr')
  await expect(rows.filter({ hasText: 'over-a' })).toContainText('#100')
  // Hot: cid-c carries 3 buyers → ranked first (deliberately different from Latest)
  await page.getByRole('button', { name: 'Hot', exact: true }).click()
  await expect(rows.filter({ hasText: 'over-c' }).locator('td').nth(0)).toBeVisible()
  await expect(rows.first()).toContainText('over-c')
  // Followed empty state
  await page.getByRole('button', { name: 'Followed publishers', exact: true }).click()
  await expect(page.locator('.files-table')).toHaveCount(0)
  // back to Latest, download the first row: real WebCrypto decrypt → matching plaintext sha256
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  const pending = page.waitForEvent('download')
  await rows.filter({ hasText: 'over-a' }).getByRole('button', { name: 'Download', exact: true }).click()
  const downloaded = await pending
  expect(createHash('sha256').update(await readFile(await downloaded.path())).digest('hex')).toBe(f.sha)
  await noWalletPrompts(page)
})

test('follow and bookmark persist across reload', async ({ page }) => {
  await discoverFixture(page)
  await gotoDiscover(page)
  const rows = page.locator('.files-table tbody tr')
  // follow seller B → the Followed feed keeps only row b
  await rows.filter({ hasText: 'over-b' }).getByRole('button', { name: 'Follow', exact: true }).click()
  await page.getByRole('button', { name: 'Followed publishers', exact: true }).click()
  await expect(page.locator('.files-table tbody tr')).toHaveCount(1)
  await expect(page.locator('.files-table tbody tr')).toContainText('over-b')
  // save row a → the Saved counter badge and the Saved feed
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await rows.filter({ hasText: 'over-a' }).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: /Saved \(1\)/ })).toBeVisible()
  await page.getByRole('button', { name: /Saved \(1\)/ }).click()
  await expect(page.locator('.files-table tbody tr')).toContainText('over-a')
  // still there after reload (persisted in local meta)
  await page.reload()
  await page.getByRole('button', { name: 'Discover', exact: true }).click()
  await expect(page.locator('.files-table tbody tr')).toHaveCount(3)
  await page.getByRole('button', { name: /Saved \(1\)/ }).click()
  await expect(page.locator('.files-table tbody tr')).toContainText('over-a')
  await page.getByRole('button', { name: 'Followed publishers', exact: true }).click()
  await expect(page.locator('.files-table tbody tr')).toHaveCount(1)
  await noWalletPrompts(page)
})
