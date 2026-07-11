#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  aggregatePackagedPerformanceCalibration,
  formatPerformanceCalibrationSummary,
  PERFORMANCE_CALIBRATION_RUN_COUNT
} from './lib/performance-calibration.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}

async function main(argv) {
  const args = parseArgs(argv)
  const reports = await Promise.all(
    args.reportPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')))
  )
  const { summary, budgetCandidate } = aggregatePackagedPerformanceCalibration({
    reports,
    reportPaths: portableCalibrationReportPaths({
      reportPaths: args.reportPaths,
      outputPath: args.outputPath
    })
  })

  await Promise.all([
    writeJson(args.outputPath, summary),
    writeJson(args.budgetCandidatePath, budgetCandidate)
  ])
  console.log(formatPerformanceCalibrationSummary(summary))
  console.log(`Calibration summary: ${resolve(args.outputPath)}`)
  console.log(`Unenforced budget candidate: ${resolve(args.budgetCandidatePath)}`)
}

export function portableCalibrationReportPaths({ reportPaths, outputPath }) {
  const artifactDirectory = dirname(resolve(outputPath))
  return reportPaths.map((path) => relative(artifactDirectory, resolve(path)).split(sep).join('/'))
}

export function parseArgs(argv) {
  const parsed = { reportPaths: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--output=')) parsed.outputPath = arg.slice('--output='.length)
    else if (arg === '--output') parsed.outputPath = argv[++index]
    else if (arg.startsWith('--budget-output=')) {
      parsed.budgetCandidatePath = arg.slice('--budget-output='.length)
    } else if (arg === '--budget-output') parsed.budgetCandidatePath = argv[++index]
    else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`)
    else parsed.reportPaths.push(arg)
  }
  if (parsed.reportPaths.length !== PERFORMANCE_CALIBRATION_RUN_COUNT) {
    throw new Error(
      `Expected exactly ${PERFORMANCE_CALIBRATION_RUN_COUNT} detailed child report paths; received ${parsed.reportPaths.length}.`
    )
  }
  if (!parsed.outputPath) {
    parsed.outputPath = 'docs/acceptance/artifacts/performance/calibration-summary.json'
  }
  if (!parsed.budgetCandidatePath) {
    parsed.budgetCandidatePath = parsed.outputPath.replace(/\.json$/i, '.budget-candidate.json')
    if (parsed.budgetCandidatePath === parsed.outputPath) {
      parsed.budgetCandidatePath = `${parsed.outputPath}.budget-candidate.json`
    }
  }
  return parsed
}

async function writeJson(path, value) {
  const absolutePath = resolve(path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`)
}
