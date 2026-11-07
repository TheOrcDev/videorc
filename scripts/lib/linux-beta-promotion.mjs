import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assessLinuxBetaAcceptance,
  verifyLinuxBetaEvidenceFiles
} from './linux-beta-acceptance.mjs'
import {
  assertLinuxCandidateCoordinates,
  assertPendingLinuxCandidateManifest,
  buildLinuxCandidateStoragePlan
} from './linux-release-candidate.mjs'
import { assertLinuxReleaseManifest } from './linux-release.mjs'

const commitPattern = /^[a-f0-9]{40}$/
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Preparation only: no network, storage mutation or candidate-code execution.
// A protected finalizer must reverify current main, build provenance/payload,
// remote state, origin ordering and its publication journal before any writes.
export async function buildLinuxBetaPublicPromotionPlan({
  candidateDirectory,
  coordinates,
  trustedMainCommit,
  acceptanceRecordUrl,
  evidenceRoot,
  git,
  now = new Date()
}) {
  assertLinuxCandidateCoordinates(coordinates)
  if (!coordinates.appImageSha256) throw new Error('An expected AppImage SHA-256 is required.')
  if (!commitPattern.test(trustedMainCommit ?? ''))
    throw new Error('An exact trusted main commit is required.')
  const manifestPath = join(candidateDirectory, 'release.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assertPendingLinuxCandidateManifest(manifest, coordinates)
  if (manifest.channel !== 'beta') throw new Error('This plan prepares only Linux Beta.')
  const publicManifest = {
    ...manifest,
    stage: 'public',
    acceptanceStatus: 'pass',
    acceptanceRecordUrl
  }
  assertLinuxReleaseManifest(publicManifest, { requireAccepted: true })
  // The manifest validator has already required the canonical, exact-release,
  // commit-pinned repository URL. Read its blob from Git, never a working file.
  const recordCommit = new URL(acceptanceRecordUrl).pathname.split('/')[4]
  const recordPath = `docs/acceptance/linux-beta/${manifest.releaseId}.json`
  for (const [label, commit] of [
    ['candidate source', manifest.sourceCommit],
    ['acceptance record', recordCommit]
  ]) {
    if (!(await git.isAncestor(commit, trustedMainCommit)))
      throw new Error(`The ${label} commit must be an ancestor of trusted main.`)
  }
  if (!(await git.isAncestor(manifest.sourceCommit, recordCommit)))
    throw new Error('The acceptance record must descend from the candidate source commit.')
  const packageBytes = await git.readBlob(trustedMainCommit, 'apps/desktop/package.json', 65536)
  if (JSON.parse(packageBytes.toString('utf8')).version !== manifest.bundleVersion)
    throw new Error('The candidate must match the numeric package version on trusted main.')
  const recordBytes = await git.readBlob(recordCommit, recordPath, 1024 * 1024)
  const record = JSON.parse(recordBytes.toString('utf8'))
  const acceptance = assessLinuxBetaAcceptance(record, manifest, { now })
  if (!acceptance.ok) throw new Error(`Beta acceptance failed:\n${acceptance.failures.join('\n')}`)
  const evidence = await verifyLinuxBetaEvidenceFiles(record, evidenceRoot)
  const candidate = await buildLinuxCandidateStoragePlan({
    manifest,
    manifestPath,
    releaseDir: candidateDirectory,
    ffmpegLicensePath: join(candidateDirectory, 'FFMPEG-LICENSE.txt'),
    ffmpegSourcePath: join(candidateDirectory, 'FFMPEG-SOURCE.txt')
  })
  const releasePrefix = `releases/linux-beta/${manifest.releaseId}`
  const immutable = candidate.artifacts
    .filter((artifact) => artifact.label !== 'manifest')
    .map((artifact) => ({
      label: artifact.label,
      objectKey: `${releasePrefix}/${artifact.filename}`,
      contentType: artifact.contentType,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      sourceObjectKey: artifact.objectKey
    }))
  const manifestBody = `${JSON.stringify(publicManifest, null, 2)}\n`
  const manifestArtifact = inlineArtifact('manifest', `${releasePrefix}/release.json`, manifestBody)
  immutable.push(manifestArtifact)
  const appImage = immutable.find((artifact) => artifact.label === 'appimage')
  immutable.push({ ...appImage, objectKey: `updates/linux-beta/${manifest.filename}` })
  const feed = immutable.find((artifact) => artifact.label === 'update-feed')
  return {
    schemaVersion: 1,
    mode: 'read-only',
    requiresProtectedFinalizer: true,
    platform: 'linux',
    channel: 'beta',
    stage: 'public',
    candidateIdentity: candidate.candidateIdentity,
    candidateManifestSha256: candidate.artifacts.find((artifact) => artifact.label === 'manifest')
      .sha256,
    trustedMainCommit,
    acceptance: {
      recordUrl: acceptanceRecordUrl,
      recordCommit,
      recordSha256: digest(recordBytes),
      ...evidence
    },
    manifest: publicManifest,
    immutable,
    // Descriptions, not executable writes. The finalizer must bind each to
    // inspected prior bytes/ETags and refuse regressions or uncertain writes.
    pointers: [
      { ...feed, objectKey: 'updates/linux-beta/latest-linux.yml' },
      { ...manifestArtifact, objectKey: 'releases/linux-beta/latest/release.json' }
    ]
  }
}

function inlineArtifact(label, objectKey, body) {
  const bytes = Buffer.from(body)
  return {
    label,
    objectKey,
    contentType: 'application/json',
    sha256: digest(bytes),
    sizeBytes: bytes.byteLength,
    bodyBase64: bytes.toString('base64')
  }
}

export function linuxPromotionGitReader(repoRoot) {
  const options = { cwd: repoRoot, timeout: 30_000, windowsHide: true }
  return {
    isAncestor(commit, trustedMainCommit) {
      if (!commitPattern.test(commit) || !commitPattern.test(trustedMainCommit))
        throw new Error('Git ancestry requires full lowercase commits.')
      const result = spawnSync(
        'git',
        ['--no-replace-objects', 'merge-base', '--is-ancestor', commit, trustedMainCommit],
        { ...options, stdio: 'ignore' }
      )
      if (result.error || (result.status !== 0 && result.status !== 1))
        throw new Error('Unable to verify promotion ancestry in the trusted repository.')
      return result.status === 0
    },
    readBlob(commit, path, maxBytes) {
      if (!commitPattern.test(commit)) throw new Error('Git blob reads require an exact commit.')
      try {
        return execFileSync(
          'git',
          ['--no-replace-objects', 'cat-file', 'blob', `${commit}:${path}`],
          {
            ...options,
            maxBuffer: maxBytes,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
      } catch {
        throw new Error('Missing or oversized promotion record in the trusted Git tree.')
      }
    }
  }
}
