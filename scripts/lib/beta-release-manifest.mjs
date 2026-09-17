import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const DEFAULT_MINIMUM_MACOS = 'macOS 13 Ventura or later'
const DEFAULT_CHANNEL = 'beta'
const DEFAULT_BETA_NUMBER = '1'

export async function findLatestDmg(releaseDir) {
  const candidates = await collectDmgArtifacts(releaseDir)
  return candidates
    .sort((left, right) => Number(right.mtimeMs ?? 0) - Number(left.mtimeMs ?? 0))
    .at(0)
}

export async function collectDmgArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith('.dmg')) {
      const info = await stat(path)
      candidates.push({ path, mtimeMs: info.mtimeMs, sizeBytes: info.size })
      continue
    }

    if (entry.isDirectory()) {
      candidates.push(...(await collectDmgArtifacts(path)))
    }
  }

  return candidates
}

export function assertVideorcDmgArtifact(artifactPath) {
  const filename = basename(artifactPath)
  if (!filename.endsWith('.dmg')) {
    throw new Error(`Release artifact must be a DMG: ${filename}`)
  }

  if (!filename.startsWith('Videorc-')) {
    throw new Error(
      `Release artifact must use the Videorc product name, got ${filename}. Remove stale artifacts and rebuild.`
    )
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export function buildMacosBetaReleaseManifest({
  artifactPath,
  packageVersion,
  sha256,
  sizeBytes,
  releasedAt = new Date().toISOString(),
  env = process.env
}) {
  assertVideorcDmgArtifact(artifactPath)

  const betaNumber = nonEmpty(env.VIDEORC_RELEASE_BETA_NUMBER) ?? DEFAULT_BETA_NUMBER
  const releaseId =
    nonEmpty(env.VIDEORC_RELEASE_ID) ?? `${packageVersion}-${DEFAULT_CHANNEL}.${betaNumber}`
  const displayVersion =
    nonEmpty(env.VIDEORC_RELEASE_DISPLAY_VERSION) ?? `${packageVersion} beta ${betaNumber}`
  const filename = basename(artifactPath)

  return {
    product: 'Videorc',
    channel: nonEmpty(env.VIDEORC_RELEASE_CHANNEL) ?? DEFAULT_CHANNEL,
    releaseId,
    displayVersion,
    bundleVersion: packageVersion,
    platform: 'macos',
    architecture: nonEmpty(env.VIDEORC_RELEASE_ARCHITECTURE) ?? inferMacosArchitecture(filename),
    filename,
    // The authoritative bucket key of the DMG. The stable latest/release.json
    // manifest is a COPY of the versioned one, so consumers must not derive the
    // artifact key from the manifest's own location (that produced presigned
    // latest/<dmg> URLs that 404'd — the DMG only lives under the releaseId).
    objectKey: `releases/macos/${releaseId}/${filename}`,
    sha256,
    sizeBytes,
    minimumMacOS: nonEmpty(env.VIDEORC_RELEASE_MINIMUM_MACOS) ?? DEFAULT_MINIMUM_MACOS,
    releasedAt,
    releaseNotesUrl:
      nonEmpty(env.VIDEORC_RELEASE_NOTES_URL) ?? `https://www.videorc.com/releases/${releaseId}`
  }
}

export function formatSha256File({ sha256, filename }) {
  return `${sha256}  ${filename}\n`
}

export function inferMacosArchitecture(filename) {
  const match = filename.match(/-mac-([^.]+)\.dmg$/)
  if (!match) {
    return 'unknown'
  }

  const arch = match[1]
  return arch === 'arm64' || arch === 'x64' || arch === 'universal' ? arch : 'unknown'
}

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 ? text : null
}
