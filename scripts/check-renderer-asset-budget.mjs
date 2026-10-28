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
// Recalibrated 2026-08-29 after the capture-decay/session-lifecycle hardening
// grew the eager bundle to 1,951,766 raw / 375,456 gzip. The added bytes are
// Studio provider correctness logic rather than a newly eager dependency; the
// rounded ceilings retain the same ~2.5% challenge margin. Entry ceilings stay
// unchanged so an accidental dashboard collapse into the main entry still fails.
// Recalibrated 2026-09-25: Linux CPU/BMP proof present-policy helper
// (compositorStatusCanDriveProofScene) + Studio wiring tipped CI Linux gzip to
// 385,123 against the 385,000 ceiling. Prefer keeping the proof-path honesty in
// the eager Studio chunk over a split for ~123 bytes; raise gzip with the same
// ~2.5% challenge margin. Prefer re-splitting if this trips again on net-new UI.
// Recalibrated 2026-10-23: main measured 389,804 gzip (196 bytes of headroom)
// and the Screen None intent (release test 146, plan 0002: reconcile, scene
// visuals, live confirmations) is Studio correctness logic of ~300 gzip bytes,
// tipping it to 390,086. Raise gzip to 395,000 (~1.3%); keep re-splitting the
// answer for net-new UI.
// Recalibrated 2026-10-25 (Linux retests 148 and 150): main measured 394,848
// gzip (152 bytes of headroom). Two Studio correctness fixes need eager bytes:
// the source pickers stay live while only the Clips buffer runs (~700 bytes)
// and a start waits with plain copy when the scene shows a source turned off
// (~280 bytes). Raise gzip to 400,000 (~1.3%); keep re-splitting the answer
// for net-new UI.
// Recalibrated 2026-10-27 (plan 203 S5): main measured 399,287 gzip (713 bytes
// of headroom) and first-run setup's shell state (the surface switch, the
// replay opener, the preview and global-key gate in the provider, ~790 bytes)
// takes it to 400,072. The setup UI itself is lazy (its chunk is 308 KB raw,
// ~43 KB gzip). Raise gzip to 405,000 (~1.2%); keep re-splitting the answer
// for net-new UI.
// Recalibrated 2026-10-27 (plan 207): main measured 1,996,019 raw (3,981
// bytes of headroom). Setup's steps add 6,695 raw bytes of shell and Studio
// state: the record's step and goal (~1.9 KB), the provider applying a look
// as state or holding it behind a running session (~2.8 KB), Clips waiting
// for a chosen screen (~0.6 KB) and the shell's step wiring (~0.8 KB). The
// step UI and the look's helpers are lazy (setup's chunk is 357 KB raw).
// Raise raw to 2,030,000 (~1.4%); keep re-splitting the answer for net-new UI.
// Recalibrated 2026-10-28 (plan 209, Videorc MCP): main measured 404,071 gzip
// (929 bytes of headroom). The agents' Studio wiring needs ~1.9 KB of eager
// gzip: the Go Live path the dialog and agents share, the agent intent lane
// and its cancel handles, the agent surface input and the notices watcher's
// mount. Executors, the surface publisher, the headless Go Live, the Agents
// settings and the Connect dialog are lazy. Measured 405,989. Raise gzip to
// 410,000 (~1.2%); keep re-splitting the answer for net-new UI.
const budget = {
  maxTotalRawBytes: Number(process.env.VIDEORC_RENDERER_MAX_EAGER_RAW_BYTES ?? 2_030_000),
  maxTotalGzipBytes: Number(process.env.VIDEORC_RENDERER_MAX_EAGER_GZIP_BYTES ?? 410_000),
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
