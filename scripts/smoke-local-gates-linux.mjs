#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopProcess } from './lib/app-launcher.mjs'
import { linuxHostPerformanceSnapshot } from './lib/linux-host-performance.mjs'
import {
  LINUX_SOURCE_GATES,
  LINUX_RUNTIME_GATES,
  assessLinuxGateExit,
  linuxGateEnvironment
} from './lib/linux-local-gates.mjs'

const args = process.argv.slice(2)
const phase = args.find((arg) => arg.startsWith('--phase='))?.slice(8) ?? 'all'
if (
  !['all', 'source', 'runtime'].includes(phase) ||
  args.some((arg) => arg !== '--list' && !/^--phase=(all|source|runtime)$/.test(arg))
)
  throw new Error('Usage: pnpm smoke:local-gates:linux [--list] [--phase=source|runtime|all]')
const steps = [
  ...(phase !== 'runtime' ? LINUX_SOURCE_GATES : []),
  ...(phase !== 'source' ? LINUX_RUNTIME_GATES : [])
]
if (args.includes('--list')) {
  console.log(
    JSON.stringify(
      {
        phase,
        evidenceKind: 'development-only',
        steps: steps.map(({ proof, ...step }) => ({ ...step, proof: proof?.source ?? null }))
      },
      null,
      2
    )
  )
  process.exit(0)
}
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Linux x64 required; no successful platform skip.')
if (
  phase !== 'source' &&
  !/^\/dev\/dri\/renderD\d+$/.test(process.env.VIDEORC_LINUX_VAAPI_DEVICE ?? '')
)
  throw new Error(
    'Set VIDEORC_LINUX_VAAPI_DEVICE to an explicitly approved, non-quarantined render node before the hardware encoder gate.'
  )
const repoRoot = resolve(import.meta.dirname, '..')
const directory = await mkdtemp(join(tmpdir(), 'videorc-linux-gates-'))
const report = {
  schemaVersion: 1,
  evidenceKind: 'development-only',
  phase,
  status: 'running',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim(),
  dirty:
    execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
      .length > 0,
  machine: hostname(),
  startedAt: new Date().toISOString(),
  steps: []
}
const reportPath = join(directory, 'gates.json')
const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
let child
let interrupted = false
const interrupt = () => {
  interrupted = true
  if (child) void stopProcess(child)
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
console.log(`Linux development gate evidence: ${reportPath}`)
try {
  await save()
  for (const step of steps) {
    if (interrupted) throw new Error('Interrupted')
    const outputDir = join(directory, step.id)
    await mkdir(outputDir, { recursive: true })
    const row = {
      id: step.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      hostBefore: await linuxHostPerformanceSnapshot()
    }
    report.steps.push(row)
    await save()
    console.log(`Running ${step.id}: ${step.command} ${step.args.join(' ')}`)
    let output = '',
      timedOut = false
    child = spawn(step.command, step.args, {
      cwd: repoRoot,
      env: linuxGateEnvironment(process.env, outputDir, repoRoot),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const owned = child
    const timer = setTimeout(
      () => {
        timedOut = true
        void stopProcess(owned)
      },
      60 * 60 * 1000
    )
    try {
      const result = await new Promise((resolveResult, reject) => {
        owned.once('error', reject)
        for (const stream of [owned.stdout, owned.stderr])
          stream.on('data', (chunk) => {
            output += chunk.toString()
            // Full logs stay private on disk; avoid dumping app/device details.
            if (output.length > 32 * 1024 * 1024) {
              timedOut = true
              void stopProcess(owned)
            }
          })
        owned.once('close', (code, signal) => resolveResult({ code, signal }))
      })
      Object.assign(row, assessLinuxGateExit(step, { ...result, output, timedOut }))
    } catch (error) {
      Object.assign(row, { status: 'failed', reason: error.message })
      throw error
    } finally {
      clearTimeout(timer)
      await stopProcess(owned)
      child = null
      await writeFile(join(outputDir, 'output.log'), output)
      row.hostAfter = await linuxHostPerformanceSnapshot()
      row.finishedAt = new Date().toISOString()
      await save()
    }
    console.log(`${step.id}: ${row.status}${row.reason ? ` (${row.reason})` : ''}`)
    if (row.status !== 'pass') throw new Error(`${step.id} did not pass; see private output.log`)
  }
  report.status = 'pass'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await save()
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
console.log(
  `Linux ${phase} development gates: ${report.status}; ${reportPath}. Physical candidate acceptance remains separate.`
)
