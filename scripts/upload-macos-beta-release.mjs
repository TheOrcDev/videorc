#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadChangelogEntries,
  mergeChangelogDocuments,
  requireChangelogEntryForRelease
} from './lib/changelog.mjs'
import {
  assertCaptureDecayCurrentProtectedMain,
  assertCaptureDecayD3PublicationGate
} from './lib/capture-decay-publication-git.mjs'
import {
  CAPTURE_DECAY_D3_DESTINATION_BINDING_ENV,
  buildCaptureDecayD3DestinationBinding
} from './lib/capture-decay-publication-attestation.mjs'
import { captureDecayCanonicalJsonSha256 } from './lib/capture-decay-release-acceptance.mjs'
import {
  assembleCaptureDecayD3PublicationReceipt,
  requireCaptureDecayD3PublishedReservation
} from './lib/capture-decay-publication-receipt-assembly.mjs'
import { sha256File } from './lib/beta-release-manifest.mjs'
import {
  macosD3CandidatePublicationArtifactMapping,
  normalizeMacosD3SealedCandidateBinding,
  verifyDownloadedMacosD3SealedCandidate
} from './lib/macos-d3-sealed-candidate.mjs'
import {
  assertMacosD3ExactPromotionUploadRoutes,
  buildMacosD3PublicationReservation,
  buildReleaseUploadPlan,
  exactMacosPromotionChangelogGeneratedAt,
  getReleaseUploadS3Config,
  MACOS_D3_PROMOTION_WORKFLOW_PATH,
  MACOS_RELEASE_REPOSITORY,
  publishReleaseUploadPhases,
  reverifyReleaseUploadPublication
} from './lib/release-upload-s3.mjs'
import { readRemoteTextObject } from './lib/windows-release-publication.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultReleaseDir = join(repoRoot, 'apps', 'desktop', 'release')

async function main() {
  const exactPromotion = envFlag(process.env.VIDEORC_CAPTURE_DECAY_D3_EXACT_PROMOTION)
  // Regular beta publication is never blocked by the D3 machinery: the
  // protected-Actions ref requirement, the pending freeze, and drift throws
  // apply only to the one-time exact sealed-candidate promotion (owner
  // decision, 2026-08-29 — releases must not be hostage to the ceremony).
  const d3Gate = await assertCaptureDecayD3PublicationGate({
    recordPath: join(repoRoot, 'docs', 'acceptance', 'macos-capture-decay-d3.json'),
    repoRoot,
    requireProtectedRef: exactPromotion,
    strict: exactPromotion
  })
  if (d3Gate.record.status === 'accepted' && !exactPromotion) {
    throw new Error(
      'the first accepted D3 release may be published only by exact sealed-candidate promotion'
    )
  }
  if (d3Gate.record.status !== 'accepted' && exactPromotion) {
    throw new Error('exact D3 promotion requires the committed record to remain accepted')
  }
  const publicationWorkflow =
    d3Gate.record.status === 'accepted' ? requiredPublicationWorkflow(d3Gate.headCommit) : null
  if (
    d3Gate.record.status === 'accepted' &&
    envFlag(process.env.VIDEORC_RELEASE_UPLOAD_SKIP_VERIFY)
  ) {
    throw new Error('the first accepted D3 publication forbids upload verification bypasses')
  }
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(defaultReleaseDir, 'release.json')
  )
  const releaseDir = resolve(process.env.VIDEORC_RELEASE_DIR ?? dirname(manifestPath))
  const sealedCandidate =
    d3Gate.record.status === 'accepted'
      ? normalizeMacosD3SealedCandidateBinding(d3Gate.record.sealedCandidate)
      : null
  const verifiedCandidate = sealedCandidate
    ? await verifyDownloadedMacosD3SealedCandidate({
        expectedSealedCandidate: sealedCandidate,
        outputDir: releaseDir
      })
    : null
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const config = getReleaseUploadS3Config()
  const changelogJsonPath = await prepareChangelogUpload(
    manifest.releaseId,
    config,
    exactPromotion ? { generatedAt: exactMacosPromotionChangelogGeneratedAt(manifest) } : undefined
  )
  const planned = await buildReleaseUploadPlan({
    changelogJsonPath,
    exactPromotion,
    manifest,
    manifestPath,
    releaseDir
  })
  const plan = {
    ...planned,
    artifacts: await Promise.all(
      planned.artifacts.map(async (artifact) => ({
        ...artifact,
        filename: basename(artifact.path),
        sha256: await sha256File(artifact.path)
      }))
    )
  }
  if (verifiedCandidate) {
    assertMacosD3ExactPromotionUploadRoutes({
      artifacts: plan.artifacts,
      prefix: plan.prefix,
      releaseManifest: manifest
    })
    assertExactSealedCandidatePublicationPlan({
      candidateManifest: verifiedCandidate.document,
      plan
    })
  }
  const manifestSha256 = await sha256File(manifestPath)
  let firstD3Publication = null
  if (d3Gate.record.status === 'accepted') {
    const reservation = buildMacosD3PublicationReservation({
      acceptedRecordSha256: captureDecayCanonicalJsonSha256(d3Gate.record),
      artifacts: plan.artifacts,
      config,
      manifestSha256,
      prefix: plan.prefix,
      publicationSourceCommit: d3Gate.headCommit,
      releaseId: plan.releaseId,
      sealedCandidateArtifactSetSha256: sealedCandidate.artifactSetSha256,
      sealedCandidateManifestSha256: sealedCandidate.manifest.sha256,
      workflow: {
        path: MACOS_D3_PROMOTION_WORKFLOW_PATH,
        repository: publicationWorkflow.repository,
        runId: publicationWorkflow.runId
      }
    })
    const destinationBinding = buildCaptureDecayD3DestinationBinding({
      artifacts: plan.artifacts,
      config,
      reservation
    })
    const requiredDestinationBinding = requiredSha256Environment(
      CAPTURE_DECAY_D3_DESTINATION_BINDING_ENV
    )
    const acceptedDestinationBinding =
      d3Gate.record?.validator?.publication?.destinationBindingSha256
    if (
      destinationBinding.sha256 !== requiredDestinationBinding ||
      destinationBinding.sha256 !== acceptedDestinationBinding
    ) {
      throw new Error(
        'the computed publication destination/upload plan does not match the preaccepted D3 destination binding'
      )
    }
    firstD3Publication = { destinationBinding, reservation }
  }

  if (exactPromotion) {
    try {
      await assertCaptureDecayCurrentProtectedMain({
        env: process.env,
        headCommit: d3Gate.headCommit
      })
    } finally {
      delete process.env.VIDEORC_GITHUB_API_TOKEN
    }
  }

  console.log(
    `macos-beta-release-upload: uploading ${plan.releaseId} to s3://${config.bucket}/${plan.prefix}`
  )

  const verifyAfterPut = !envFlag(process.env.VIDEORC_RELEASE_UPLOAD_SKIP_VERIFY)
  const publicationResults = await publishReleaseUploadPhases({
    artifacts: plan.artifacts,
    config,
    onPublished: ({ artifact, result }) => {
      console.log(
        `macos-beta-release-upload: ${result.action} ${artifact.label} ${artifact.sizeBytes} bytes -> ${artifact.objectKey}`
      )
    },
    reservationArtifactFactory: firstD3Publication
      ? async () => firstD3Publication.reservation.artifact
      : null,
    verifyAfterPut
  })

  if (d3Gate.record.status === 'accepted') {
    const publishedReservation = requireCaptureDecayD3PublishedReservation(
      publicationResults,
      publicationWorkflow
    )
    const finalPublicationResults = await reverifyReleaseUploadPublication({
      artifacts: plan.artifacts,
      config,
      publicationResults,
      reservationArtifact: publishedReservation.artifact
    })
    const receipt = assembleCaptureDecayD3PublicationReceipt({
      acceptedRecord: d3Gate.record,
      destinationBinding: firstD3Publication.destinationBinding,
      manifest,
      manifestSha256,
      publicationResults: finalPublicationResults,
      publicationSourceCommit: d3Gate.headCommit,
      publicationWorkflow,
      sealedCandidate,
      sealedCandidateManifest: verifiedCandidate.document
    })
    const receiptPath = resolve(
      process.env.VIDEORC_CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PATH ??
        join(releaseDir, 'capture-decay-d3-publication-receipt.json')
    )
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    console.log(`macos-beta-release-upload: wrote D3 publication receipt ${receiptPath}`)
  }

  console.log('macos-beta-release-upload: PASS')
}

// Fail-closed: a release cannot ship without a user-facing changelog entry for
// its releaseId. VIDEORC_RELEASE_SKIP_CHANGELOG=1 is the emergency escape — it
// warns loudly and still publishes whatever entries DO validate.
async function prepareChangelogUpload(
  releaseId,
  config,
  { generatedAt = new Date().toISOString() } = {}
) {
  const skip = envFlag(process.env.VIDEORC_RELEASE_SKIP_CHANGELOG)
  let entries
  try {
    entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  } catch (error) {
    if (!skip) {
      throw error
    }
    console.warn(
      `macos-beta-release-upload: WARNING changelog invalid and VIDEORC_RELEASE_SKIP_CHANGELOG is set — shipping WITHOUT a changelog update (${error.message})`
    )
    return null
  }

  const { skipped } = requireChangelogEntryForRelease(entries, releaseId, { skip })
  if (skipped) {
    console.warn(
      `macos-beta-release-upload: WARNING no changelog entry for ${releaseId} and VIDEORC_RELEASE_SKIP_CHANGELOG is set — the website and What's New will not show this release`
    )
  }

  const outPath = join(repoRoot, 'dist', 'changelog', 'changelog.json')
  const remoteText = await readRemoteTextObject({
    config,
    objectKey: 'changelog/changelog.json'
  })
  const document = mergeChangelogDocuments({
    generatedAt,
    localEntries: entries,
    remoteDocument: parseRemoteChangelog(remoteText)
  })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`)
  console.log(
    `macos-beta-release-upload: changelog compiled (${entries.length} entries, latest ${entries[0].version})`
  )
  return outPath
}

function parseRemoteChangelog(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Published changelog/changelog.json is not valid JSON.')
  }
}

function requiredPublicationWorkflow(headCommit) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('the first accepted D3 candidate must be published by GitHub Actions')
  }
  const workflow = {
    repository: requiredEnvironment('GITHUB_REPOSITORY'),
    path: MACOS_D3_PROMOTION_WORKFLOW_PATH,
    runId: requiredEnvironment('GITHUB_RUN_ID'),
    runAttempt: requiredEnvironment('GITHUB_RUN_ATTEMPT'),
    sha: requiredEnvironment('GITHUB_SHA')
  }
  if (workflow.repository !== MACOS_RELEASE_REPOSITORY) {
    throw new Error(
      `the first accepted D3 candidate must be published from ${MACOS_RELEASE_REPOSITORY}`
    )
  }
  const workflowRef = requiredEnvironment('GITHUB_WORKFLOW_REF')
  const requiredWorkflowRefPrefix = `${MACOS_RELEASE_REPOSITORY}/${MACOS_D3_PROMOTION_WORKFLOW_PATH}@`
  if (!workflowRef.startsWith(requiredWorkflowRefPrefix)) {
    throw new Error(
      `the first accepted D3 candidate must be published by ${MACOS_D3_PROMOTION_WORKFLOW_PATH}`
    )
  }
  if (workflow.sha !== headCommit) {
    throw new Error(`GitHub publication SHA ${workflow.sha} does not match checkout ${headCommit}`)
  }
  return workflow
}

function assertExactSealedCandidatePublicationPlan({ candidateManifest, plan }) {
  const sealedMappings = macosD3CandidatePublicationArtifactMapping(candidateManifest)
  const plannedByLabel = new Map(plan.artifacts.map((artifact) => [artifact.label, artifact]))
  const publicationLabels = new Map([
    ['dmg', ['dmg']],
    ['sha256', ['sha256']],
    ['manifest', ['manifest', 'latest-manifest']],
    ['feed-zip', ['feed-zip']],
    ['feed-blockmap', ['feed-blockmap']],
    ['feed-manifest', ['feed-manifest']]
  ])
  for (const sealed of sealedMappings) {
    const labels = publicationLabels.get(sealed.candidateLabel)
    if (!labels) {
      throw new Error(`sealed candidate has unsupported artifact label ${sealed.candidateLabel}`)
    }
    for (const label of labels) {
      const planned = plannedByLabel.get(label)
      if (
        !planned ||
        planned.filename !== sealed.filename ||
        planned.sha256 !== sealed.sha256 ||
        planned.sizeBytes !== sealed.sizeBytes ||
        planned.contentType !== sealed.contentType
      ) {
        throw new Error(
          `publication route ${label} does not preserve exact sealed ${sealed.candidateLabel} bytes`
        )
      }
    }
  }
  const allowedLabels = new Set([...[...publicationLabels.values()].flat(), 'changelog'])
  if (plan.artifacts.some((artifact) => !allowedLabels.has(artifact.label))) {
    throw new Error('exact D3 promotion contains an unreviewed publication artifact')
  }
}

function requiredSha256Environment(name) {
  const value = requiredEnvironment(name).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`)
  }
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the first accepted D3 publication`)
  return value
}

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

main().catch((error) => {
  console.error(`macos-beta-release-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
