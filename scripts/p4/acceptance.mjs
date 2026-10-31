// P4 · DirectSales on-chain acceptance runner — thin CLI wrapper (real transport injected).
// Orchestration lives in lib/acceptance-core.mjs (runner-hardening notes: the escrow-era
// infrastructure carries over; the direct-sales path rework is documented in its file
// header); offline fault-injection tests: acceptance-test.mjs.
//
//   node acceptance.mjs preflight [--skip-tests]      # read-only preflight (incl. legacy
//                                                     # paywall inventory), zero cost
//   node acceptance.mjs run    --run-id <id> --cap 0.1 [--paths d1,d2,a] [--price 0.01]
//   node acceptance.mjs resume --run-id <id>          # resume from the journal (verifies
//                                                     # frozen-input consistency)
//   node acceptance.mjs report --run-id <id>          # recompute report.json + summary.md
//                                                     # only (gates identical to finish)
//
// Paths: d1 = normal direct purchase/delivery/key-grade download/rating change
// (test instance); d2 = failed purchase rolls back atomically (test instance, zero
// deals and zero fund movement); a = production instance, real file + real Mailbox
// delivery + rating.
//
// Exit codes: 0 all mandatory paths pass; 1 definite failure; 2 blocked / unknown /
// incomplete; 3 waiting for on-chain time.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { autoEvm, clients, DEPLOYMENTS, loadMnemonic } from '../p3/lib/chain.mjs'
import { connectApi, extractRemarkNodes, srPairFromMnemonic } from '../poc/lib/chain.mjs'
import { REGISTRY_ABI } from '../../frontend/src/lib/registry-abi.ts'
import { Exit, createRunner } from './lib/acceptance-core.mjs'

// ---------- CLI ----------

const ROOT = new URL('../../', import.meta.url).pathname
// DirectSales keeps its own record directory (isolated from the escrow-era out/acceptance)
const OUT_BASE = path.join(ROOT, 'scripts/p4/out/acceptance-direct-sales')
const SALES_ARTIFACT = path.join(ROOT, 'contracts/out/DirectSales.json')
const MAILBOX_ARTIFACT = path.join(ROOT, 'contracts/out/Mailbox.json')
const CONSENSUS_RPC = process.env.CHAIN_RPC ?? 'https://rpc.mainnet.subspace.foundation/ws'

const COMMIT = (() => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}
const hasFlag = (name) => argv.includes(`--${name}`)

const artifactSales = JSON.parse(readFileSync(SALES_ARTIFACT, 'utf8'))
const mailboxArtifact = JSON.parse(readFileSync(MAILBOX_ARTIFACT, 'utf8'))

const OFFLINE_TESTS = [
  ['direct-sales-test', 'scripts/p4/direct-sales-test.mjs'],
  ['paywall-v2-test', 'scripts/p4/paywall-v2-test.mjs'],
  ['acceptance-runner-test', 'scripts/p4/acceptance-test.mjs'],
  ['file-crypto-selftest', 'scripts/p4/file-crypto-selftest.mjs'],
  ['vault-crypto-selftest', 'scripts/p3/vault-crypto-selftest.mjs'],
  ['paywall-guard-test', 'scripts/verify/paywall-guard-test.mjs'],
  ['publish-error-test', 'scripts/verify/publish-error-test.mjs'],
  ['mailbox-store-test', 'scripts/verify/mailbox-store-test.mjs'],
  ['rpc-pacer-test', 'scripts/verify/rpc-pacer-test.mjs'],
]

// If Auto-EVM lacks EIP-1559 fee fields, prepareTransactionRequest may fail on fee
// estimation — fall back to a legacy gasPrice request (estimation reverts still
// propagate = definitely not broadcast).
function withLegacyFeeFallback(c) {
  const orig = c.publicClient.prepareTransactionRequest.bind(c.publicClient)
  c.publicClient.prepareTransactionRequest = async (args) => {
    try {
      return await orig(args)
    } catch (e) {
      if (!/maxPriorityFee|priorityFee|1559|estimateFeesPerGas|gasPrice/i.test(String(e?.message ?? e))) throw e
      const { account, to, data, value } = args
      const [gas, gasPrice, nonce, chainId] = await Promise.all([
        c.publicClient.estimateGas({ account, to, data, value }),
        c.publicClient.getGasPrice(),
        c.publicClient.getTransactionCount({ address: account.address }),
        c.publicClient.getChainId(),
      ])
      return { account, to, data, value, gas, gasPrice, nonce, chainId, type: 'legacy' }
    }
  }
  return c
}

const A = withLegacyFeeFallback(clients(0)) // seller / owner / treasury / Registry registrant / consensus publisher (same mnemonic)
const C = withLegacyFeeFallback(clients(2)) // buyer (separate address; index 1 is reserved for the historical adversarial scripts)

const runner = createRunner({
  A, C,
  abis: artifactSales.abi,
  mailboxAbis: mailboxArtifact.abi,
  registryAbi: REGISTRY_ABI,
  artifactSales,
  deployments: JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')),
  consensus: {
    connect: async () => ({
      api: await connectApi(CONSENSUS_RPC),
      pair: await srPairFromMnemonic(loadMnemonic()),
    }),
    extract: extractRemarkNodes,
  },
  OUT_BASE,
  ROOT,
  COMMIT,
  offlineTests: OFFLINE_TESTS,
  spawnOffline: spawnSync,
})

// ---------- main ----------

try {
  if (cmd === 'preflight') {
    const { exitCode } = await runner.preflight({ skipTests: hasFlag('skip-tests') })
    process.exitCode = exitCode
  } else if (cmd === 'run') {
    const { exitCode } = await runner.runOrResume(false, {
      runId: flag('run-id'), cap: flag('cap'), price: flag('price'), paths: flag('paths'),
    })
    process.exitCode = exitCode
  } else if (cmd === 'resume') {
    const { exitCode } = await runner.runOrResume(true, { runId: flag('run-id') })
    process.exitCode = exitCode
  } else if (cmd === 'report') {
    const { exitCode } = await runner.reportOnly({ runId: flag('run-id') })
    process.exitCode = exitCode
  } else {
    console.log('usage: node acceptance.mjs preflight [--skip-tests] | run --run-id <id> --cap <AI3> [--paths d1,d2,a] [--price 0.01] | resume --run-id <id> | report --run-id <id>')
    process.exitCode = 2
  }
} catch (e) {
  if (e instanceof Exit) {
    console.error(`\n✗ ${e.message}`)
    process.exitCode = e.code
  } else {
    console.error('\n✗ unexpected error:', e)
    process.exitCode = 1
  }
}
