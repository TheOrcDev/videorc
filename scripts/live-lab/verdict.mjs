#!/usr/bin/env node
// Plan 178 U9. (Re)computes a run's verdict offline and writes verdict.json,
// report.md and charts into the run folder:
//
//   node scripts/live-lab/verdict.mjs <runDir> [--thresholds <path>] [--no-charts] [--json]
//
// Exit 0 when the verdict is pass or warn, 1 when it is fail or crashed, 3
// when stopped, 2 on a usage or redaction error. live:run calls the same code
// at the end of every run (lib/harness.mjs finalizeRun).

import { parseArgs } from 'node:util'

import { finalizeRunFolder } from './lib/finalize.mjs'

let parsed
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      thresholds: { type: 'string' },
      'no-charts': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false }
    },
    allowPositionals: true,
    strict: true
  })
} catch (error) {
  console.error(`usage: ${error.message}`)
  process.exit(2)
}
const [runDir] = parsed.positionals
if (!runDir) {
  console.error(
    'usage: node scripts/live-lab/verdict.mjs <runDir> [--thresholds <path>] [--no-charts] [--json]'
  )
  process.exit(2)
}

try {
  const { verdict, written } = await finalizeRunFolder({
    runDir,
    thresholdsPath: parsed.values.thresholds,
    charts: !parsed.values['no-charts']
  })
  if (parsed.values.json) console.log(JSON.stringify(verdict))
  else {
    console.log(
      `Verdict ${verdict.outcome}: ${verdict.incidents.length} incident(s), ${verdict.needsEyes.length} needs-eyes.`
    )
    for (const path of written) console.log(`  ${path}`)
  }
  process.exitCode =
    verdict.outcome === 'fail' || verdict.outcome === 'crashed'
      ? 1
      : verdict.outcome === 'stopped'
        ? 3
        : 0
} catch (error) {
  console.error(
    error.code === 'REDACTION_FAILED' ? error.message : `Verdict failed: ${error.message}`
  )
  process.exitCode = 2
}
