// Release storage origins.
//
// Court-ordered IP blocks in Spain intermittently intercept whole storage
// providers, which stops both the release upload and every Spanish user's
// download. A release is therefore published to every configured origin, and a
// blocked origin degrades the publication instead of stopping it. See
// docs/releases/storage-compat-2026-09.md and the release runbook.
//
//   r2        the long-standing origin. It keeps the uploader's original
//             environment names (VIDEORC_RELEASE_UPLOAD_S3_* with the
//             VIDEORC_DOWNLOAD_S3_* fallback) so nothing existing changes.
//   hetzner   VIDEORC_RELEASE_UPLOAD_HETZNER_S3_*.
//   neon      VIDEORC_RELEASE_UPLOAD_NEON_S3_* (Neon Object Storage, the
//             target single origin).
//
// Only configured origins are published to, so a single origin (for example
// neon alone, with no r2 environment at all) is a complete setup, and a
// mirror is re-added by environment only.
//
// VIDEORC_DOWNLOAD_STORAGE_PRIMARY names the origin videorc-web redirects to
// (default r2). Origins are always published mirrors first, primary last, so
// the pointers most clients read move only after every other origin is done.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  getReleaseUploadS3Config,
  ReleaseUploadConfigError
} from './release-upload-s3.mjs'

export const LEGACY_RELEASE_UPLOAD_ORIGIN = 'r2'
export const ADDITIONAL_RELEASE_UPLOAD_ORIGINS = ['hetzner', 'neon']
export const RELEASE_ORIGIN_PENDING_SCHEMA_VERSION = 1

const ORIGIN_ENV_SUFFIXES = [
  'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
  'SESSION_TOKEN',
  'BUCKET',
  'REGION',
  'ENDPOINT_URL',
  'FORCE_PATH_STYLE',
  'TLS_ALLOWED_ISSUER_ORGANIZATIONS',
  'TLS_ALLOWED_SPKI_SHA256'
]

// Status codes that prove the origin itself answered a signed request. 403 is
// deliberately absent: a rejected credential is a configuration error, not a
// blocked network path, and must never be papered over by the other origin.
const REACHABLE_PROBE_STATUSES = new Set([200, 404])

export function releaseUploadOriginEnvironment(name, env) {
  if (name === LEGACY_RELEASE_UPLOAD_ORIGIN) return env
  const mapped = {}
  for (const suffix of ORIGIN_ENV_SUFFIXES) {
    const value = env[`VIDEORC_RELEASE_UPLOAD_${name.toUpperCase()}_S3_${suffix}`]
    if (typeof value === 'string' && value.trim()) {
      mapped[`VIDEORC_RELEASE_UPLOAD_S3_${suffix}`] = value
    }
  }
  return mapped
}

function originIsConfigured(name, env) {
  if (name === LEGACY_RELEASE_UPLOAD_ORIGIN) {
    return Boolean(
      env.VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID?.trim() ||
      env.VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID?.trim()
    )
  }
  return Boolean(env[`VIDEORC_RELEASE_UPLOAD_${name.toUpperCase()}_S3_ACCESS_KEY_ID`]?.trim())
}

// Mirrors first, primary last. A single configured origin is exactly the
// uploader's historical behaviour.
export function resolveReleaseUploadOrigins(env = process.env) {
  const known = [LEGACY_RELEASE_UPLOAD_ORIGIN, ...ADDITIONAL_RELEASE_UPLOAD_ORIGINS]
  const explicitPrimary = env.VIDEORC_DOWNLOAD_STORAGE_PRIMARY?.trim().toLowerCase() || null
  const primaryName = explicitPrimary ?? LEGACY_RELEASE_UPLOAD_ORIGIN
  if (!known.includes(primaryName)) {
    throw new ReleaseUploadConfigError(
      'unknown-primary-origin',
      `VIDEORC_DOWNLOAD_STORAGE_PRIMARY must be one of ${known.join(', ')}.`
    )
  }
  const configured = known.filter((name) => originIsConfigured(name, env))
  if (!configured.includes(primaryName)) {
    throw new ReleaseUploadConfigError(
      'primary-origin-not-configured',
      `The primary release origin ${primaryName} has no credentials in this environment.` +
        (explicitPrimary
          ? ''
          : ` VIDEORC_DOWNLOAD_STORAGE_PRIMARY is unset, so it defaults to ${LEGACY_RELEASE_UPLOAD_ORIGIN}; set it to the configured primary${configured.length ? ` (configured: ${configured.join(', ')})` : ''}.`)
    )
  }
  const origins = configured
    .map((name) => ({
      config: getReleaseUploadS3Config(releaseUploadOriginEnvironment(name, env)),
      name
    }))
    .sort((left, right) => Number(left.name === primaryName) - Number(right.name === primaryName))
  const destinations = new Set(
    origins.map(({ config }) => `${config.endpointUrl ?? 'aws'}|${config.bucket}`)
  )
  if (destinations.size !== origins.length) {
    throw new ReleaseUploadConfigError(
      'duplicate-origin-destination',
      'Two release origins resolve to the same endpoint and bucket.'
    )
  }
  return { origins, primaryName }
}

// One signed HEAD on a stable key. A transport failure (forged issuer, reset,
// timeout) means the path to the origin is blocked; any other unexpected
// answer is a hard configuration error.
export async function probeReleaseUploadOrigin({
  config,
  objectKey = 'changelog/changelog.json',
  transportFactory = createReleaseUploadS3Transport
}) {
  const transport = transportFactory({ config })
  try {
    const signed = buildSignedS3Request({ config, method: 'HEAD', objectKey })
    let response
    try {
      response = await transport.request(signed.url, { headers: signed.headers, method: 'HEAD' })
    } catch (error) {
      return {
        reachable: false,
        reason: `${error?.code ?? error?.name ?? 'transport-error'}: ${error?.message ?? 'request failed'}`
      }
    }
    response.body?.resume?.()
    if (!REACHABLE_PROBE_STATUSES.has(response.status)) {
      throw new ReleaseUploadConfigError(
        'origin-probe-rejected',
        `Release origin ${new URL(signed.url).host} answered HTTP ${response.status} to a signed probe. Check its credentials, bucket and region.`
      )
    }
    return { reachable: true, reason: null }
  } finally {
    transport.close()
  }
}

// Decides which origins this publication may write to. Publishing to the
// mirror alone leaves the primary serving the previous release, so it needs an
// explicit opt-in and tells the operator how to move clients over.
export async function planReleaseUploadOrigins({
  allowMirrorOnly = false,
  env = process.env,
  probe = probeReleaseUploadOrigin
} = {}) {
  const { origins, primaryName } = resolveReleaseUploadOrigins(env)
  const probed = []
  for (const origin of origins) {
    probed.push({ ...origin, ...(await probe({ config: origin.config })) })
  }
  const reachable = probed.filter((origin) => origin.reachable)
  const blocked = probed.filter((origin) => !origin.reachable)
  if (reachable.length === 0) {
    throw new ReleaseUploadConfigError(
      'no-reachable-origin',
      `No release origin is reachable: ${blocked.map((origin) => `${origin.name} (${origin.reason})`).join('; ')}.`
    )
  }
  const primaryBlocked = blocked.some((origin) => origin.name === primaryName)
  if (primaryBlocked && !allowMirrorOnly) {
    throw new ReleaseUploadConfigError(
      'primary-origin-blocked',
      `The primary release origin ${primaryName} is unreachable (${blocked.find((origin) => origin.name === primaryName).reason}). ` +
        `Set VIDEORC_RELEASE_ALLOW_MIRROR_ONLY=1 to publish to ${reachable.map((origin) => origin.name).join(', ')} only, ` +
        `then set VIDEORC_DOWNLOAD_STORAGE_PRIMARY=${reachable.at(-1).name} in the videorc-web production environment and redeploy so clients follow.`
    )
  }
  return { blocked, primaryBlocked, primaryName, reachable }
}

export function releaseOriginPendingDir(repoRoot) {
  return join(repoRoot, 'dist', 'release-origin-pending')
}

export async function writeReleaseOriginPending({
  artifacts,
  blocked,
  platform,
  releaseId,
  repoRoot
}) {
  const dir = releaseOriginPendingDir(repoRoot)
  await mkdir(dir, { recursive: true })
  const written = []
  for (const origin of blocked) {
    const path = join(dir, `${platform}-${releaseId}-${origin.name}.json`)
    const document = {
      schemaVersion: RELEASE_ORIGIN_PENDING_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      origin: origin.name,
      platform,
      reason: origin.reason,
      releaseId,
      artifacts: artifacts.map((artifact) => ({
        contentType: artifact.contentType,
        immutable: artifact.immutable === true,
        label: artifact.label,
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes
      }))
    }
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    written.push(path)
  }
  return written
}

export async function readReleaseOriginPending(repoRoot) {
  const dir = releaseOriginPendingDir(repoRoot)
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const pending = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(dir, name)
    const document = JSON.parse(await readFile(path, 'utf8'))
    if (
      document?.schemaVersion !== RELEASE_ORIGIN_PENDING_SCHEMA_VERSION ||
      typeof document.origin !== 'string' ||
      !Array.isArray(document.artifacts)
    ) {
      throw new ReleaseUploadConfigError(
        'invalid-origin-pending-file',
        `Unreadable pending-origin record ${path}.`
      )
    }
    pending.push({ document, path })
  }
  return pending
}

export async function clearReleaseOriginPending(path) {
  await rm(path, { force: true })
}

// A release must not be stacked on top of an origin that still misses the
// previous one: its pointers would skip a version that origin never received.
export async function assertNoReleaseOriginPending(repoRoot) {
  const pending = await readReleaseOriginPending(repoRoot)
  if (pending.length === 0) return
  throw new ReleaseUploadConfigError(
    'origin-sync-pending',
    `An earlier release is still missing from ${[...new Set(pending.map(({ document }) => document.origin))].join(', ')}: ` +
      `${pending.map(({ document }) => `${document.platform} ${document.releaseId}`).join(', ')}. Run pnpm release:sync:origins -- --pending first.`
  )
}
