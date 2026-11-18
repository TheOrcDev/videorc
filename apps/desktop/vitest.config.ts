import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

import { DESKTOP_VITEST_INCLUDE } from '../../scripts/lib/vitest-shards.mjs'
import TimingReporter from './vitest/timing-reporter'
import TimingSequencer from './vitest/timing-sequencer'

const root = fileURLToPath(new URL('.', import.meta.url))
// Plan 242 S7: CI shards set VIDEORC_VITEST_REPORT so each shard writes its
// files and their times (scripts/vitest-shard-report.mjs checks and merges).
const reportFile = process.env.VIDEORC_VITEST_REPORT

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
    include: [...DESKTOP_VITEST_INCLUDE],
    // `--shard=k/n` splits by recorded time (vitest-timings.json), not file count.
    sequence: { sequencer: TimingSequencer },
    ...(reportFile
      ? {
          reporters: [
            'default',
            ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
            new TimingReporter(resolve(reportFile), root)
          ]
        }
      : {})
  }
})
