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

async function connectedDirectory(page) {
  await page.route('**/src/signer-context.tsx', r => r.fulfill({contentType:'text/javascript',body:`export const SignerProvider=({children})=>children;const noop=()=>{};export const useSigner=()=>({active:null,evm:{kind:'injected',address:'0x${'11'.repeat(20)}',chainId:870},setActive:noop,setEvm:noop});`}))
  const source = await readFile(new URL('../../../frontend/src/lib/registry.ts', import.meta.url), 'utf8')
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1])
  await page.route('**/src/lib/registry.ts', r => r.fulfill({contentType:'text/javascript',body:names.map(n=>`export const ${n}=${n==='getEvmBalance'?'async()=>0n':'async()=>[]'};`).join('\n')}))
}

test('disconnected files page shows only the directory connection prompt', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('files-wallet-required')).toBeVisible()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await expect(page.locator('input[type=file]')).toHaveCount(0)
  await expect(page.locator('.files-table')).toHaveCount(0)
  await noWalletPrompts(page)
})

test('first-use guide stays honest with an empty library and a directory account', async ({ page }) => {
  await connectedDirectory(page)
  await page.goto('/')
  const guide = page.getByTestId('first-use-guide')
  await expect(guide).toBeVisible()
  await expect(guide.locator('li')).toHaveCount(4)
  await expect(page.getByRole('button', { name: /import manifest|export recovery|manifest json/i })).toHaveCount(0)
  await expect(page.getByText('Upload plaintext instead')).toHaveCount(0)
  await expect(guide.getByRole('button', {name:'Download and verify',exact:true})).toHaveCount(0)
  await guide.locator('button').first().click()
  await noWalletPrompts(page)
})

test('empty local library with registry entries waits, auto-recovers and never shows the guide', async ({ page }) => {
  const cid = 'bafkreig4wikelzw2pttlm6uzgt7hgfulufzdpmbv4wsyl62amkiecux2he'
  const manifest = {
    version: 2, network: 'mainnet', rootCid: cid,
    file: { name: 'recovered.txt', size: 24, sha256: 'ab'.repeat(32), mimeType: 'text/plain' },
    encryption: null, compression: null, nodes: [],
    txs: [{ txHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32), height: 42 }],
    uploader: { address: '' }, submittedAt: new Date().toISOString(),
    recovery: { manifestCid: cid },
  }
  const entry = { manifestCid: cid, height: 42, name: 'recovered.txt', size: '24', registeredAt: '1', feePaid: '1' }
  // gated fetchEntries makes the checking state observable; recoverManifestFromHint is stubbed (zero consensus RPC)
  await page.addInitScript(() => { window.__delayDirectory = true })
  await page.route('**/src/signer-context.tsx', r => r.fulfill({contentType:'text/javascript',body:`export const SignerProvider=({children})=>children;const noop=()=>{};export const useSigner=()=>({active:null,evm:{kind:'injected',address:'0x${'11'.repeat(20)}',chainId:870},setActive:noop,setEvm:noop});`}))
  const source = await readFile(new URL('../../../frontend/src/lib/registry.ts', import.meta.url), 'utf8')
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1])
  await page.route('**/src/lib/registry.ts', r => r.fulfill({contentType:'text/javascript',body:names.map(n=>`export const ${n}=${n==='getEvmBalance'?'async()=>0n':n==='fetchEntries'?`async()=>{if(window.__delayDirectory)await new Promise(r=>{window.__releaseDirectory=r});return [${JSON.stringify(entry)}]}`:'async()=>[]'};`).join('\n')}))
  await page.route('**/src/chain-context.tsx', r => r.fulfill({contentType:'text/javascript',body:'export const ChainProvider=({children})=>children; const connect=async()=>({}); export const useChain=()=>({connect});'}))
  await page.route('**/src/lib/manifestRecover.ts', r => r.fulfill({contentType:'text/javascript',body:`export async function recoverManifestFromHint(){return ${JSON.stringify(manifest)}}`}))
  await page.goto('/')
  // check unsettled: the waiting card is visible, the first-use guide never appears (unresolved does not mean new)
  const check = page.getByTestId('directory-check')
  await expect(check).toBeVisible()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await page.evaluate(() => window.__releaseDirectory())
  // auto recovery settled: the file row appears, the waiting card disappears, no guide and no wallet requests throughout
  await expect(page.locator('.files-table tr').filter({hasText:'recovered.txt'})).toBeVisible()
  await expect(check).toHaveCount(0)
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await noWalletPrompts(page)
})

test('failing directory check shows an explicit retry instead of the guide', async ({ page }) => {
  await connectedDirectoryWithFailure(page)
  await page.goto('/')
  const check = page.getByTestId('directory-check')
  await expect(check).toBeVisible()
  await expect(check).toContainText('registry RPC rate limited')
  await expect(check.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await noWalletPrompts(page)
})

// stubs every registry.ts export, but fetchEntries throws (honest presentation of a failed directory check)
async function connectedDirectoryWithFailure(page) {
  await page.route('**/src/signer-context.tsx', r => r.fulfill({contentType:'text/javascript',body:`export const SignerProvider=({children})=>children;const noop=()=>{};export const useSigner=()=>({active:null,evm:{kind:'injected',address:'0x${'11'.repeat(20)}',chainId:870},setActive:noop,setEvm:noop});`}))
  const source = await readFile(new URL('../../../frontend/src/lib/registry.ts', import.meta.url), 'utf8')
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1])
  await page.route('**/src/lib/registry.ts', r => r.fulfill({contentType:'text/javascript',body:names.map(n=>`export const ${n}=${n==='getEvmBalance'?'async()=>0n':n==='fetchEntries'?'async()=>{throw new Error(\'registry RPC rate limited\')}':'async()=>[]'};`).join('\n')}))
}

test('invalid share links stay on a visible error page without wallet prompts', async ({ page }) => {
  await page.goto('/#/s?m=not-a-cid&h=-1&o=bad&k=bad')
  await expect(page.locator('main')).toContainText(/invalid|not a valid/i)
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await noWalletPrompts(page)
})

test('opening Share and Messages does not request a public key or send a transaction', async ({ page }) => {
  await page.goto('/')
  const nav = page.locator('nav.tabs button')
  // Discover sits right after Files: Share is now index 2, Messages index 3
  await nav.nth(2).click()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await nav.nth(3).click()
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

test('fee estimate is hidden without a wallet and a selected file', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('funding-status')).toHaveCount(0)
  await noWalletPrompts(page)
})

// ownership scoping: the file table lists only the connected account's files;
// another account's files are not rendered at all; files with no ownership
// info go to the claimable unowned group.
test('files list is scoped to the connected account with a claimable unowned group', async ({ page }) => {
  await connectedDirectory(page)
  await page.goto('/')
  await page.evaluate(async () => {
    const store = await import('/src/lib/store.ts')
    const mk = (rootCid, name, uploader) => ({ version: 2, network: 'mainnet', rootCid, file: {name, size: 1, sha256: '00'.repeat(32), mimeType: 'text/plain'}, encryption: null, compression: null, nodes: [], txs: [], uploader: {address: uploader}, submittedAt: new Date().toISOString() })
    await store.putManifest(mk('scope-mine', 'mine.txt', ''))
    await store.putManifest(mk('scope-other', 'other.txt', ''))
    await store.putManifest(mk('scope-unclaimed', 'unclaimed.txt', ''))
    await store.putMeta('fileOwner:scope-mine', '0x' + '11'.repeat(20))
    await store.putMeta('fileOwner:scope-other', '0x' + '22'.repeat(20))
  })
  await page.reload()
  await expect(page.locator('.files-table tr').filter({hasText: 'mine.txt'})).toBeVisible()
  await expect(page.locator('.files-table tr').filter({hasText: 'other.txt'})).toHaveCount(0)
  const unowned = page.getByTestId('unowned-files')
  await expect(unowned).toBeVisible()
  await unowned.locator('summary').click() // collapsed details — expand before interacting
  await expect(unowned.locator('tr').filter({hasText: 'unclaimed.txt'})).toBeVisible()
  await unowned.getByRole('button', {name: 'Claim', exact: true}).click()
  await expect(page.locator('.files-table tr').filter({hasText: 'unclaimed.txt'})).toBeVisible()
  await expect(page.getByTestId('unowned-files')).toHaveCount(0)
  await noWalletPrompts(page)
})

test('unfinished directory reminder survives reload without resubmitting an upload', async ({ page }) => {
  await connectedDirectory(page)
  await page.goto('/')
  await page.evaluate(async () => {
    const store = await import('/src/lib/store.ts')
    await store.putManifest({ version: 2, network: 'mainnet', rootCid: 'fixture-unfinished', file: {name:'pending-backup.txt',size:1,sha256:'00'.repeat(32),mimeType:'text/plain'}, encryption:null, nodes:[], txs:[], compression:null,uploader:{address:''}, submittedAt:new Date().toISOString() })
    // ownership stamp: with the account-scoped list, unstamped files land in the unowned group instead of the table
    await store.putMeta('fileOwner:fixture-unfinished', '0x' + '11'.repeat(20))
  })
  await page.reload()
  const reminder = page.getByTestId('unfinished-storage')
  await expect(reminder).toBeVisible()
  const row = page.locator('tr').filter({hasText:'pending-backup.txt'})
  await expect(row.getByRole('img', {name:'Incomplete · index pending',exact:true})).toBeVisible()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  await expect(row.getByRole('button', {name:'Continue saving file',exact:true})).toBeEnabled()
  await expect(row.getByRole('button', {name:'Download',exact:true})).toHaveCount(0)
  const hash = row.getByRole('button', {name:/000000000000…00000000/})
  await expect(hash).toBeVisible()
  await hash.click()
  const fullHash = row.getByRole('button', {name:'00'.repeat(32),exact:true})
  await expect(fullHash).toBeVisible()
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.__copiedHash=value}}}) })
  await fullHash.click()
  await expect(row).toContainText('Hash copied')
  expect(await page.evaluate(() => window.__copiedHash)).toBe('00'.repeat(32))
  await expect(page.getByRole('button', {name:'Download and verify',exact:true})).toHaveCount(0)
  await noWalletPrompts(page)
})


test('each wallet step requires its own click and cancellation stops the sequence', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js')
    const React = reactModule.default ?? reactModule
    const domModule = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { createRoot } = domModule.default ?? domModule
    const { useWalletStep } = await import('/src/pages/WalletStep.tsx')
    window.__stepCalls = []
    function Harness() {
      const { runWalletAction, walletStep } = useWalletStep()
      const run = async () => {
        try {
          for (const label of ['Unlock 1/2', 'Unlock 2/2', 'Save file and recovery', 'Register directory']) {
            await runWalletAction(label, `Purpose: ${label}`, async () => { window.__stepCalls.push(label) })
          }
        } catch { window.__stepCalls.push('cancelled') }
      }
      return React.createElement('div', null, React.createElement('button', { onClick: run }, 'Start steps'), walletStep)
    }
    const host = document.createElement('div')
    document.body.append(host)
    createRoot(host).render(React.createElement(Harness))
  })
  await page.getByRole('button', { name: 'Start steps', exact: true }).click()
  const card = page.getByTestId('wallet-step')
  await expect(card.getByText('Purpose: Unlock 1/2')).toBeVisible()
  expect(await page.evaluate(() => window.__stepCalls)).toEqual([])
  const labels = ['Unlock 1/2', 'Unlock 2/2', 'Save file and recovery']
  for (let i = 0; i < labels.length; i++) {
    await card.getByRole('button', { name: labels[i], exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__stepCalls)).toEqual(labels.slice(0, i + 1))
  }
  await expect(card.getByRole('button', { name: 'Register directory', exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(await page.evaluate(() => window.__stepCalls)).toEqual([...labels, 'cancelled'])
})
