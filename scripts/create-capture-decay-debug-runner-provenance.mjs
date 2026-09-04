#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertCaptureDecayD3CandidateCheckout,
  captureDecayGitTree
} from './lib/capture-decay-publication-git.mjs'
import {
  buildCaptureDecayDebugRunnerProvenance,
  captureDecayCandidateIdentityFromFiles,
  captureDecayCanonicalJsonSha256,
  captureDecayRunnerIdentity
} from './lib/capture-decay-release-acceptance.mjs'
import { sha256File } from './lib/beta-release-manifest.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockedBuilder = join('scripts', 'build-capture-decay-debug-runner.mjs')

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('capture-decay debug runner provenance requires the owner macOS host')
  }
  if (process.argv.length !== 2) {
    throw new Error('release:create:capture-decay-debug-provenance accepts no arguments')
  }
  const program = process.execPath
  const args = [lockedBuilder]
  const sourceCommit = requiredEnv('VIDEORC_CAPTURE_DECAY_SOURCE_COMMIT')
  const runnerPath = resolve(requiredEnv('VIDEORC_SOAK_DEBUG_APP_EXECUTABLE'))
  const provenancePath = resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE'))
  const candidateExecutablePath = resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE'))
  const candidateDmgPath = resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_DMG'))

  await requireMissing(runnerPath, 'debug runner output')
  await requireMissing(provenancePath, 'debug runner provenance output')
  await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
  const sourceTree = await captureDecayGitTree(repoRoot, sourceCommit)
  const sourceBefore = { sourceCommit, sourceTree, trackedClean: true }
  const candidateBefore = await captureDecayCandidateIdentityFromFiles({
    sourceCommit,
    sourceTree,
    candidateExecutablePath,
    candidateDmgPath
  })
  const programStat = await stat(program)
  if (!programStat.isFile() || programStat.size <= 0) {
    throw new Error('debug runner build program must be a non-empty file')
  }

  const startedAt = new Date().toISOString()
  const exitCode = await runOwnedBuild(program, args)
  const finishedAt = new Date().toISOString()
  if (exitCode !== 0) {
    throw new Error(`debug runner build exited with status ${exitCode}`)
  }

  await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
  const sourceAfter = {
    sourceCommit,
    sourceTree: await captureDecayGitTree(repoRoot, sourceCommit),
    trackedClean: true
  }
  const candidateAfter = await captureDecayCandidateIdentityFromFiles({
    sourceCommit,
    sourceTree: sourceAfter.sourceTree,
    candidateExecutablePath,
    candidateDmgPath
  })
  if (JSON.stringify(candidateAfter) !== JSON.stringify(candidateBefore)) {
    throw new Error('candidate app-bundle/DMG identity changed while building the debug runner')
  }
  const runner = await captureDecayRunnerIdentity(runnerPath, { requireDebugBackend: true })
  const commandIdentity = { program, arguments: args, cwd: '.' }
  const provenance = buildCaptureDecayDebugRunnerProvenance({
    build: {
      ...commandIdentity,
      programSha256: await sha256File(program),
      programSizeBytes: programStat.size,
      startedAt,
      finishedAt,
      exitCode,
      shell: false,
      outputDidNotExist: true,
      commandSha256: captureDecayCanonicalJsonSha256(commandIdentity)
    },
    candidate: candidateBefore,
    runner,
    sourceAfter,
    sourceBefore
  })
  const handle = await open(provenancePath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  console.log(`capture-decay-debug-runner-provenance: PASS (${provenancePath})`)
}

async function requireMissing(path, label) {
  try {
    await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} already exists; provenance requires a new write-once output path`)
}

function runOwnedBuild(program, args) {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(program, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit'
    })
    child.once('error', rejectBuild)
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectBuild(new Error(`debug runner build terminated by ${signal}`))
        return
      }
      resolveBuild(code ?? 1)
    })
  })
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

main().catch((error) => {
  console.error(
    `capture-decay-debug-runner-provenance: FAIL (${error?.message ?? 'unexpected error'})`
  )
  process.exit(1)
})
