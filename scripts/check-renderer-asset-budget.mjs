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
// Calibrated 2026-07-10 after workspace-tab code splitting (1,758,284 raw /
// ~334 KiB gzip, 1,066,262-byte entry; ceilings kept 8-12% headroom).
// Recalibrated 2026-07-12: the audio-mixer rework (#80), standalone docked
// preview (#78), and the vertical scene work (#87, #88) grew the eager
// bundle to 1,901,844 raw / 364,060 gzip — the raw ceiling now keeps a
// deliberately TIGHT ~2.5% headroom so further eager growth gets challenged;
// the gzip ceilings were still honest and stay unchanged. If this trips
// again, prefer re-splitting the Studio dashboard chunks over bumping.
const budget = {
  maxTotalRawBytes: Number(process.env.VIDEORC_RENDERER_MAX_EAGER_RAW_BYTES ?? 1_950_000),
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
