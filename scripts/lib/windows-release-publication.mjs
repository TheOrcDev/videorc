import { createHash } from 'node:crypto'

import { buildSignedS3Request, createReleaseUploadS3Transport } from './release-upload-s3.mjs'
import { compareNumericVersions, updateFeedVersionFromYml } from './windows-alpha-release.mjs'

export class WindowsReleasePublicationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WindowsReleasePublicationError'
    this.code = code
  }
}

export function assertWindowsFeedTransition({
  acceptedReleaseIds,
  currentFeedYml,
  nextFeedYml,
  stage,
  trustedCurrentVersion
}) {
  if (!['pilot', 'public'].includes(stage)) {
    throw new WindowsReleasePublicationError(
      'invalid-release-stage',
      'Windows release stage must be pilot or public.'
    )
  }
  const nextVersion = updateFeedVersionFromYml(nextFeedYml)
  if (!nextVersion) {
    throw new WindowsReleasePublicationError(
      'invalid-published-feed',
      'The candidate latest.yml must contain a numeric version.'
    )
  }
  if (trustedCurrentVersion !== nextVersion) {
    throw new WindowsReleasePublicationError(
      'candidate-not-current-version',
      `Windows candidate ${nextVersion} must match trusted main package version ${trustedCurrentVersion ?? '(missing)'}.`
    )
  }
  const acceptedVersions = acceptedUpdaterVersions(acceptedReleaseIds)
  const highestAcceptedVersion = acceptedVersions.at(-1) ?? null
  if (highestAcceptedVersion && compareNumericVersions(nextVersion, highestAcceptedVersion) < 0) {
    throw new WindowsReleasePublicationError(
      'accepted-version-regression',
      `Windows candidate ${nextVersion} must not regress below accepted public version ${highestAcceptedVersion}.`
    )
  }
  if (stage === 'public' && !acceptedReleaseIds.includes(`${nextVersion}-alpha.1`)) {
    throw new WindowsReleasePublicationError(
      'candidate-not-accepted',
      `Public Windows candidate ${nextVersion} must have an exact validated PASS record.`
    )
  }
  if (currentFeedYml === null) {
    const olderAcceptedVersions = acceptedVersions.filter(
      (version) => compareNumericVersions(version, nextVersion) < 0
    )
    if (stage === 'public' && olderAcceptedVersions.length > 0) {
      throw new WindowsReleasePublicationError(
        'published-feed-missing',
        'Public latest.yml is missing even though trusted release history proves an earlier public release; recover it explicitly before promotion.'
      )
    }
    return { highestAcceptedVersion, kind: 'first-release', nextVersion, stage }
  }
  const currentVersion = updateFeedVersionFromYml(currentFeedYml)
  if (!currentVersion) {
    throw new WindowsReleasePublicationError(
      'invalid-published-feed',
      'The published latest.yml must contain a numeric version.'
    )
  }
  const comparison = compareNumericVersions(nextVersion, currentVersion)
  if (comparison < 0) {
    throw new WindowsReleasePublicationError(
      'update-version-regression',
      `Windows updater version ${nextVersion} must not replace newer ${currentVersion}.`
    )
  }
  if (comparison === 0 && nextFeedYml !== currentFeedYml) {
    throw new WindowsReleasePublicationError(
      'update-version-not-advanced',
      `Windows candidate ${nextVersion} changes the feed without increasing its updater version.`
    )
  }
  return {
    currentVersion,
    kind: comparison === 0 ? 'idempotent' : 'advance',
    nextVersion,
    stage
  }
}

function acceptedUpdaterVersions(releaseIds) {
  if (!Array.isArray(releaseIds)) {
    throw new WindowsReleasePublicationError(
      'missing-acceptance-history',
      'Promotion must load validated Windows acceptance history from trusted main.'
    )
  }
  const versions = releaseIds.map((releaseId) => {
    const match = /^(\d+\.\d+\.\d+)-alpha\.1$/.exec(releaseId)
    if (!match) {
      throw new WindowsReleasePublicationError(
        'invalid-acceptance-history',
        `Trusted Windows acceptance history contains invalid release id ${releaseId}.`
      )
    }
    return match[1]
  })
  return [...new Set(versions)].sort(compareNumericVersions)
}

export async function readRemoteTextObject({
  config,
  maxBytes = 2 * 1024 * 1024,
  objectKey,
  transport = null
}) {
  const activeTransport = transport ?? createReleaseUploadS3Transport({ config })
  const ownsTransport = transport === null
  try {
    const response = await signedRequest({
      config,
      method: 'GET',
      objectKey,
      transport: activeTransport
    })
    if (response.status === 404) {
      await discardBody(response.body)
      return null
    }
    if (!response.ok || !response.body) {
      await discardBody(response.body)
      throw new WindowsReleasePublicationError(
        'remote-read-failed',
        `Could not read s3://${config.bucket}/${objectKey}: HTTP ${response.status}.`
      )
    }
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await discardBody(response.body)
      throw new WindowsReleasePublicationError(
        'remote-read-too-large',
        `Refusing oversized text object s3://${config.bucket}/${objectKey}.`
      )
    }
    const bytes = await readBoundedBody(response.body, maxBytes, objectKey, config)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new WindowsReleasePublicationError(
        'remote-read-invalid-text',
        `Remote text object s3://${config.bucket}/${objectKey} is not valid UTF-8.`
      )
    }
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

export async function inspectRemoteArtifact({ artifact, config, transport = null }) {
  const activeTransport = transport ?? createReleaseUploadS3Transport({ config })
  const ownsTransport = transport === null
  try {
    const response = await signedRequest({
      config,
      method: 'GET',
      objectKey: artifact.objectKey,
      transport: activeTransport
    })
    if (response.status === 404) {
      await discardBody(response.body)
      return { state: 'missing' }
    }
    if (!response.ok || !response.body) {
      await discardBody(response.body)
      throw new WindowsReleasePublicationError(
        'remote-verification-failed',
        `Could not verify s3://${config.bucket}/${artifact.objectKey}: HTTP ${response.status}.`
      )
    }

    const hash = createHash('sha256')
    let sizeBytes = 0
    for await (const chunk of response.body) {
      hash.update(chunk)
      sizeBytes += chunk.byteLength
    }
    const sha256 = hash.digest('hex')
    if (sizeBytes !== artifact.sizeBytes || sha256 !== artifact.sha256) {
      throw new WindowsReleasePublicationError(
        'remote-artifact-mismatch',
        `Existing s3://${config.bucket}/${artifact.objectKey} does not match the local SHA-256 and byte size.`
      )
    }
    return { sha256, sizeBytes, state: 'identical' }
  } finally {
    if (ownsTransport) activeTransport.close()
  }
}

async function signedRequest({ config, method, objectKey, transport }) {
  const signed = buildSignedS3Request({ config, method, objectKey })
  return await transport.request(signed.url, { headers: signed.headers, method })
}

async function readBoundedBody(body, maxBytes, objectKey, config) {
  const chunks = []
  let sizeBytes = 0
  for await (const chunk of body) {
    sizeBytes += chunk.byteLength
    if (sizeBytes > maxBytes) {
      throw new WindowsReleasePublicationError(
        'remote-read-too-large',
        `Refusing oversized text object s3://${config.bucket}/${objectKey}.`
      )
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function discardBody(body, maximumBytes = 64 * 1024) {
  if (!body) return
  let sizeBytes = 0
  for await (const chunk of body) {
    sizeBytes += chunk.byteLength
    if (sizeBytes > maximumBytes) break
  }
}
