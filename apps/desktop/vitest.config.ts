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
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/main/**/*.test.ts', 'src/renderer/src/**/*.test.ts', 'src/shared/**/*.test.ts']
  }
})
