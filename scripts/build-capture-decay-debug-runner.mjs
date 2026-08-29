#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, copyFile, cp, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('capture-decay debug runner build requires macOS')
  }
  const candidateExecutable = resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE'))
  const outputExecutable = resolve(requiredEnv('VIDEORC_SOAK_DEBUG_APP_EXECUTABLE'))
  const candidateBundle = appBundleForExecutable(candidateExecutable, 'candidate executable')
  const outputBundle = appBundleForExecutable(outputExecutable, 'debug runner executable')
  if (candidateBundle === outputBundle) {
    throw new Error('debug runner must use a new app bundle, never mutate the candidate app')
  }
  await requireFile(candidateExecutable, 'candidate executable')
  await requireMissing(outputBundle, 'debug runner app bundle')

  const buildTarget = await mkdtemp(join(tmpdir(), 'videorc-d3-debug-backend-'))
  try {
    await runOwned('cargo', [
      'build',
      '-p',
      'videorc-backend',
      '--bin',
      'videorc-backend',
      '--target-dir',
      buildTarget
    ])
    const debugBackend = join(buildTarget, 'debug', 'videorc-backend')
    await requireFile(debugBackend, 'fresh isolated debug backend')

    await cp(candidateBundle, outputBundle, {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true
    })
    const embeddedBackend = join(outputBundle, 'Contents', 'Resources', 'videorc-backend')
    await copyFile(debugBackend, embeddedBackend)
    await chmod(embeddedBackend, 0o755)
    await runOwned('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', outputBundle])
    await requireFile(outputExecutable, 'debug runner executable')
    await requireFile(embeddedBackend, 'debug runner embedded backend')
    console.log(`capture-decay-debug-runner-build: PASS (${outputBundle})`)
  } finally {
    await rm(buildTarget, { force: true, recursive: true })
  }
}

function appBundleForExecutable(executable, label) {
  const marker = `${sep}Contents${sep}MacOS${sep}`
  const markerIndex = executable.indexOf(marker)
  if (markerIndex <= 0) {
    throw new Error(`${label} must be inside App.app/Contents/MacOS`)
  }
  const bundle = executable.slice(0, markerIndex)
  if (!bundle.endsWith('.app') || relative(bundle, executable).startsWith(`..${sep}`)) {
    throw new Error(`${label} has an invalid app bundle path`)
  }
  return bundle
}

async function requireFile(path, label) {
  const fileStat = await stat(path)
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`${label} is missing or empty: ${path}`)
  }
}

async function requireMissing(path, label) {
  try {
    await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} already exists; choose a new write-once path`)
}

function runOwned(program, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit'
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal || code !== 0) {
        rejectRun(
          new Error(
            `${program} ${args.join(' ')} failed (${signal ? `signal ${signal}` : `status ${code}`})`
          )
        )
        return
      }
      resolveRun()
    })
  })
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

main().catch((error) => {
  console.error(`capture-decay-debug-runner-build: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
