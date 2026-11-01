# Browser regression

Run from `scripts/verify`:

```sh
npm install
npx playwright install chromium
npx playwright test --config browser/playwright.config.mjs
```

The suite starts the selected tree's local Vite server. Use `PD_BASE_URL` to test an already running build. Each test has an isolated browser profile and an injected wallet sentinel: opening pages must not request keys, signatures or transactions.

For a real wallet-free public download, provide `PD_PUBLIC_SHARE_URL` and `PD_PUBLIC_SHA256`. Without a fixture the download test is explicitly skipped. This read-only test needs working public RPCs. A skip is not acceptance evidence.

Paid purchases and upload broadcasts are deliberately not enabled against mainnet by this browser suite. Their protocol integration is covered by the existing acceptance runner; browser confirmation/paid-state tests and real extension compatibility remain separate acceptance items. Never configure a funded wallet or paste a mnemonic into this suite.

The default suite additionally mocks only chain transport and signing boundaries to exercise real WebCrypto public-file download and the paid purchase confirmation/cancellation UI. These are UI integration checks, not mainnet purchase evidence.
