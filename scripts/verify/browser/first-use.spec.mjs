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

test('first-use guide stays honest with an empty library and no wallet', async ({ page }) => {
  await page.goto('/')
  const guide = page.getByTestId('first-use-guide')
  await expect(guide).toBeVisible()
  await expect(guide.locator('li')).toHaveCount(5)
  await expect(guide.locator('button').nth(1)).toBeDisabled()
  await expect(guide.locator('button').nth(2)).toBeDisabled()
  await guide.locator('button').first().click()
  await noWalletPrompts(page)
})

test('invalid share links stay on a visible error page without wallet prompts', async ({ page }) => {
  await page.goto('/#/s?m=not-a-cid&h=-1&o=bad&k=bad')
  await expect(page.locator('main')).toContainText(/invalid|not a valid/i)
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await noWalletPrompts(page)
})

test('opening Share and Messages does not request a public key or send a transaction', async ({ page }) => {
  await page.goto('/')
  const nav = page.locator('nav.tabs button')
  await nav.nth(1).click()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await nav.nth(2).click()
  await page.waitForTimeout(750)
  await noWalletPrompts(page)
})

test('published fixture downloads with no wallet and matches the expected SHA-256', async ({ page }) => {
  test.skip(!process.env.PD_PUBLIC_SHARE_URL || !process.env.PD_PUBLIC_SHA256,
    'Provide a real public fixture URL and expected plaintext SHA-256; never infer a pass without them.')
  await page.goto(process.env.PD_PUBLIC_SHARE_URL)
  const button = page.getByRole('button', { name: /download/i }).first()
  await expect(button).toBeEnabled({ timeout: 45_000 })
  const event = page.waitForEvent('download')
  await button.click()
  const downloaded = await event
  const digest = createHash('sha256').update(await readFile(await downloaded.path())).digest('hex')
  expect(digest).toBe(process.env.PD_PUBLIC_SHA256.toLowerCase())
  await noWalletPrompts(page)
})

// Mock chain transport, real Share UI and real WebCrypto. Never broadcasts.
async function fixture(page, buyer = false) {
  const { webcrypto } = await import('node:crypto')
  const plain = Buffer.from('PermaDrive browser fixture\n')
  const key = new Uint8Array(32).fill(7), iv = new Uint8Array(12).fill(3)
  const aes = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const cipher = [...new Uint8Array(await webcrypto.subtle.encrypt({ name:'AES-GCM', iv }, aes, plain))]
  const sha = createHash('sha256').update(plain).digest('hex')
  const manifest = {version:2,file:{name:'fixture.txt',size:plain.length,sha256:sha,mimeType:'text/plain'},encryption:{iv:Buffer.from(iv).toString('hex')}}
  const route = (pattern,body) => page.route(pattern,r=>r.fulfill({contentType:'text/javascript',body}))
  await route('**/src/chain-context.tsx','export const ChainProvider=({children})=>children; const connect=async()=>({}); export const useChain=()=>({connect});')
  await route('**/src/lib/manifestRecover.ts',`export async function recoverManifestFromHint(){return ${JSON.stringify(manifest)}}`)
  await route('**/src/lib/retrieve.ts',`export async function retrieveFile(){return {bytes:new Uint8Array(${JSON.stringify(cipher)}),sha256Match:true}}`)
  async function stub(file, overrides) {
    const src = await readFile(new URL('../../../frontend/src/lib/'+file,import.meta.url),'utf8')
    const names=[...src.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1])
    await route('**/src/lib/'+file,names.map(n=>`export const ${n}=${overrides[n]??'async()=>null'};`).join('\n'))
  }
  await stub('registry.ts',{fetchEntries:'async()=>[]'})
  await stub('publicPublisher.ts',{DUST_PRICE:'10000000000000n',publicPublisherActive:'()=>false'})
  if(buyer){
    await route('**/src/signer-context.tsx',`export const SignerProvider=({children})=>children; const state={active:null,evm:{address:'0x${'11'.repeat(20)}',kind:'injected'},setActive:()=>{},setEvm:()=>{}}; export const useSigner=()=>state;`)
    await stub('sales.ts',{salesActive:'()=>true',fetchMyOrdersSales:'async()=>[]',purchaseQuote:`async()=>({price:10000000000000000n,revision:1n,listingId:'0x${'22'.repeat(32)}'})`,purchaseSalesWithQuote:'async()=>{window.__purchases=(window.__purchases||0)+1}'})
    await stub('mailbox.ts',{getAnnouncedKey:'async()=>"fixture-key"',encryptionPublicKeyFor:'async()=>"fixture-key"',mailboxAddress:`()=> '0x${'33'.repeat(20)}'`})
    await page.addInitScript(()=>{window.__purchases=0})
  }
  const cid='bafkreig4wikelzw2pttlm6uzgt7hgfulufzdpmbv4wsyl62amkiecux2he'
  return {sha,url:`/#/s?m=${cid}&h=1${buyer?'&o=0x'+'44'.repeat(20):'&k='+Buffer.from(key).toString('hex')}`}
}

test('mock public transport downloads via real WebCrypto with no wallet prompts',async({page})=>{
  const f=await fixture(page)
  await page.goto(f.url)
  const button=page.getByRole('button',{name:/download.*decrypt|decrypt.*download/i}).first()
  await expect(button).toBeVisible()
  const pending=page.waitForEvent('download')
  await button.click()
  const downloaded=await pending
  expect(createHash('sha256').update(await readFile(await downloaded.path())).digest('hex')).toBe(f.sha)
  await noWalletPrompts(page)
})

test('mock paid purchase requires confirmation and cancellation submits nothing',async({page})=>{
  const f=await fixture(page,true)
  await page.goto(f.url)
  const button=page.getByRole('button',{name:/buy|purchase/i}).first()
  await expect(button).toBeEnabled()
  expect(await page.evaluate(()=>window.__purchases)).toBe(0)
  page.once('dialog',async d=>{expect(d.message()).toMatch(/refund/i);await d.dismiss()})
  await button.click()
  expect(await page.evaluate(()=>window.__purchases)).toBe(0)
  page.once('dialog',d=>d.accept())
  await button.click()
  await expect.poll(()=>page.evaluate(()=>window.__purchases)).toBe(1)
})
