#!/usr/bin/env node
// Plan 260: the parity list's checker and progress count.
//
//   node scripts/gpui-parity.mjs check [--file docs/gpui/parity.md] [--no-sources]
//       names every problem in the list (malformed row, duplicate or
//       out-of-order ID, unknown cell, Counts table out of date, a Source file
//       Electron no longer has); exits 1 when there is one
//   node scripts/gpui-parity.mjs stats [--file docs/gpui/parity.md]
//       done / lines per area and platform, and the totals
//
// A screen slice ticks its lines (`[ ]` → `[x]`) in its own PR and runs
// `check`; `scripts/lib/gpui-parity.test.mjs` runs it on every
// `pnpm test:scripts`.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { checkParity, parityStats, parseParity, PLATFORMS } from './lib/gpui-parity.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string', default: join(repoRoot, 'docs', 'gpui', 'parity.md') },
    'no-sources': { type: 'boolean', default: false }
  }
})
const parsed = parseParity(readFileSync(values.file, 'utf8'))

if (positionals[0] === 'check') {
  const problems = checkParity(parsed, { repoRoot, checkSources: !values['no-sources'] })
  for (const { line, id, problem } of problems) {
    console.log(`${values.file}:${line ?? '?'}${id ? ` ${id}` : ''}: ${problem}`)
  }
  console.log(
    problems.length === 0
      ? `Parity list OK: ${parsed.controls.length} control lines, ${parsed.windowsOnly.length} Windows-only lines.`
      : `${problems.length} problem(s).`
  )
  process.exit(problems.length === 0 ? 0 : 1)
} else if (positionals[0] === 'stats') {
  const { areas, total } = parityStats(parsed)
  const cell = (counts) => `${counts.done}/${counts.lines}`
  console.log(['Area', ...PLATFORMS].join('\t'))
  for (const row of areas) console.log([row.area, ...PLATFORMS.map((p) => cell(row[p]))].join('\t'))
  console.log(['Total', ...PLATFORMS.map((p) => cell(total[p]))].join('\t'))
} else {
  console.error('Usage: gpui-parity.mjs check [--file F] [--no-sources] | stats [--file F]')
  process.exit(2)
}
