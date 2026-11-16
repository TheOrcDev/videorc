import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import type { Reporter, TestModule } from 'vitest/node'

import { toPosixPath } from '../../../scripts/lib/vitest-shards.mjs'

/**
 * Plan 242 S7: writes each test file's whole cost (environment, prepare,
 * collect, setup and run) to a JSON report. Collect is most of the suite's
 * time, so the run time alone would mis-balance the shards. The reports also
 * prove every file ran in exactly one shard (scripts/vitest-shard-report.mjs).
 */
export default class TimingReporter implements Reporter {
  constructor(
    private readonly outFile: string,
    private readonly root: string
  ) {}

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const files: Record<string, number> = {}
    for (const testModule of testModules) {
      const d = testModule.diagnostic()
      files[toPosixPath(relative(this.root, testModule.moduleId))] =
        d.environmentSetupDuration +
        d.prepareDuration +
        d.collectDuration +
        d.setupDuration +
        d.duration
    }
    mkdirSync(dirname(this.outFile), { recursive: true })
    writeFileSync(
      this.outFile,
      `${JSON.stringify({ version: 1, shard: process.env.VIDEORC_VITEST_SHARD ?? null, files }, null, 2)}\n`
    )
  }
}
