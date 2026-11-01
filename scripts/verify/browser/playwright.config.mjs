import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.', testMatch: '*.spec.mjs', workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.PD_BASE_URL || 'http://127.0.0.1:5198', acceptDownloads: true },
  webServer: process.env.PD_BASE_URL ? undefined : {
    command: 'npm run dev --prefix ../../frontend -- --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198', reuseExistingServer: false, timeout: 60_000,
    cwd: new URL('../', import.meta.url).pathname,
  },
})
