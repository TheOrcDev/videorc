import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { resolve } from 'node:path'

import {
  buildWindowsLocalGateSteps,
  classifyWindowsLocalGateStepExit,
  createWindowsLocalGateManifest,
  evaluateWindowsLocalGateHost,
  formatWindowsLocalGatePlan,
  windowsLocalGateOutputDir
} from './lib/windows-local-gates.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const dryRun = process.argv.includes('--dry-run') || process.argv.includes('--print-only')
const startedAt = new Date()
const host = evaluateWindowsLocalGateHost({
  release: release(),
  // Same dev/lab escape hatch as the app's startup floor: lets Windows 10
  // boxes run the gates as an unsupported configuration.
  allowUnsupportedBuild: process.env.VIDEORC_ALLOW_UNSUPPORTED_WINDOWS === '1'
})
const steps = buildWindowsLocalGateSteps({
  repoRoot,
  acceptanceDir: process.env.VIDEORC_WINDOWS_ACCEPTANCE_DIR
})
const outputDir = windowsLocalGateOutputDir(steps)
const manifest = createWindowsLocalGateManifest({
  host,
  steps,
  repoRoot,
  outputDir,
  platform: process.platform,
  arch: process.arch,
  release: release(),
  startedAt
})

console.log(formatWindowsLocalGatePlan({ host, steps }))

if (dryRun) {
  process.exit(0)
}

await mkdir(outputDir, { recursive: true })
await writeManifest()
console.log(`windows-local-gates: manifest ${manifest.evidence.runManifest}`)

if (!host.ok) {
  manifest.status = 'blocked'
  manifest.finishedAt = new Date().toISOString()
  await writeManifest()
  process.exit(1)
}

let blockedStep = null
for (const [index, step] of steps.entries()) {
  const manifestStep = manifest.steps[index]
  const stepStartedAt = Date.now()
  manifestStep.status = 'running'
  manifestStep.startedAt = new Date(stepStartedAt).toISOString()
  await writeManifest()

  try {
    manifestStep.status = await runStep(step)
    if (manifestStep.status === 'blocked') {
      blockedStep = step
      manifest.status = 'blocked'
      manifestStep.error = { message: await blockedStepReason(step) }
    }
  } catch (error) {
    manifestStep.status = 'failed'
    manifestStep.error = {
      message: error?.message ?? String(error)
    }
    manifest.status = 'failed'
    manifest.finishedAt = new Date().toISOString()
    throw error
  } finally {
    manifestStep.finishedAt = new Date().toISOString()
    manifestStep.durationMs = Date.now() - stepStartedAt
    await writeManifest()
  }
  if (blockedStep) break
}

if (blockedStep) {
  manifest.finishedAt = new Date().toISOString()
  await writeManifest()
  console.error(`windows-local-gates: BLOCKED at ${blockedStep.label}`)
  process.exitCode = blockedStep.blockedExitCode
} else {
  manifest.status = 'passed'
  manifest.finishedAt = new Date().toISOString()
  await writeManifest()
  console.log('windows-local-gates: PASS')
}

function runStep(step) {
  return new Promise((resolveStep, rejectStep) => {
    console.log(`\n[windows-local-gates] ${step.label}`)
    const child = spawn(step.command, step.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...step.env
      },
      shell: process.platform === 'win32',
      stdio: 'inherit'
    })

    child.on('error', rejectStep)
    child.on('exit', (code, signal) => {
      const outcome = classifyWindowsLocalGateStepExit(step, code)
      if (outcome === 'passed') {
        resolveStep('passed')
        return
      }
      if (outcome === 'blocked') {
        resolveStep('blocked')
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

function writeManifest() {
  return writeFile(manifest.evidence.runManifest, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function blockedStepReason(step) {
  if (step.blockedReportPath) {
    try {
      const report = JSON.parse(await readFile(step.blockedReportPath, 'utf8'))
      if (report?.status === 'blocked' && typeof report?.error?.message === 'string') {
        return report.error.message
      }
    } catch {
      // Fall through to the stable parent-level reason when evidence is unreadable.
    }
  }
  return `${step.label} reported a blocked physical-device prerequisite.`
}
