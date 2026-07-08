import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { resolve } from 'node:path'

import {
  buildWindowsLocalGateSteps,
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

for (const [index, step] of steps.entries()) {
  const manifestStep = manifest.steps[index]
  const stepStartedAt = Date.now()
  manifestStep.status = 'running'
  manifestStep.startedAt = new Date(stepStartedAt).toISOString()
  await writeManifest()

  try {
    await runStep(step)
    manifestStep.status = 'passed'
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
}

manifest.status = 'passed'
manifest.finishedAt = new Date().toISOString()
await writeManifest()
console.log('windows-local-gates: PASS')

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

function writeManifest() {
  return writeFile(manifest.evidence.runManifest, `${JSON.stringify(manifest, null, 2)}\n`)
}
