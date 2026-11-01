import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Real Files/Upload UI, DAG, encryption, publish orchestration and IndexedDB.
// Wallets, registry, indexer and chain transport are mocked; no network transactions.
async function storageFixture(page) {
  await page.addInitScript(() => { localStorage.setItem('locale', 'en') })
  const route = (pattern, body) => page.route(pattern, (r) => r.fulfill({ contentType: 'text/javascript', body }))
  const mockChain = `
    const transactions = new Map(); let submitted = null;
    const hash = n => '0x'+BigInt(n).toString(16).padStart(64,'0');
    const block = h => ({block:{extrinsics:h===50 && submitted?[transactions.get(submitted)]:[],header:{parentHash:{toHex:()=>hash(h-1)},number:{toNumber:()=>h}}}});
    const wrap = (method,args) => {
      const id=hash(100+transactions.size);
      const tx={method:{section:method==='remark'?'system':'utility',method,args},args,hash:{toHex:()=>id},toHex:()=>id,
        signAsync:async()=>{localStorage.setItem('consensusSigns',String(Number(localStorage.getItem('consensusSigns')||0)+1));if(window.__delaySign)await new Promise((resolve,reject)=>{window.__releaseSign=resolve;window.__rejectSign=()=>reject(new Error('Fixture signature rejected'))})}};
      transactions.set(id,tx);return tx;
    };
    const api={
      query:{transactionFees:{transactionByteFee:async()=>({toJSON:()=>({current:'2000000000000'})})},system:{account:async()=>({toJSON:()=>({data:{free:'100000000000000000000',frozen:'0'}})})}},
      rpc:{system:{chain:async()=>({toString:()=> 'Autonomys Mainnet'}),accountNextIndex:async()=>{if(window.__delayNonce)await new Promise(resolve=>{window.__releaseNonce=resolve});return {toNumber:()=>0}}},
        chain:{getHeader:async()=>({number:{toNumber:()=>submitted?70:50}}),getBlockHash:async h=>({toHex:()=>hash(h)}),getBlock:async h=>block(Number(BigInt(typeof h==='string'?h:h.toHex())))},
        author:{submitExtrinsic:async id=>{if(window.__delaySubmit)await new Promise(resolve=>{window.__releaseSubmit=resolve});submitted=id;localStorage.setItem('consensusSubmits',String(Number(localStorage.getItem('consensusSubmits')||0)+1))}}},
      tx:{system:{remark:payload=>{const skip=[1,2,4][payload[0]&3];return wrap('remark',[payload.slice(skip)])}},
        utility:{batch:calls=>wrap('batch',[calls.map(c=>c.method)]),batchAll:calls=>wrap('batchAll',[calls.map(c=>c.method)])}}
    };
    export const ChainProvider=({children})=>children;
    const connect=async()=>api;
    export const useChain=()=>({status:'ready',connect});
  `
  await route('**/src/chain-context.tsx', mockChain)
  await route('**/src/signer-context.tsx', `
    export const SignerProvider=({children})=>children;
    const active={kind:'local',address:'fixture-consensus',pair:{},label:'Test consensus'};
    const evm={kind:'injected',address:'0x${'11'.repeat(20)}',chainId:870,label:'Test EVM'};
    const noop=()=>{};
    export const useSigner=()=>({active:localStorage.getItem('evmOnly')?null:active,evm:localStorage.getItem('disconnectEvm')?null:evm,setActive:noop,setEvm:noop});
  `)
  async function stub(file, overrides) {
    const src = await readFile(new URL('../../../frontend/src/lib/' + file, import.meta.url), 'utf8')
    const names = [...src.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1])
    await route('**/src/lib/' + file, names.map((n) => `export const ${n}=${overrides[n] ?? 'async()=>null'};`).join('\n'))
  }
  await stub('vault.ts', { signEvmMessage: `async()=>{localStorage.setItem('messageSigns',String(Number(localStorage.getItem('messageSigns')||0)+1));return new Uint8Array(65).fill(9)}` })
  await stub('registry.ts', {
    fetchEntries: `async()=>JSON.parse(localStorage.getItem('chainEntries')||'[]')`,
    quoteRegisterFee: 'async()=>{if(window.__delayFee)await new Promise(resolve=>{window.__releaseFee=resolve});return 10000000000000000n}',
    getEvmBalance: 'async()=>100000000000000000000n',
    registryPublicClient: '()=>({getGasPrice:async()=>1n})',
    registerFile: `async(signer,args)=>{
      if(window.__delayRegister)await new Promise(resolve=>{window.__releaseRegister=resolve});
      localStorage.setItem('registerCalls',String(Number(localStorage.getItem('registerCalls')||0)+1));
      localStorage.setItem('chainEntries',JSON.stringify([{...args,height:Number(args.height)}]));
      if(localStorage.getItem('failAfterRegister'))throw new Error('Receipt response lost');
      return {alreadyRegistered:false,txHash:'0x'+'aa'.repeat(32)};
    }`,
  })
  await stub('publicPublisher.ts', { DUST_PRICE: '10000000000000n', publicPublisherActive: '()=>false' })
  await stub('sales.ts', { salesActive: '()=>false' })
  await route('**/src/lib/indexer.ts', 'export class IndexerClient{async pollUntilIndexed(hashes){return {found:new Map(hashes.map(h=>[h,{}])),pending:[]}}close(){}}')
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort())
}

async function uploadToDirectoryGate(page) {
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({ name: 'combined-browser.txt', mimeType: 'text/plain', buffer: Buffer.from('combined upload fixture\n') })
  await page.getByRole('button', { name: 'Prepare and review wallet steps', exact: true }).click()
  const gate = page.getByTestId('wallet-step')
  await expect(gate.getByRole('button', { name: 'Wallet unlock signature 1/2', exact: true })).toBeVisible()
  await gate.getByRole('button', { name: 'Wallet unlock signature 1/2', exact: true }).click()
  await expect(gate.getByRole('button', { name: 'Wallet unlock signature 2/2', exact: true })).toBeVisible()
  expect(await page.evaluate(() => Number(localStorage.getItem('messageSigns')))).toBe(1)
  await gate.getByRole('button', { name: 'Wallet unlock signature 2/2', exact: true }).click()
  await expect(gate.getByRole('button', { name: 'Pay and permanently save file and recovery information', exact: true })).toBeVisible()
  expect(await page.evaluate(() => Number(localStorage.getItem('consensusSigns')))).toBe(0)
  await expect(gate).toContainText('Storage fees already paid cannot be refunded')
  await gate.getByRole('button', { name: 'Pay and permanently save file and recovery information', exact: true }).click()
  await expect(gate.getByRole('button', { name: 'Pay and register file directory', exact: true })).toBeVisible()
  expect(await page.evaluate(() => [Number(localStorage.getItem('messageSigns')), Number(localStorage.getItem('consensusSigns')), Number(localStorage.getItem('consensusSubmits')), Number(localStorage.getItem('registerCalls'))])).toEqual([2, 1, 1, 0])
  await expect(page.getByTestId('unfinished-storage-warning')).toContainText('browser data corruption')
  return gate
}

test('combined storage uses four explicit confirmations and resumes with only EVM after reload', async ({ page }) => {
  await storageFixture(page)
  const gate = await uploadToDirectoryGate(page)
  await gate.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(() => localStorage.setItem('evmOnly', '1'))
  await page.reload()
  const unfinished = page.getByTestId('unfinished-storage')
  await expect(page.locator('tr').filter({hasText:'combined-browser.txt'}).getByRole('img', {name:'Incomplete · index pending',exact:true})).toBeVisible()
  await expect(page.getByTestId('unfinished-storage-warning')).toBeVisible()
  await page.evaluate(() => {window.__delayRegister=true})
  await page.getByRole('button', {name:'Continue saving file',exact:true}).click()
  await expect(page.locator('tr').filter({hasText:'combined-browser.txt'}).getByRole('button', {name:'Processing…',exact:true})).toBeDisabled()
  await expect.poll(() => page.evaluate(() => typeof window.__releaseRegister)).toBe('function')
  await expect(page.getByTestId('wallet-step')).toHaveCount(0)
  await page.evaluate(() => window.__releaseRegister())
  await expect(unfinished).toHaveCount(0)
  await expect(page.locator('tr').filter({hasText:'combined-browser.txt'}).getByRole('img', {name:'Complete',exact:true})).toBeVisible()
  await expect(page.getByTestId('first-use-guide')).toHaveCount(0)
  const details = page.locator('tr').filter({hasText:'combined-browser.txt'}).locator('.file-details')
  await expect(details.locator('dl')).toBeHidden()
  await details.locator('summary').click()
  await expect(details.locator('dl')).toContainText('File index')
  await expect(page.getByRole('button', {name:'Download',exact:true})).toBeVisible()
  expect(await page.evaluate(() => [Number(localStorage.getItem('messageSigns')), Number(localStorage.getItem('consensusSigns')), Number(localStorage.getItem('consensusSubmits')), Number(localStorage.getItem('registerCalls'))])).toEqual([2, 1, 1, 1])
  await page.evaluate(() => localStorage.setItem('disconnectEvm', '1'))
  await page.reload()
  await expect(page.getByTestId('unfinished-storage')).toHaveCount(0)
})

test('a confirmed directory write with lost local completion is read back without a second wallet request', async ({ page }) => {
  await storageFixture(page)
  const gate = await uploadToDirectoryGate(page)
  await page.evaluate(() => localStorage.setItem('failAfterRegister', '1'))
  await gate.getByRole('button', { name: 'Pay and register file directory', exact: true }).click()
  await expect(page.locator('tr').filter({hasText:'combined-browser.txt'})).toContainText('Receipt response lost')
  await page.reload()
  await page.getByRole('button', {name:'Continue saving file',exact:true}).click()
  await expect(page.getByTestId('unfinished-storage')).toHaveCount(0)
  await expect(page.getByTestId('wallet-step')).toHaveCount(0)
  expect(await page.evaluate(() => Number(localStorage.getItem('registerCalls')))).toBe(1)
})


async function legacyStorageGate(page) {
  await storageFixture(page)
  await page.goto('/')
  await page.evaluate(async () => {
    const { prepareUpload } = await import('/src/lib/publish.ts')
    const { putManifest } = await import('/src/lib/store.ts')
    const file = await prepareUpload(new File(['legacy upload'], 'legacy-resume.txt'))
    await putManifest({ version:2,network:'mainnet',rootCid:file.rootCid,file:file.file,encryption:null,compression:null,uploader:{address:'fixture-consensus'},nodes:file.nodes.map(n=>({cid:n.cid,blake3:n.blake3,bytes:n.bytes.length})),txs:[{txHash:'0x'+'bb'.repeat(32),blockHash:'0x'+'cc'.repeat(32),height:40}],submittedAt:new Date().toISOString() })
  })
  await page.reload()
  await page.getByRole('button', {name:'Continue saving file',exact:true}).click()
  const gate = page.getByTestId('wallet-step')
  await expect(gate.getByRole('button', {name:'Pay and save recovery information',exact:true})).toBeVisible()
  return gate
}

test('recovery payment stays visible and busy before the wallet, during signing and during submission', async ({ page }) => {
  const gate = await legacyStorageGate(page)
  await page.evaluate(() => {window.__delayNonce=true;window.__delaySign=true;window.__delaySubmit=true})
  await gate.getByRole('button', {name:'Pay and save recovery information',exact:true}).click()
  const processing = gate.getByRole('button', {name:/Pay and save recovery information.*Processing/})
  await expect(processing).toBeDisabled()
  await expect(processing).toHaveAttribute('aria-busy','true')
  await expect(gate).toHaveAttribute('data-status','waiting')
  await expect.poll(() => page.evaluate(() => typeof window.__releaseNonce)).toBe('function')
  expect(await page.evaluate(() => Number(localStorage.getItem('consensusSigns')))).toBe(0)
  await page.evaluate(() => window.__releaseNonce())
  await expect.poll(() => page.evaluate(() => typeof window.__releaseSign)).toBe('function')
  await expect(processing).toBeDisabled()
  await page.evaluate(() => window.__releaseSign())
  await expect.poll(() => page.evaluate(() => typeof window.__releaseSubmit)).toBe('function')
  await expect(processing).toBeDisabled()
  await expect(gate).toBeVisible()
  expect(await page.evaluate(() => Number(localStorage.getItem('consensusSigns')))).toBe(1)
  await page.evaluate(() => window.__releaseSubmit())
  await expect(gate.getByRole('button', {name:'Pay and register file directory',exact:true})).toBeEnabled()
  await gate.getByRole('button', {name:'Cancel',exact:true}).click()
})

test('rejecting the wallet leaves an explicit failed step and does not resubmit', async ({ page }) => {
  const gate = await legacyStorageGate(page)
  await page.evaluate(() => {window.__delaySign=true})
  await gate.getByRole('button', {name:'Pay and save recovery information',exact:true}).click()
  await expect.poll(() => page.evaluate(() => typeof window.__rejectSign)).toBe('function')
  await page.evaluate(() => window.__rejectSign())
  await expect(gate).toHaveAttribute('data-status','error')
  await expect(gate.getByRole('alert')).toContainText('Fixture signature rejected')
  await expect(gate.getByRole('button', {name:/Pay and save recovery information.*Not completed/})).toBeDisabled()
  expect(await page.evaluate(() => Number(localStorage.getItem('consensusSubmits')))).toBe(0)
  await gate.getByRole('button', {name:'Close',exact:true}).click()
  await expect(gate).toHaveCount(0)
})


test('resume exposes a stalled preflight and ignores its late result', async ({ page }) => {
  await storageFixture(page)
  const gate = await uploadToDirectoryGate(page)
  await gate.getByRole('button', {name:'Cancel',exact:true}).click()
  await page.reload()
  await page.evaluate(() => { window.__delayFee = true })
  await page.clock.install()
  const events = []
  page.on('console', message => { if(message.text().includes('[PermaDrive save]')) events.push(message.text()) })
  await page.getByRole('button', {name:'Continue saving file',exact:true}).click()
  await expect(page.getByTestId('save-progress')).toContainText('Reading directory fee')
  await page.clock.fastForward(61_000)
  const row = page.locator('tr').filter({hasText:'combined-browser.txt'})
  await expect(row).toContainText('This check timed out')
  await expect(row.getByRole('button', {name:'Continue saving file',exact:true})).toBeEnabled()
  await page.evaluate(() => window.__releaseFee())
  await expect(page.getByTestId('wallet-step')).toHaveCount(0)
  expect(await page.evaluate(() => Number(localStorage.getItem('registerCalls')))).toBe(0)
  expect(events.some(message => message.includes('fee: start'))).toBe(true)
  expect(events.some(message => message.includes('fee: stopped'))).toBe(true)
})
