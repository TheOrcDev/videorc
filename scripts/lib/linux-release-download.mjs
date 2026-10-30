import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  assertLinuxCandidateCoordinates,
  assertPendingLinuxCandidateManifest,
  buildLinuxCandidateStoragePlan,
  linuxCandidateObjectDescriptors,
  linuxCandidatePrefix
} from './linux-release-candidate.mjs'

// Read-only storage client: writes only to a new private local directory and
// never launches candidate code. `getObject` must bound request/body lifetime.
export async function downloadLinuxCandidate({ coordinates, parentDirectory, getObject }) {
  assertLinuxCandidateCoordinates(coordinates)
  if (!coordinates.appImageSha256) throw new Error('An expected AppImage SHA-256 is required.')
  const parent = resolve(parentDirectory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'linux-candidate-'))
  try {
    const manifestPath = join(directory, 'release.json')
    const prefix = linuxCandidatePrefix(coordinates)
    await downloadObject({
      response: await getObject(`${prefix}/release.json`),
      path: manifestPath,
      maxBytes: 64 * 1024
    })
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assertPendingLinuxCandidateManifest(manifest, coordinates)
    for (const item of linuxCandidateObjectDescriptors(manifest)) {
      if (item.label === 'manifest') continue
      await downloadObject({
        response: await getObject(item.objectKey),
        path: join(directory, item.filename),
        maxBytes: item.maxBytes,
        ...(item.label === 'appimage'
          ? { expectedSize: manifest.sizeBytes, expectedSha256: manifest.sha256 }
          : {})
      })
    }
    // Validates SHA-256, SHA-512, checksum sidecar, feed identity and all six
    // nonempty files together, including the manifest bytes actually fetched.
    const plan = await buildLinuxCandidateStoragePlan({
      manifest,
      manifestPath,
      releaseDir: directory,
      ffmpegLicensePath: join(directory, 'FFMPEG-LICENSE.txt'),
      ffmpegSourcePath: join(directory, 'FFMPEG-SOURCE.txt')
    })
    return { directory, manifest, plan }
  } catch (error) {
    // The fresh directory is the only cleanup target. Existing candidates,
    // parent contents and unrelated profiles are never removed or overwritten.
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function downloadObject({ response, path, maxBytes, expectedSize, expectedSha256 }) {
  const length = response.headers.get('content-length')
  const size = Number(length)
  if (
    response.status !== 200 ||
    !response.body ||
    !/^[1-9]\d*$/.test(length ?? '') ||
    !Number.isSafeInteger(size) ||
    size > maxBytes ||
    (expectedSize !== undefined && size !== expectedSize) ||
    ![null, 'identity'].includes(response.headers.get('content-encoding'))
  ) {
    await response.body?.cancel()
    throw new Error('Candidate download refused: HTTP status, body length or encoding mismatch.')
  }
  const file = await open(path, 'wx', 0o600)
  const hash = createHash('sha256')
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > size) throw new Error('Candidate download exceeds its declared length.')
      hash.update(chunk)
      let written = 0
      while (written < chunk.byteLength) {
        const result = await file.write(chunk, written, chunk.byteLength - written)
        if (result.bytesWritten === 0) throw new Error('Candidate download write made no progress.')
        written += result.bytesWritten
      }
    }
    if (received !== size) throw new Error('Candidate download was truncated.')
    if (expectedSha256 && hash.digest('hex') !== expectedSha256)
      throw new Error('Candidate AppImage SHA-256 does not match the requested identity.')
    await file.sync()
  } finally {
    await file.close()
  }
}
