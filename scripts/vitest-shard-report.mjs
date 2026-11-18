#!/usr/bin/env node
// Plan 242 S7: the desktop vitest shards' reports.
//
//   node scripts/vitest-shard-report.mjs check <report.json>...
//     Every desktop test file ran in exactly one shard; prints each shard's
//     time and the slowest-to-mean ratio. Exit 1 on a missing or doubled file.
//   node scripts/vitest-shard-report.mjs merge <report.json>...
//     Rewrites apps/desktop/vitest-timings.json from shard reports.
//   node scripts/vitest-shard-report.mjs refresh [vitest args]
//     Runs the whole suite once with the timing reporter, then merges.
import { spawnSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DESKTOP_VITEST_INCLUDE,
  DESKTOP_VITEST_TIMINGS_FILE,
  checkShardCoverage,
  mergeTimings,
  readTimings,
  shardBalance,
  toPosixPath
} from './lib/vitest-shards.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const desktopRoot = join(repoRoot, 'apps/desktop')
const BALANCE_WARNING = 1.3

export function expectedDesktopTestFiles(root = desktopRoot) {
  const files = new Set()
  for (const pattern of DESKTOP_VITEST_INCLUDE) {
    for (const file of globSync(pattern, { cwd: root })) files.add(toPosixPath(file))
  }
  return [...files].sort()
}

function readReport(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function check(
  reportPaths,
  { output = console, expected = expectedDesktopTestFiles() } = {}
) {
  const reports = reportPaths.map((path) => ({ path, report: readReport(path) }))
  const lists = reports.map(({ report }) => Object.keys(readTimings(report)))
  const coverage = checkShardCoverage(expected, lists)
  const totals = reports.map(({ report }) =>
    Object.values(readTimings(report)).reduce((sum, ms) => sum + ms, 0)
  )
  reports.forEach(({ path, report }, index) => {
    output.log(
      `${report.shard ?? path}: ${lists[index].length} files, ${(totals[index] / 1000).toFixed(1)} s of worker time`
    )
  })
  const balance = shardBalance(totals)
  output.log(
    `${expected.length} test files expected, ${lists.flat().length} run; slowest shard / mean = ${balance?.toFixed(2)}`
  )
  if (balance !== null && balance > BALANCE_WARNING) {
    output.log(
      `::warning::Vitest shards are unbalanced (${balance.toFixed(2)}). Refresh the recorded times: pnpm --filter @videorc/desktop test:timings`
    )
  }
  const problems = []
  if (coverage.missing.length) problems.push(`never ran: ${coverage.missing.join(', ')}`)
  if (coverage.duplicated.length) problems.push(`ran twice: ${coverage.duplicated.join(', ')}`)
  if (coverage.unexpected.length)
    problems.push(`not a desktop test file: ${coverage.unexpected.join(', ')}`)
  for (const problem of problems) output.error(`vitest shards: ${problem}`)
  return { ok: problems.length === 0, coverage, balance }
}

export function merge(reportPaths, { out = join(desktopRoot, DESKTOP_VITEST_TIMINGS_FILE) } = {}) {
  const timings = mergeTimings(reportPaths.map(readReport))
  writeFileSync(out, `${JSON.stringify(timings, null, 2)}\n`)
  return timings
}

function refresh(vitestArgs) {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-vitest-timings-'))
  const report = join(directory, 'report.json')
  try {
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...vitestArgs], {
      cwd: desktopRoot,
      env: { ...process.env, VIDEORC_VITEST_REPORT: report },
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    if (result.status !== 0) {
      console.error('vitest failed; the recorded times were not changed.')
      return result.status ?? 1
    }
    const timings = merge([report])
    console.log(
      `Recorded ${Object.keys(timings.files).length} files in ${DESKTOP_VITEST_TIMINGS_FILE}.`
    )
    return 0
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'check') {
    process.exitCode = check(rest).ok ? 0 : 1
  } else if (command === 'merge') {
    merge(rest)
  } else if (command === 'refresh') {
    process.exitCode = refresh(rest)
  } else {
    console.error('usage: vitest-shard-report.mjs check|merge|refresh ...')
    process.exitCode = 2
  }
}
