import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildLinuxUpdateFeedYml, sha256File, sha512File } from './linux-alpha-release.mjs'
import {
  assertPendingLinuxCandidateManifest,
  assertPrivateLinuxCandidateS3Config,
  buildLinuxCandidateStoragePlan,
  classifyLinuxCandidateObjectHead,
  LinuxReleaseCandidateError,
  linuxCandidateIdentity,
  linuxCandidatePrefix,
  verifyLinuxCandidateObjectBody
} from './linux-release-candidate.mjs'

const sourceCommit = 'b'.repeat(40)
const filename = 'Videorc-0.10.0-linux-x64.AppImage'

async function seed() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'videorc-linux-candidate-'))
  const appImagePath = join(releaseDir, filename)
  await writeFile(appImagePath, 'unsigned-appimage')
  const sha256 = await sha256File(appImagePath)
  const sha512 = await sha512File(appImagePath)
  const sizeBytes = Buffer.byteLength('unsigned-appimage')
  const manifest = {
    acceptanceRecordUrl: null,
    acceptanceStatus: 'pending',
    architecture: 'x64',
    bundleVersion: '0.10.0',
    channel: 'alpha',
    displayVersion: '0.10.0 alpha 1',
    filename,
    knownIssuesUrl: 'https://www.videorc.com/linux-alpha',
    minimumOS: 'Ubuntu 24.04 LTS or later',
    objectKey: `releases/linux-alpha/0.10.0-alpha.1/${filename}`,
    platform: 'linux',
    product: 'Videorc',
    releaseId: '0.10.0-alpha.1',
    releasedAt: '2026-09-25T00:00:00.000Z',
    releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
    sha256,
    signingStatus: 'unsigned',
    sizeBytes,
    sourceCommit,
    stage: 'candidate'
  }
  const manifestPath = join(releaseDir, 'release.json')
  const ffmpegLicensePath = join(releaseDir, 'license.txt')
  const ffmpegSourcePath = join(releaseDir, 'source.txt')
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  await writeFile(join(releaseDir, `${filename}.sha256`), `${sha256}  ${filename}\n`)
  await writeFile(
    join(releaseDir, 'latest-linux.yml'),
    buildLinuxUpdateFeedYml({
      filename,
      releaseDate: '2026-09-25T00:00:00.000Z',
      sha512,
      sizeBytes,
      version: '0.10.0'
    })
  )
  await writeFile(ffmpegLicensePath, 'ffmpeg license')
  await writeFile(ffmpegSourcePath, 'ffmpeg source offer')
  return {
    ffmpegLicensePath,
    ffmpegSourcePath,
    manifest,
    manifestPath,
    releaseDir
  }
}

describe('Linux Alpha candidate storage', () => {
  it('plans only isolated linux-alpha candidate keys', async () => {
    const seeded = await seed()
    const plan = await buildLinuxCandidateStoragePlan(seeded)
    assert.equal(plan.prefix, `candidates/linux-alpha/0.10.0-alpha.1/${sourceCommit}`)
    assert.equal(
      plan.candidateIdentity,
      linuxCandidateIdentity({
        appImageSha256: seeded.manifest.sha256,
        releaseId: '0.10.0-alpha.1',
        sourceCommit
      })
    )
    assert.equal(
      linuxCandidatePrefix(seeded.manifest),
      `candidates/linux-alpha/0.10.0-alpha.1/${sourceCommit}`
    )
    const keys = plan.artifacts.map((artifact) => artifact.objectKey)
    assert.ok(keys.every((key) => key.startsWith(plan.prefix)))
    assert.ok(keys.every((key) => key.includes('linux-alpha')))
    assert.ok(keys.includes(`${plan.prefix}/latest-linux.yml`))
    for (const key of keys) {
      assert.doesNotMatch(
        key,
        /releases\/windows|releases\/macos|latest-mac\.yml|(^|\/)latest\.yml$/
      )
    }
  })

  it('rejects a public or accepted candidate manifest', () => {
    const pending = {
      acceptanceRecordUrl: null,
      acceptanceStatus: 'pending',
      architecture: 'x64',
      bundleVersion: '0.10.0',
      channel: 'alpha',
      displayVersion: '0.10.0 alpha 1',
      filename,
      knownIssuesUrl: 'https://www.videorc.com/linux-alpha',
      minimumOS: 'Ubuntu 24.04 LTS or later',
      objectKey: `releases/linux-alpha/0.10.0-alpha.1/${filename}`,
      platform: 'linux',
      product: 'Videorc',
      releaseId: '0.10.0-alpha.1',
      releasedAt: '2026-09-25T00:00:00.000Z',
      releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
      sha256: 'a'.repeat(64),
      signingStatus: 'unsigned',
      sizeBytes: 12,
      sourceCommit,
      stage: 'candidate'
    }
    assert.doesNotThrow(() => assertPendingLinuxCandidateManifest(pending))
    assert.throws(
      () => assertPendingLinuxCandidateManifest({ ...pending, stage: 'pilot' }),
      (error) =>
        error instanceof LinuxReleaseCandidateError && error.code === 'candidate-not-private'
    )
  })

  it('classifies identical heads and collisions', () => {
    const artifact = {
      objectKey: 'candidates/linux-alpha/x/y/z',
      sha256: 'ab'.repeat(32),
      sizeBytes: 8
    }
    const headers = (entries) => ({
      get(name) {
        return entries[name] ?? null
      }
    })
    assert.equal(
      classifyLinuxCandidateObjectHead({
        artifact,
        response: {
          headers: headers({
            'content-length': '8',
            'x-amz-meta-sha256': artifact.sha256
          }),
          ok: true,
          status: 200
        }
      }),
      'identical'
    )
    assert.equal(
      classifyLinuxCandidateObjectHead({
        artifact,
        response: { headers: headers({}), ok: false, status: 404 }
      }),
      'missing'
    )
    assert.throws(
      () =>
        classifyLinuxCandidateObjectHead({
          artifact,
          response: {
            headers: headers({
              'content-length': '8',
              'x-amz-meta-sha256': 'cd'.repeat(32)
            }),
            ok: true,
            status: 200
          }
        }),
      (error) =>
        error instanceof LinuxReleaseCandidateError && error.code === 'candidate-storage-collision'
    )
  })

  it('requires an HTTPS candidate endpoint', () => {
    assert.doesNotThrow(() =>
      assertPrivateLinuxCandidateS3Config({ endpointUrl: 'https://storage.example.test' })
    )
    assert.throws(
      () => assertPrivateLinuxCandidateS3Config({ endpointUrl: 'http://storage.example.test' }),
      (error) =>
        error instanceof LinuxReleaseCandidateError &&
        error.code === 'insecure-candidate-storage-endpoint'
    )
  })

  it('refuses a HEAD without an exact byte length even when checksum metadata matches', () => {
    const artifact = { objectKey: 'candidate/AppImage', sizeBytes: 8, sha256: 'a'.repeat(64) }
    for (const length of [null, '7', '8.0', '8e0', '-8', 'unknown']) {
      const headers = new Headers({ 'x-amz-meta-sha256': artifact.sha256 })
      if (length !== null) headers.set('content-length', length)
      assert.throws(
        () =>
          classifyLinuxCandidateObjectHead({
            artifact,
            response: { ok: true, status: 200, headers }
          }),
        { code: 'candidate-storage-collision' }
      )
    }
  })
})

describe('Linux candidate stored-byte verification', () => {
  const bytes = Buffer.from('exact candidate bytes')
  const artifact = {
    objectKey: 'candidates/linux-beta/version/source/AppImage',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  const response = (body = bytes, init = {}) =>
    new Response(body, {
      headers: { 'content-length': String(bytes.length), 'x-amz-meta-sha256': artifact.sha256 },
      ...init
    })

  it('hashes the complete stream across chunk boundaries', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4))
        controller.enqueue(bytes.subarray(4))
        controller.close()
      }
    })
    await verifyLinuxCandidateObjectBody({ artifact, response: response(body) })
  })

  it('rejects corrupt bytes despite matching checksum metadata and length', async () => {
    await assert.rejects(
      verifyLinuxCandidateObjectBody({
        artifact,
        response: response(Buffer.alloc(bytes.length, 0))
      }),
      { code: 'candidate-storage-readback-mismatch' }
    )
  })

  it('rejects truncated bytes despite a correct Content-Length', async () => {
    await assert.rejects(
      verifyLinuxCandidateObjectBody({ artifact, response: response(bytes.subarray(1)) }),
      { code: 'candidate-storage-readback-mismatch' }
    )
  })

  it('cancels an oversized body instead of draining unbounded data', async () => {
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(Buffer.alloc(bytes.length + 1))
      },
      cancel() {
        cancelled = true
      }
    })
    await assert.rejects(verifyLinuxCandidateObjectBody({ artifact, response: response(body) }), {
      code: 'candidate-storage-readback-mismatch'
    })
    assert.equal(cancelled, true)
  })

  for (const [name, init] of [
    ['missing after upload', { status: 404 }],
    ['partial response', { status: 206 }],
    ['missing length', { headers: {} }],
    ['incorrect length', { headers: { 'content-length': '1' } }],
    [
      'compressed response',
      { headers: { 'content-length': String(bytes.length), 'content-encoding': 'gzip' } }
    ]
  ]) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(
        verifyLinuxCandidateObjectBody({ artifact, response: response(bytes, init) }),
        { code: 'candidate-storage-readback-failed' }
      )
    })
  }

  it('propagates a body read failure instead of certifying a partial object', async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error('readback aborted'))
      }
    })
    await assert.rejects(
      verifyLinuxCandidateObjectBody({ artifact, response: response(body) }),
      /readback aborted/
    )
  })
})
