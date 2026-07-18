#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyWindowsAcceptanceRecord,
  resolveWindowsAcceptanceRecord
} from './lib/windows-acceptance-record.mjs'
import { loadValidatedWindowsAcceptanceHistory } from './lib/windows-acceptance-history.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  const acceptanceRecordUrl = requiredEnv('VIDEORC_WINDOWS_ACCEPTANCE_RECORD_URL')
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const priorAcceptedReleaseIds = await loadPriorAcceptedAlphaIds(manifest.releaseId)
  const resolved = await resolveWindowsAcceptanceRecord({
    expectations: {
      filename: manifest.filename,
      installerSha256: requiredEnv('VIDEORC_RELEASE_EXPECTED_SHA256'),
      publisherName: requiredEnv('VIDEORC_WINDOWS_PUBLISHER_NAME'),
      releasedAt: manifest.releasedAt,
      releaseId: requiredEnv('VIDEORC_RELEASE_ID'),
      sourceCommit: requiredEnv('VIDEORC_RELEASE_SOURCE_COMMIT'),
      priorAcceptedReleaseIds
    },
    url: acceptanceRecordUrl
  })
  assertRecordCommitOnTrustedMain(resolved.recordCommit)
  const accepted = applyWindowsAcceptanceRecord({
    acceptanceRecordUrl: resolved.publicUrl,
    manifest,
    priorAcceptedReleaseIds,
    record: resolved.record
  })
  const temporary = `${manifestPath}.accepted`
  try {
    await writeFile(temporary, `${JSON.stringify(accepted, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, manifestPath)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  console.log(
    `windows-acceptance-record: PASS (${resolved.record.candidateIdentity}, record commit ${resolved.recordCommit})`
  )
}

function assertRecordCommitOnTrustedMain(recordCommit) {
  const exists = spawnSync('git', ['cat-file', '-e', `${recordCommit}^{commit}`], {
    cwd: repoRoot,
    stdio: 'ignore'
  })
  if (exists.status !== 0) {
    throw new Error('Acceptance record commit is not reachable in the trusted repository checkout.')
  }
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', recordCommit, 'HEAD'], {
    cwd: repoRoot,
    stdio: 'ignore'
  })
  if (ancestor.status !== 0) {
    throw new Error('Acceptance record commit must be an ancestor of trusted main.')
  }
}

async function loadPriorAcceptedAlphaIds(releaseId) {
  const directory = join(repoRoot, 'docs', 'acceptance', 'windows-alpha')
  return (await loadValidatedWindowsAcceptanceHistory(directory)).filter(
    (acceptedReleaseId) => acceptedReleaseId !== releaseId
  )
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

main().catch((error) => {
  console.error(`windows-acceptance-record: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
