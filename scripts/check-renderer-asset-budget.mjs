#!/usr/bin/env node

import { resolve } from 'node:path'

import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  passingCheck,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  evaluateRendererAssetBudget,
  measureEagerRendererAssets
} from './lib/renderer-asset-budget.mjs'

const htmlPath = resolve(
  process.env.VIDEORC_RENDERER_INDEX_HTML ?? 'apps/desktop/out/renderer/index.html'
)
// Calibrated 2026-07-10 after workspace-tab code splitting:
// 1,758,284 raw / ~334 KiB gzip initial JS, with a 1,066,262-byte entry.
// These ceilings retain roughly 8-12% toolchain/hash headroom while rejecting
// the old 1.535 MiB monolithic main entry.
const budget = {
  maxTotalRawBytes: Number(process.env.VIDEORC_RENDERER_MAX_EAGER_RAW_BYTES ?? 1_900_000),
  maxTotalGzipBytes: Number(process.env.VIDEORC_RENDERER_MAX_EAGER_GZIP_BYTES ?? 370_000),
  maxEntryRawBytes: Number(process.env.VIDEORC_RENDERER_MAX_ENTRY_RAW_BYTES ?? 1_200_000),
  maxEntryGzipBytes: Number(process.env.VIDEORC_RENDERER_MAX_ENTRY_GZIP_BYTES ?? 235_000)
}

let measurement = null
let failures = []
try {
  measurement = await measureEagerRendererAssets({ htmlPath })
  failures = evaluateRendererAssetBudget(measurement, budget)
} catch (error) {
  failures = [error.message]
}

const report = createPerformanceReport({
  scenario: 'renderer-initial-asset-budget',
  mode: 'gate',
  metadata: await collectPerformanceMetadata(),
  timing: null,
  metrics: { measurement, budget },
  checks: failures.length
    ? failingChecks(failures)
    : [passingCheck('initial renderer JavaScript stayed inside the versioned budget')]
})
const reportPath = await writePerformanceReport(report)
console.log(`Renderer asset budget report: ${reportPath}`)
if (measurement) {
  console.log(
    `Initial eager JS: ${measurement.totalRawBytes} raw / ${measurement.totalGzipBytes} gzip bytes; entry ${measurement.entryRawBytes} raw / ${measurement.entryGzipBytes} gzip bytes.`
  )
}
if (failures.length) throw new Error(`Renderer asset budget failed:\n${failures.join('\n')}`)
