#!/usr/bin/env node
// Plan 178 U15 step 1. Proposes config/live-lab/thresholds.v2.json (mode gate)
// from the report-only runs in the lab's run folders:
//
//   node scripts/live-lab/calibrate.mjs [--runs-dir <dir>] [--out <path>] [--dry-run]
//
// Prints the proposal as a markdown table for the owner's review PR. Exit 0
// when a proposal was written (or printed with --dry-run), 2 when there is not
// enough data yet (fewer than 14 days) or on a usage error.

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { calibrate, formatCalibration, readVerdicts } from './lib/calibrate.mjs'
import { workDir } from './lib/config.mjs'
import { DEFAULT_THRESHOLDS_PATH, loadThresholds } from './lib/verdict.mjs'

const DEFAULT_OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config',
  'live-lab',
  'thresholds.v2.json'
)

let values
try {
  ;({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'runs-dir': { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }
    },
    strict: true
  }))
} catch (error) {
  console.error(
    `usage: ${error.message}\nnode scripts/live-lab/calibrate.mjs [--runs-dir <dir>] [--out <path>] [--dry-run]`
  )
  process.exit(2)
}

const runsDir = values['runs-dir'] ?? join(workDir(), 'runs')
const verdicts = await readVerdicts(runsDir)
const result = calibrate(verdicts, await loadThresholds(DEFAULT_THRESHOLDS_PATH))
console.log(formatCalibration(result))
if (!result.ok) process.exit(2)
if (values['dry-run']) process.exit(0)
const out = values.out ?? DEFAULT_OUT
await writeFile(out, `${JSON.stringify(result.thresholds, null, 2)}\n`)
console.log(`\nWrote ${out}. Review it in one PR; live:verdict uses it once it is merged.`)
