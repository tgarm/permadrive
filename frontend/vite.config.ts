import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    // @autonomys/auto-dag-data → @autonomys/asynchronous → stream-fork depends
    // on the Node stream ecosystem (CJS), so the browser side needs polyfills
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: {
    // static deploy target (IPFS / GitHub Pages): relative asset paths
    base: './',
  },
})
