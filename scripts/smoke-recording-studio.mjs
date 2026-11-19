import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { loadavg } from 'node:os'
import { appendFileSync, mkdirSync, createWriteStream } from 'node:fs'

import {
  buildRecordingStudioGateSteps,
  formatRecordingStudioGatePlan
} from './lib/recording-studio-gates.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const keepGoing = args.has('--keep-going')
const evidenceRoot = process.env.VIDEORC_RECORDING_STUDIO_RESULTS_DIR
const dryRun = args.has('--dry-run') || args.has('--print-only')
const includeDeviceSmoke =
  args.has('--include-device-smoke') || process.env.VIDEORC_RECORDING_STUDIO_DEVICE_SMOKE === '1'
const includeAppSmoke = process.env.VIDEORC_RECORDING_STUDIO_SKIP_APP_SMOKE !== '1'
const steps = buildRecordingStudioGateSteps({ includeAppSmoke, includeDeviceSmoke })

console.log(formatRecordingStudioGatePlan({ steps }))
if (!includeAppSmoke) {
  console.warn(
    'recording-studio-gates: app smoke is skipped by VIDEORC_RECORDING_STUDIO_SKIP_APP_SMOKE=1; this is not a complete recording-studio gate.'
  )
}

if (dryRun) {
  process.exit(0)
}

const failures = []
for (const [index, plannedStep] of steps.entries()) {
  const step =
    plannedStep.command === 'pnpm' && plannedStep.args.includes('test')
      ? { ...plannedStep, args: [...plannedStep.args, '--maxWorkers=2', '--minWorkers=1'] }
      : plannedStep
  const startedAt = Date.now()
  const loadStart = loadavg()
  const stepDirectory = evidenceRoot
    ? resolve(
        evidenceRoot,
        String(index + 1).padStart(2, '0') + '-' + step.args.at(-1).replace(/[^a-zA-Z0-9-]+/g, '-')
      )
    : null
  let error = null
  try {
    await runStep(step, stepDirectory)
  } catch (failure) {
    error = failure
    failures.push({ label: step.label, error: String(failure) })
    console.error(String(failure))
  }
  if (evidenceRoot) {
    mkdirSync(evidenceRoot, { recursive: true })
    appendFileSync(
      resolve(evidenceRoot, 'results.jsonl'),
      JSON.stringify({
        label: step.label,
        command: [step.command, ...step.args],
        pass: error === null,
        error: error ? String(error) : null,
        durationMs: Date.now() - startedAt,
        loadStart,
        loadEnd: loadavg(),
        log: resolve(stepDirectory, 'command.log')
      }) + '\n'
    )
  }
  const resultsFile = process.env.VIDEORC_RECORDING_STUDIO_RESULTS_FILE
  if (resultsFile)
    appendFileSync(
      resultsFile,
      `- Recording-studio: ${step.label}: ${error ? 'FAIL' : 'PASS'}, ${Date.now() - startedAt} ms; load ${loadStart[0].toFixed(1)} → ${loadavg()[0].toFixed(1)}. Log: ${stepDirectory ? resolve(stepDirectory, 'command.log') : 'aggregate log'}.\n`
    )
  if (error && !keepGoing) throw error
}
if (failures.length)
  throw new Error(
    `recording-studio-gates: ${failures.length} failed step(s): ${failures.map((failure) => failure.label).join('; ')}`
  )
console.log('recording-studio-gates: PASS')

function runStep(step, stepDirectory) {
  return new Promise((resolveStep, rejectStep) => {
    console.log(`\n[recording-studio-gates] ${step.label}`)
    // Heavy non-app work shares live-aware build slots. App smokes retain
    // their own launch/build guards, so no slot is held across nested builds.
    const guarded =
      step.command === 'cargo' ||
      step.args.includes('test') ||
      step.args.includes('test:scripts') ||
      step.args.includes('probe:live-audio-controls')
    const command = guarded ? process.execPath : step.command
    const args = guarded
      ? [resolve(repoRoot, 'scripts/with-build-slot.mjs'), step.command, ...step.args]
      : step.args
    if (stepDirectory) mkdirSync(stepDirectory, { recursive: true })
    const log = stepDirectory ? createWriteStream(resolve(stepDirectory, 'command.log')) : null
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...step.env,
        ...(stepDirectory
          ? { VIDEORC_SMOKE_OUTPUT_DIR: stepDirectory, VIDEORC_SMOKE_STATE_DIR: stepDirectory }
          : {})
      },
      shell: process.platform === 'win32',
      stdio: log ? ['inherit', 'pipe', 'pipe'] : 'inherit'
    })

    if (log) {
      child.stdout.on('data', (data) => {
        log.write(data)
        process.stdout.write(data)
      })
      child.stderr.on('data', (data) => {
        log.write(data)
        process.stderr.write(data)
      })
    }
    child.on('error', (error) => {
      log?.end()
      rejectStep(error)
    })
    child.on('close', async (code, signal) => {
      if (log) await new Promise((resolveLog) => log.end(resolveLog))
      if (code === 0) {
        resolveStep()
        return
      }
      rejectStep(
        new Error(
          `${step.label} failed: ${step.command} ${step.args.join(' ')} exited with code=${code} signal=${signal}`
        )
      )
    })
  })
}
