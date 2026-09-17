import { basename } from 'node:path'

import {
  buildCaptureDecayD3PublicationReceipt,
  captureDecayCanonicalJsonSha256
} from './capture-decay-release-acceptance.mjs'
import { macosD3CandidatePublicationArtifactMapping } from './macos-d3-sealed-candidate.mjs'

const PROMOTION_PUBLICATION_LABELS = new Map([
  ['dmg', ['dmg']],
  ['sha256', ['sha256']],
  ['manifest', ['manifest', 'latest-manifest']],
  ['feed-zip', ['feed-zip']],
  ['feed-blockmap', ['feed-blockmap']],
  ['feed-manifest', ['feed-manifest']]
])

/**
 * Assemble the D3 receipt from the final, re-read publication result set.
 *
 * In particular, an adopted reservation has two different authoritative
 * identities: its immutable document retains the creator workflow, while the
 * upload result identifies the current publisher that completed the release.
 * Keeping this edge in one pure helper prevents CLI resumption code from
 * accidentally substituting its proposed reservation or the creator run for
 * either side of that contract.
 */
export function assembleCaptureDecayD3PublicationReceipt({
  acceptedRecord,
  destinationBinding,
  manifest,
  manifestSha256,
  publicationResults,
  publicationSourceCommit,
  publicationWorkflow,
  publishedAt,
  sealedCandidate,
  sealedCandidateManifest
}) {
  const reservationResult = requireCaptureDecayD3PublishedReservation(
    publicationResults,
    publicationWorkflow
  )
  const releaseArtifactResults = publicationResults.filter(
    (entry) => entry?.phase !== 'reservation'
  )
  if (releaseArtifactResults.length === 0) {
    throw new Error('the verified D3 publication contains no release artifact results')
  }
  const workflow = currentPublisherReceiptWorkflow({
    publicationWorkflow,
    publisherWorkflow: reservationResult.result.publisherWorkflow
  })
  const reservationDocument = reservationResult.result.reservationDocument

  return buildCaptureDecayD3PublicationReceipt({
    acceptedRecord,
    acceptedRecordSha256: captureDecayCanonicalJsonSha256(acceptedRecord),
    artifacts: releaseArtifactResults.map(publicationEvidenceFromResult),
    destinationBinding,
    destinationBindingSha256: destinationBinding?.sha256,
    manifest,
    manifestSha256,
    promotedArtifacts: exactPromotionMappings({
      candidateManifest: sealedCandidateManifest,
      publicationResults: releaseArtifactResults
    }),
    publicationSourceCommit,
    publishedAt,
    reservation: {
      profile: reservationDocument?.profile,
      ...publicationEvidenceFromResult(reservationResult, { reservation: true }),
      document: reservationDocument
    },
    sealedCandidate,
    sealedCandidateManifest,
    workflow
  })
}

export function requireCaptureDecayD3PublishedReservation(publicationResults, publicationWorkflow) {
  if (!Array.isArray(publicationResults)) {
    throw new Error('the verified D3 publication result set is missing')
  }
  const reservations = publicationResults.filter((candidate) => candidate?.phase === 'reservation')
  if (reservations.length !== 1) {
    throw new Error('the verified D3 publication must contain exactly one reservation result')
  }
  const [entry] = reservations
  const result = entry?.result
  const publisher = result?.publisherWorkflow
  if (
    entry.artifact?.label !== 'd3-publication-reservation' ||
    !result?.reservationDocument ||
    publisher?.repository !== publicationWorkflow?.repository ||
    publisher?.path !== publicationWorkflow?.path ||
    publisher?.runId !== publicationWorkflow?.runId ||
    publisher?.sourceCommit !== publicationWorkflow?.sha
  ) {
    throw new Error(
      'the verified D3 publication must retain its actual reservation document and current publisher identity'
    )
  }
  return entry
}

function currentPublisherReceiptWorkflow({ publicationWorkflow, publisherWorkflow }) {
  return {
    repository: publisherWorkflow.repository,
    path: publisherWorkflow.path,
    runId: publisherWorkflow.runId,
    runAttempt: publicationWorkflow.runAttempt,
    sha: publisherWorkflow.sourceCommit
  }
}

function exactPromotionMappings({ candidateManifest, publicationResults }) {
  const evidenceByLabel = new Map(
    publicationResults.map((entry) => [entry.artifact?.label, publicationEvidenceFromResult(entry)])
  )
  return macosD3CandidatePublicationArtifactMapping(candidateManifest).flatMap((sealed) => {
    const labels = PROMOTION_PUBLICATION_LABELS.get(sealed.candidateLabel)
    if (!labels) {
      throw new Error(`sealed candidate has unsupported artifact label ${sealed.candidateLabel}`)
    }
    return labels.map((label) => {
      const published = evidenceByLabel.get(label)
      if (!published) {
        throw new Error(`exact D3 promotion is missing publication evidence for ${label}`)
      }
      return {
        candidateLabel: sealed.candidateLabel,
        candidateObjectKey: sealed.sealedObjectKey,
        publicationLabel: label,
        publicationObjectKey: published.objectKey,
        sha256: published.sha256,
        sizeBytes: published.sizeBytes
      }
    })
  })
}

function publicationEvidenceFromResult(entry, { reservation = false } = {}) {
  const artifact = entry?.artifact
  const result = entry?.result
  return {
    ...(reservation
      ? {}
      : {
          label: artifact?.label,
          filename: artifact?.filename ?? basename(artifact?.objectKey ?? '')
        }),
    objectKey: artifact?.objectKey,
    sha256: artifact?.sha256,
    sizeBytes: artifact?.sizeBytes,
    ...(reservation ? {} : { contentType: artifact?.contentType }),
    immutable: artifact?.immutable,
    phase: entry?.phase,
    action: result?.action,
    verification: result?.verification
      ? {
          state: result.verification.state,
          sha256: result.verification.sha256,
          sizeBytes: result.verification.sizeBytes,
          etag: result.verification.etag ?? null,
          contentType: result.verification.contentType,
          contentLength: result.verification.contentLength,
          metadataSha256: result.verification.metadataSha256,
          checksumSha256: result.verification.checksumSha256
        }
      : null
  }
}
