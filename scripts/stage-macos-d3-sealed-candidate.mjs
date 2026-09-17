#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  assertCaptureDecayCandidateIdentityUnchanged,
  captureDecayCandidateIdentityFromFiles
} from './lib/capture-decay-release-acceptance.mjs'
import {
  assertCaptureDecayD3CandidateCheckout,
  captureDecayGitTree
} from './lib/capture-decay-publication-git.mjs'
import {
  buildMacosD3SealedCandidatePlan,
  getMacosD3CandidateS3Config,
  macosD3CandidateSealSummary,
  normalizeMacosD3UpdateFeedForSealing,
  stageMacosD3SealedCandidate,
  writeMacosD3CanonicalJsonExclusive
} from './lib/macos-d3-sealed-candidate.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Sealing a signed/notarized macOS candidate requires the macOS owner host.')
  }
  const options = parseOptions(process.argv.slice(2))
  const candidateExecutablePath = resolve(
    requiredOption(
      options.candidateExecutable,
      process.env.VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE,
      '--candidate-executable'
    )
  )
  const candidateDmgPath = resolve(
    requiredOption(
      options.candidateDmg,
      process.env.VIDEORC_CAPTURE_DECAY_CANDIDATE_DMG,
      '--candidate-dmg'
    )
  )
  const releaseDir = resolve(
    requiredOption(options.releaseDir, process.env.VIDEORC_RELEASE_DIR, '--release-dir')
  )
  const receiptPath = resolve(
    requiredOption(
      options.receipt,
      process.env.VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT,
      '--receipt'
    )
  )
  const manifestPath = resolve(
    options.manifest ??
      process.env.VIDEORC_RELEASE_MANIFEST_PATH ??
      join(releaseDir, 'release.json')
  )
  const destinationBindingSha256 = requiredOption(
    options.destinationBindingSha256,
    process.env.VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256,
    '--destination-binding-sha256'
  )
  await requireMissing(receiptPath)

  const sourceCommit = options.sourceCommit ?? (await gitHead())
  await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
  const sourceTree = await captureDecayGitTree(repoRoot, sourceCommit)
  const candidate = await captureDecayCandidateIdentityFromFiles({
    sourceCommit,
    sourceTree,
    candidateExecutablePath,
    candidateDmgPath
  })
  await normalizeMacosD3UpdateFeedForSealing({ candidate, manifestPath, releaseDir })
  const candidateStorageConfig = getMacosD3CandidateS3Config()
  const plan = await buildMacosD3SealedCandidatePlan({
    candidate,
    candidateExecutablePath,
    candidateStorageConfig,
    manifestPath,
    publicationDestinationBindingSha256: destinationBindingSha256,
    releaseDir
  })
  const receipt = await stageMacosD3SealedCandidate(plan)

  const after = await captureDecayCandidateIdentityFromFiles({
    sourceCommit,
    sourceTree,
    candidateExecutablePath,
    candidateDmgPath
  })
  assertCaptureDecayCandidateIdentityUnchanged(candidate, after)
  await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
  await writeMacosD3CanonicalJsonExclusive(receiptPath, receipt)

  const sealedCandidate = macosD3CandidateSealSummary(receipt)
  console.log(
    `macos-d3-sealed-candidate: PASS (${sealedCandidate.manifest.objectKey}, ${sealedCandidate.manifest.sha256})`
  )
  console.log(JSON.stringify({ sealedCandidate }))
}

function parseOptions(args) {
  const allowed = new Map([
    ['--candidate-dmg', 'candidateDmg'],
    ['--candidate-executable', 'candidateExecutable'],
    ['--destination-binding-sha256', 'destinationBindingSha256'],
    ['--manifest', 'manifest'],
    ['--receipt', 'receipt'],
    ['--release-dir', 'releaseDir'],
    ['--source-commit', 'sourceCommit']
  ])
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const key = allowed.get(name)
    const value = args[index + 1]
    if (!key || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`Invalid sealed-candidate option near ${name ?? '(missing)'}.`)
    }
    if (options[key] !== undefined) throw new Error(`Duplicate sealed-candidate option ${name}.`)
    options[key] = value
  }
  return options
}

function requiredOption(option, environment, name) {
  const value = option ?? environment
  if (typeof value !== 'string' || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is required.`)
  }
  return value.trim()
}

async function gitHead() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  return stdout.trim()
}

async function requireMissing(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Refusing to replace existing seal receipt ${path}.`)
}

main().catch((error) => {
  console.error(`macos-d3-sealed-candidate: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exitCode = 1
})
