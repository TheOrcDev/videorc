#!/usr/bin/env node
// Plan 260: the per-screen diff checker against the S0.10 Electron baseline.
//
//   node scripts/gpui-baseline.mjs screens
//       every baseline screen and how many shots it has
//   node scripts/gpui-baseline.mjs list --screen <id>
//       the shots a screen slice must take: <stem> (state, size, look) each
//   node scripts/gpui-baseline.mjs compare --screen <id> --shots DIR
//       [--manifest docs/gpui/baseline-manifest.json] [--baseline DIR]
//       [--out DIR] [--slice NAME]
//       pairs the GPUI shots in DIR (<DIR>/<screen>/<stem>.png or <DIR>/<stem>.png)
//       with the baseline; writes <stem>.electron.png, .gpui.png, .pair.png and
//       report.json under <out>/<screen>/ (default
//       ~/videorc-gpui-baseline/compare/<slice>/, outside the repo)
//   node scripts/gpui-baseline.mjs shoot --screen <id>
//       shoots the GPUI app through the UI driver: refused until the app has a
//       launch path (plan 260 S2.1 and S2.5)
//
// The report is information; the gate is looking at every pair. A screen
// slice records its looks in docs/gpui/screens.md.

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { sliceOfBranch } from './lib/gpui-compare.mjs'
import { compareScreen, entriesOf, readManifest, screensOf } from './lib/gpui-baseline.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    screen: { type: 'string' },
    shots: { type: 'string' },
    manifest: { type: 'string', default: join(repoRoot, 'docs', 'gpui', 'baseline-manifest.json') },
    baseline: { type: 'string' },
    out: { type: 'string' },
    slice: { type: 'string' }
  }
})
const command = positionals[0]
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const manifest = readManifest(values.manifest)
if (command === 'screens') {
  for (const { screen, entries } of screensOf(manifest)) console.log(`${screen}\t${entries}`)
} else if (command === 'list') {
  if (!values.screen) fail('list needs --screen <id> (see `screens`).')
  for (const entry of entriesOf(manifest, values.screen)) {
    console.log(
      `${entry.stem}\t${entry.state} ${entry.width}x${entry.height} ${entry.theme}/${entry.contrast}`
    )
  }
} else if (command === 'compare') {
  if (!values.screen || !values.shots) fail('compare needs --screen <id> and --shots DIR.')
  let branch = ''
  try {
    branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' })
  } catch {}
  const slice = values.slice ?? sliceOfBranch(branch)
  const outDir = resolve(values.out ?? join(homedir(), 'videorc-gpui-baseline', 'compare', slice))
  const report = compareScreen({
    manifest,
    screen: values.screen,
    baselineDir: values.baseline,
    shotsDir: resolve(values.shots),
    outDir,
    slice
  })
  for (const row of report.paired) {
    console.log(
      `pair ${row.stem}: ${(row.differingShare * 100).toFixed(2)}% differ${row.sizeMatch ? '' : ' (size differs)'}`
    )
  }
  for (const row of report.unpaired) console.log(`none ${row.stem}: ${row.reason}`)
  console.log(
    `${report.paired.length} pairs, ${report.unpaired.length} without one: ${join(outDir, values.screen)}`
  )
} else if (command === 'shoot') {
  fail(
    'shoot drives the GPUI app through the UI driver (VIDEORC_APP=gpui), which has no launch path yet: plan 260 S2.1 builds the app and S2.5 its smoke server. Until then, put shots in a folder and run compare.'
  )
} else {
  fail(
    'Usage: gpui-baseline.mjs screens | list --screen <id> | compare --screen <id> --shots DIR | shoot --screen <id>'
  )
}
