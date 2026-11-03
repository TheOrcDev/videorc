import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Lightweight unit-test runner for pure desktop logic (no electron, no DOM). Component
// behavior is exercised through pure modules in src/renderer/src/lib.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    // Node 25+ ships a global `localStorage` (Web Storage) that is undefined
    // without `--localstorage-file` and shadows jsdom's, so every DOM test
    // that touches storage throws. Turn it off in the workers; Node 24 accepts
    // the flag too.
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] }
    },
    include: ['src/main/**/*.test.ts', 'src/renderer/src/**/*.test.ts', 'src/shared/**/*.test.ts']
  }
})
