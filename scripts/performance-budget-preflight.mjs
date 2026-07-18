#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  preflightActivePerformanceBudget,
  preflightActivePerformanceBudgetArtifact,
  readActivePerformanceBudget
} from './lib/performance-budget.mjs'
import { collectPerformanceMetadata } from './lib/performance-contract.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}

async function main(argv) {
  const args = parsePerformanceBudgetPreflightArgs(argv)
  const appManifest = JSON.parse(await readFile('apps/desktop/package.json', 'utf8'))
  const metadata = await collectPerformanceMetadata({
    env: {
      ...process.env,
      VIDEORC_PERF_PROFILE_CLASS: args.profileClass,
      VIDEORC_PERF_APP_VERSION: process.env.VIDEORC_PERF_APP_VERSION ?? appManifest.version,
      VIDEORC_PERF_WARMUP_MS: String(args.warmupMs),
      VIDEORC_PERF_MEASUREMENT_MS: String(args.measurementMs),
      VIDEORC_PERF_SAMPLE_INTERVAL_MS: String(args.intervalMs),
      VIDEORC_PERF_EXPECT_BUILD_MODE: 'packaged'
    }
  })
  if (metadata.buildMode !== 'packaged') {
    throw new Error('Performance budget preflight requires VIDEORC_PERF_APP_EXECUTABLE.')
  }
  if (!metadata.packagePayload?.sha256) {
    const missing =
      metadata.packagePayload?.components
        ?.filter((component) => !component.sha256)
        .map((component) => component.relativePath)
        .join(', ') || 'packaged app payload'
    throw new Error(`Performance budget preflight could not hash: ${missing}.`)
  }

  const budgetPath = resolve(
    args.budgetPath ??
      process.env.VIDEORC_PERF_ACTIVE_BUDGET_PATH ??
      'config/performance-budgets/v1/active/macos-release.json'
  )
  const budget = await readActivePerformanceBudget({ path: budgetPath })
  const preflight = args.artifactOnly
    ? preflightActivePerformanceBudgetArtifact
    : preflightActivePerformanceBudget
  const result = preflight({
    budget,
    profileId: args.profileId ?? process.env.VIDEORC_PERF_ACTIVE_BUDGET_PROFILE,
    context: performanceBudgetPreflightContext({
      scenario: args.scenario,
      metadata,
      timing: {
        warmupMs: args.warmupMs,
        measurementMs: args.measurementMs,
        intervalMs: args.intervalMs
      }
    })
  })
  console.log(
    `Active performance budget preflight passed for packaged payload ${metadata.packagePayload.sha256}: ${result.candidateProfileIds.join(', ')}`
  )
}

export function performanceBudgetPreflightContext({ scenario, metadata, timing }) {
  return {
    scenario,
    profileClass: metadata.profileClass,
    appVersion: metadata.appVersion,
    machineModel: metadata.machineModel,
    hardwareClass: metadata.hardwareClass,
    buildMode: metadata.buildMode,
    packagePayloadSha256: metadata.packagePayload?.sha256,
    operatingSystem: metadata.operatingSystem,
    timing
  }
}

export function parsePerformanceBudgetPreflightArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--budget=')) parsed.budgetPath = arg.slice('--budget='.length)
    else if (arg === '--artifact-only') parsed.artifactOnly = true
    else if (arg === '--budget') parsed.budgetPath = argv[++index]
    else if (arg.startsWith('--profile=')) parsed.profileId = arg.slice('--profile='.length)
    else if (arg === '--profile') parsed.profileId = argv[++index]
    else if (arg.startsWith('--scenario=')) parsed.scenario = arg.slice('--scenario='.length)
    else if (arg === '--scenario') parsed.scenario = argv[++index]
    else if (arg.startsWith('--profile-class=')) {
      parsed.profileClass = arg.slice('--profile-class='.length)
    } else if (arg === '--profile-class') parsed.profileClass = argv[++index]
    else if (arg.startsWith('--warmup-seconds=')) {
      parsed.warmupMs = secondsToMs(arg.slice('--warmup-seconds='.length))
    } else if (arg === '--warmup-seconds') parsed.warmupMs = secondsToMs(argv[++index])
    else if (arg.startsWith('--measurement-seconds=')) {
      parsed.measurementMs = secondsToMs(arg.slice('--measurement-seconds='.length))
    } else if (arg === '--measurement-seconds') {
      parsed.measurementMs = secondsToMs(argv[++index])
    } else if (arg.startsWith('--sample-interval-ms=')) {
      parsed.intervalMs = positiveInteger(arg.slice('--sample-interval-ms='.length))
    } else if (arg === '--sample-interval-ms') {
      parsed.intervalMs = positiveInteger(argv[++index])
    } else throw new Error(`Unknown argument: ${arg}`)
  }

  for (const field of ['scenario', 'profileClass', 'warmupMs', 'measurementMs', 'intervalMs']) {
    if (!parsed[field]) throw new Error(`Performance budget preflight requires ${field}.`)
  }
  if (!['short-sentinel', 'endurance'].includes(parsed.profileClass)) {
    throw new Error(`Invalid performance profile class: ${parsed.profileClass}.`)
  }
  if (parsed.profileClass === 'endurance' && parsed.measurementMs < 600_000) {
    throw new Error('Endurance performance profiles require at least 600 measurement seconds.')
  }
  if (parsed.profileClass === 'short-sentinel' && parsed.measurementMs >= 600_000) {
    throw new Error(
      'Short-sentinel performance profiles must remain below 600 measurement seconds.'
    )
  }
  return parsed
}

function secondsToMs(value) {
  return positiveInteger(value) * 1_000
}

function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`Expected a positive integer: ${value}`)
  return number
}
