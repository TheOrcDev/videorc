#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  collectPerformanceMetadata,
  createPerformanceReport,
  evaluateChildPerformanceRun,
  failingChecks,
  observationCheck,
  passingCheck,
  performanceBuildMode,
  performanceMode,
  performanceWrapperMetadataAfterChild,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  buildPerformanceScenario,
  PERFORMANCE_SCENARIOS,
  performanceScenarioLaunchSpec,
  performanceScenarioReportPaths
} from './lib/performance-scenarios.mjs'

const args = parseArgs(process.argv.slice(2))
if (args.list) {
  console.log(PERFORMANCE_SCENARIOS.join('\n'))
  process.exit(0)
}
if (!args.scenario) {
  throw new Error(`Missing --scenario. Choose: ${PERFORMANCE_SCENARIOS.join(', ')}.`)
}

const mode = performanceMode()
const warmupSeconds = positiveNumber(args.warmupSeconds, 60)
const measurementSeconds = positiveNumber(args.measurementSeconds, 600)
const sampleIntervalMs = positiveInteger(args.sampleIntervalMs, 1_000)
const profileClass =
  args.profileClass ?? (measurementSeconds >= 600 ? 'endurance' : 'short-sentinel')
if (!['short-sentinel', 'endurance'].includes(profileClass)) {
  throw new Error(`Invalid performance profile class: ${profileClass}.`)
}
if (profileClass === 'endurance' && measurementSeconds < 600) {
  throw new Error('Endurance performance profiles require at least 600 measurement seconds.')
}
if (profileClass === 'short-sentinel' && measurementSeconds >= 600) {
  throw new Error('Short-sentinel performance profiles must remain below 600 measurement seconds.')
}
const appManifest = await readJson('apps/desktop/package.json')
const appVersion = process.env.VIDEORC_PERF_APP_VERSION ?? appManifest?.version
if (typeof appVersion !== 'string' || !appVersion.trim()) {
  throw new Error('Could not determine the Videorc app version for performance profile identity.')
}
const runNonce = randomUUID()
const expectedBuildMode = process.env.VIDEORC_PERF_EXPECT_BUILD_MODE ?? performanceBuildMode()
if (!['development', 'packaged'].includes(expectedBuildMode)) {
  throw new Error(`Invalid expected performance build mode: ${expectedBuildMode}.`)
}
const paths = performanceScenarioReportPaths({
  scenario: args.scenario,
  outputPath: args.output,
  artifactRoot: process.env.VIDEORC_PERF_ARTIFACT_DIR
})
const scenario = buildPerformanceScenario({
  scenario: args.scenario,
  mode,
  warmupSeconds,
  measurementSeconds,
  childReportPath: paths.child,
  runNonce,
  expectedBuildMode,
  profileClass,
  appVersion,
  sampleIntervalMs
})
const launch = performanceScenarioLaunchSpec(scenario)
const provenanceEnvironment = {
  ...process.env,
  ...launch.env,
  VIDEORC_PERF_RUN_NONCE: runNonce,
  VIDEORC_PERF_EXPECT_BUILD_MODE: expectedBuildMode
}
const metadata = await collectPerformanceMetadata({ env: provenanceEnvironment })

console.log(
  `Performance scenario ${args.scenario} (${mode}, ${profileClass}): ${launch.command} ${launch.args.join(' ')}`
)
if (launch.powerAssertion) {
  console.log(
    `Power assertion: ${launch.powerAssertion.provider} ${launch.powerAssertion.flags.join(' ')}`
  )
}
if (scenario.timing) {
  console.log(`Lifecycle cycles: ${scenario.timing.cycles}`)
} else {
  console.log(`Warm-up ${warmupSeconds}s; measurement ${measurementSeconds}s`)
}
if (scenario.deviceRequired) {
  console.log('This scenario requires an authorized macOS screen/camera/microphone host.')
}

const startedAt = Date.now()
let exit = { code: 1, signal: null, error: null }
try {
  exit = await runChild(launch)
} catch (error) {
  exit.error = error.message
}
const childReport = await readJson(paths.child)
const childEvaluation = evaluateChildPerformanceRun({
  exit,
  report: childReport,
  startedAtMs: startedAt,
  mode,
  expectedScenario: args.scenario,
  expectedMetadata: metadata,
  requireCleanProvenance: expectedBuildMode === 'packaged'
})
const report = createPerformanceReport({
  scenario: args.scenario,
  mode,
  metadata: performanceWrapperMetadataAfterChild(metadata, childReport?.metadata),
  timing: scenario.timing
    ? { ...scenario.timing, elapsedMs: Date.now() - startedAt }
    : {
        warmupMs: warmupSeconds * 1000,
        measurementMs: measurementSeconds * 1000,
        intervalMs: sampleIntervalMs,
        profileClass,
        elapsedMs: Date.now() - startedAt
      },
  metrics: {
    command: {
      command: scenario.command,
      args: scenario.args,
      launchCommand: launch.command,
      launchArgs: launch.args,
      powerAssertion: launch.powerAssertion
    },
    deviceRequired: scenario.deviceRequired,
    childExit: exit,
    childReport
  },
  checks: childEvaluation.ok
    ? childEvaluation.verdictObserved
      ? [
          observationCheck(
            `scenario command produced a fresh report-only observation (${childReport?.verdict})`
          )
        ]
      : [
          passingCheck(
            mode === 'gate'
              ? 'scenario command and fresh child gate verdict passed'
              : `scenario command produced a fresh child report (${childReport?.verdict})`
          )
        ]
    : failingChecks(childEvaluation.failures)
})
const reportPath = await writePerformanceReport(report, { path: paths.wrapper })
console.log(`Performance scenario report: ${reportPath}`)
if (!childEvaluation.ok) process.exitCode = 1

function runChild(spec) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...spec.env },
      stdio: 'inherit'
    })
    child.on('error', rejectChild)
    child.on('exit', (code, signal) => resolveChild({ code: code ?? 1, signal, error: null }))
  })
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const parsed = { list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') parsed.list = true
    else if (arg === '--gate' || arg === '--report-only') continue
    else if (arg.startsWith('--scenario=')) parsed.scenario = arg.slice('--scenario='.length)
    else if (arg === '--scenario') parsed.scenario = argv[++index]
    else if (arg.startsWith('--warmup-seconds=')) {
      parsed.warmupSeconds = arg.slice('--warmup-seconds='.length)
    } else if (arg === '--warmup-seconds') parsed.warmupSeconds = argv[++index]
    else if (arg.startsWith('--measurement-seconds=')) {
      parsed.measurementSeconds = arg.slice('--measurement-seconds='.length)
    } else if (arg === '--measurement-seconds') parsed.measurementSeconds = argv[++index]
    else if (arg.startsWith('--sample-interval-ms=')) {
      parsed.sampleIntervalMs = arg.slice('--sample-interval-ms='.length)
    } else if (arg === '--sample-interval-ms') parsed.sampleIntervalMs = argv[++index]
    else if (arg.startsWith('--profile-class=')) {
      parsed.profileClass = arg.slice('--profile-class='.length)
    } else if (arg === '--profile-class') parsed.profileClass = argv[++index]
    else if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length)
    else if (arg === '--output') parsed.output = argv[++index]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return parsed
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}
