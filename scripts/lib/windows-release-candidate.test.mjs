import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { sha256File, sha512File } from './windows-alpha-release.mjs'
import {
  assertCandidateDownloadHeaders,
  assertPendingWindowsCandidateManifest,
  assertPrivateCandidateS3Config,
  buildWindowsCandidateStoragePlan,
  classifyCandidateObjectHead,
  validateDownloadedWindowsCandidate,
  WindowsReleaseCandidateError,
  windowsCandidateIdentity,
  windowsCandidatePrefix
} from './windows-release-candidate.mjs'

const publisher = 'Videorc Test Publisher'
const sourceCommit = 'b'.repeat(40)
const filename = 'Videorc-0.10.0-win-x64.exe'

async function seed() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'videorc-windows-candidate-'))
  const installerPath = join(releaseDir, filename)
  await writeFile(installerPath, 'signed-installer')
  const sha256 = await sha256File(installerPath)
  const sha512 = await sha512File(installerPath)
  const manifest = {
    acceptanceRecordUrl: null,
    acceptanceStatus: 'pending',
    architecture: 'x64',
    bundleVersion: '0.10.0',
    channel: 'alpha',
    displayVersion: '0.10.0 alpha 1',
    filename,
    knownIssuesUrl: 'https://www.videorc.com/windows-alpha',
    minimumOS: 'Windows 11 or later',
    minimumWindows: 'Windows 11 or later',
    objectKey: `releases/windows/0.10.0-alpha.1/${filename}`,
    platform: 'windows',
    product: 'Videorc',
    publisherName: publisher,
    releaseId: '0.10.0-alpha.1',
    releasedAt: '2026-07-18T00:00:00.000Z',
    releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
    sha256,
    signingStatus: 'signed',
    sizeBytes: Buffer.byteLength('signed-installer'),
    sourceCommit
  }
  const manifestPath = join(releaseDir, 'release.json')
  const ffmpegLicensePath = join(releaseDir, 'license.txt')
  const ffmpegSourcePath = join(releaseDir, 'source.txt')
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  await writeFile(join(releaseDir, `${filename}.sha256`), `${sha256}  ${filename}\n`)
  await writeFile(join(releaseDir, `${filename}.blockmap`), 'blockmap')
  await writeFile(
    join(releaseDir, 'latest.yml'),
    [
      'version: 0.10.0',
      'files:',
      `  - url: ${filename}`,
      `    sha512: ${sha512}`,
      `    size: ${manifest.sizeBytes}`,
      `path: ${filename}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-07-18T00:00:00.000Z'",
      ''
    ].join('\n')
  )
  await writeFile(ffmpegLicensePath, 'ffmpeg license')
  await writeFile(ffmpegSourcePath, 'ffmpeg source offer')
  const resources = join(releaseDir, 'win-unpacked', 'resources')
  const packagedFfmpeg = join(resources, 'ffmpeg')
  await mkdir(join(packagedFfmpeg, 'bin'), { recursive: true })
  await writeFile(join(releaseDir, 'win-unpacked', 'Videorc.exe'), 'packaged app')
  await writeFile(
    join(resources, 'app-update.yml'),
    'provider: generic\nurl: https://www.videorc.com/api/updates/\n'
  )
  await writeFile(join(resources, 'videorc-backend.exe'), 'backend')
  await writeFile(join(packagedFfmpeg, 'bin', 'ffmpeg.exe'), 'ffmpeg')
  await writeFile(join(packagedFfmpeg, 'bin', 'ffprobe.exe'), 'ffprobe')
  await writeFile(join(packagedFfmpeg, 'LICENSE.txt'), 'packaged license')
  await writeFile(join(packagedFfmpeg, 'SOURCE.txt'), 'packaged source')
  return {
    ffmpegLicensePath,
    ffmpegSourcePath,
    manifest,
    manifestPath,
    releaseDir,
    sha512
  }
}

describe('Windows private candidate storage plan', () => {
  it('uses one exact immutable release/source prefix and includes every handoff file', async () => {
    const paths = await seed()
    const plan = await buildWindowsCandidateStoragePlan(paths)

    assert.equal(plan.prefix, `candidates/windows/0.10.0-alpha.1/${sourceCommit}`)
    assert.equal(
      plan.candidateIdentity,
      windowsCandidateIdentity({
        installerSha256: paths.manifest.sha256,
        releaseId: paths.manifest.releaseId,
        sourceCommit
      })
    )
    assert.deepEqual(
      plan.artifacts.map(({ label, objectKey }) => ({ label, objectKey })),
      [
        ['installer', filename],
        ['sha256', `${filename}.sha256`],
        ['blockmap', `${filename}.blockmap`],
        ['update-feed', 'latest.yml'],
        ['manifest', 'release.json'],
        ['ffmpeg-license', 'FFMPEG-LICENSE.txt'],
        ['ffmpeg-source', 'FFMPEG-SOURCE.txt'],
        ['validation-app', 'win-unpacked/Videorc.exe'],
        ['validation-app-update', 'win-unpacked/resources/app-update.yml'],
        ['validation-backend', 'win-unpacked/resources/videorc-backend.exe'],
        ['validation-ffmpeg', 'win-unpacked/resources/ffmpeg/bin/ffmpeg.exe'],
        ['validation-ffprobe', 'win-unpacked/resources/ffmpeg/bin/ffprobe.exe'],
        ['validation-ffmpeg-license', 'win-unpacked/resources/ffmpeg/LICENSE.txt'],
        ['validation-ffmpeg-source', 'win-unpacked/resources/ffmpeg/SOURCE.txt']
      ].map(([label, name]) => ({ label, objectKey: `${plan.prefix}/${name}` }))
    )
    assert.ok(plan.artifacts.every((artifact) => artifact.sizeBytes > 0))
    assert.ok(plan.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)))
  })

  it('rejects accepted, mismatched, or tampered candidate material', async () => {
    const paths = await seed()
    assert.throws(
      () =>
        assertPendingWindowsCandidateManifest({
          ...paths.manifest,
          acceptanceStatus: 'pass',
          acceptanceRecordUrl:
            'https://raw.githubusercontent.com/TheOrcDev/videorc/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/acceptance/windows-alpha/pass.json'
        }),
      (error) =>
        error instanceof WindowsReleaseCandidateError && error.code === 'candidate-not-pending'
    )
    await writeFile(join(paths.releaseDir, paths.manifest.filename), 'tampered')
    await assert.rejects(
      buildWindowsCandidateStoragePlan(paths),
      (error) =>
        error instanceof WindowsReleaseCandidateError &&
        error.code === 'candidate-installer-mismatch'
    )
  })

  it('rejects mutable or ambiguous candidate coordinates', () => {
    for (const input of [
      { releaseId: 'latest', sourceCommit },
      { releaseId: '0.10.0-alpha.2', sourceCommit },
      { releaseId: '0.10.0-alpha.1', sourceCommit: 'main' }
    ]) {
      assert.throws(() => windowsCandidatePrefix(input), WindowsReleaseCandidateError)
    }
    assert.throws(
      () =>
        windowsCandidateIdentity({
          installerSha256: 'A'.repeat(64),
          releaseId: '0.10.0-alpha.1',
          sourceCommit
        }),
      WindowsReleaseCandidateError
    )
  })
})

function response({ status = 200, headers = {} } = {}) {
  return {
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status
  }
}

describe('downloaded Windows candidate validation', () => {
  it('binds signature, feed, SHA, size, publisher, release, and source commit', async () => {
    const paths = await seed()
    const result = validateDownloadedWindowsCandidate({
      actualInstallerSha256: paths.manifest.sha256,
      actualInstallerSha512: paths.sha512,
      actualInstallerSizeBytes: paths.manifest.sizeBytes,
      appUpdateYml:
        'provider: generic\nurl: https://www.videorc.com/api/updates/\npublisherName: Videorc Test Publisher\n',
      appSignature: { publisher, status: 'Valid', timestampPresent: true },
      expectedInstallerSha256: paths.manifest.sha256,
      expectedPublisher: publisher,
      expectedReleaseId: paths.manifest.releaseId,
      expectedSourceCommit: sourceCommit,
      feedYml: [
        'version: 0.10.0',
        'files:',
        `  - url: ${filename}`,
        `    sha512: ${paths.sha512}`,
        `    size: ${paths.manifest.sizeBytes}`,
        `path: ${filename}`,
        `sha512: ${paths.sha512}`,
        "releaseDate: '2026-07-18T00:00:00.000Z'",
        ''
      ].join('\n'),
      manifest: paths.manifest,
      requiredFileSizes: { blockmap: 9, ffmpegLicense: 1, ffmpegSource: 1 },
      sha256FileText: `${paths.manifest.sha256}  ${filename}\n`,
      signature: { publisher, status: 'Valid', timestampPresent: true }
    })
    assert.equal(result.ok, true)
  })

  it('fails closed on exact-hash, source, signature, and feed mismatches', async () => {
    const paths = await seed()
    const base = {
      actualInstallerSha256: paths.manifest.sha256,
      actualInstallerSha512: paths.sha512,
      actualInstallerSizeBytes: paths.manifest.sizeBytes,
      appUpdateYml:
        'provider: generic\nurl: https://www.videorc.com/api/updates/\npublisherName: Videorc Test Publisher\n',
      appSignature: { publisher, status: 'Valid', timestampPresent: true },
      expectedInstallerSha256: paths.manifest.sha256,
      expectedPublisher: publisher,
      expectedReleaseId: paths.manifest.releaseId,
      expectedSourceCommit: sourceCommit,
      feedYml: [
        'version: 0.10.0',
        'files:',
        `  - url: ${filename}`,
        `    sha512: ${paths.sha512}`,
        `    size: ${paths.manifest.sizeBytes}`,
        `path: ${filename}`,
        `sha512: ${paths.sha512}`,
        "releaseDate: '2026-07-18T00:00:00.000Z'",
        ''
      ].join('\n'),
      manifest: paths.manifest,
      requiredFileSizes: { blockmap: 9, ffmpegLicense: 1, ffmpegSource: 1 },
      sha256FileText: `${paths.manifest.sha256}  ${filename}\n`,
      signature: { publisher, status: 'Valid', timestampPresent: true }
    }
    for (const [override, code] of [
      [{ actualInstallerSha256: 'c'.repeat(64) }, 'installer-sha256'],
      [{ actualInstallerSha512: 'dGVtcGVyZWQ=' }, 'candidate-feed-integrity-mismatch'],
      [{ expectedSourceCommit: 'c'.repeat(40) }, 'candidate-source-commit'],
      [
        { signature: { publisher: 'Other', status: 'Valid', timestampPresent: true } },
        'signature-publisher'
      ],
      [
        { appSignature: { publisher: 'Other', status: 'Valid', timestampPresent: true } },
        'app-signature-publisher'
      ],
      [{ feedYml: 'version: 0.10.0\npath: stale.exe\n' }, 'candidate-feed-artifact-mismatch'],
      [
        {
          appUpdateYml: 'provider: generic\nurl: https://www.videorc.com/api/updates/\n'
        },
        'app-update-publisher-contract'
      ]
    ]) {
      assert.throws(
        () => validateDownloadedWindowsCandidate({ ...base, ...override }),
        (error) => error instanceof WindowsReleaseCandidateError && error.code === code
      )
    }
  })
})

describe('Windows candidate storage transport guardrails', () => {
  const artifact = {
    objectKey: `candidates/windows/0.10.0-alpha.1/${sourceCommit}/${filename}`,
    sha256: 'a'.repeat(64),
    sizeBytes: 123
  }

  it('permits only missing objects or byte-identical retries', () => {
    assert.equal(
      classifyCandidateObjectHead({ artifact, response: response({ status: 404 }) }),
      'missing'
    )
    assert.equal(
      classifyCandidateObjectHead({
        artifact,
        response: response({
          headers: {
            'content-length': '123',
            'x-amz-meta-sha256': artifact.sha256
          }
        })
      }),
      'identical'
    )
    assert.throws(
      () =>
        classifyCandidateObjectHead({
          artifact,
          response: response({
            headers: {
              'content-length': '123',
              'x-amz-meta-sha256': 'b'.repeat(64)
            }
          })
        }),
      (error) =>
        error instanceof WindowsReleaseCandidateError &&
        error.code === 'candidate-storage-collision'
    )
  })

  it('requires bounded downloads with immutable hash metadata', () => {
    const descriptor = { maxBytes: 200, objectKey: artifact.objectKey }
    assert.deepEqual(
      assertCandidateDownloadHeaders({
        descriptor,
        response: response({
          headers: {
            'content-length': '123',
            'x-amz-meta-sha256': artifact.sha256
          }
        })
      }),
      { contentLength: 123, metadataSha256: artifact.sha256 }
    )
    for (const headers of [
      { 'content-length': '201', 'x-amz-meta-sha256': artifact.sha256 },
      { 'content-length': '123' }
    ]) {
      assert.throws(
        () => assertCandidateDownloadHeaders({ descriptor, response: response({ headers }) }),
        WindowsReleaseCandidateError
      )
    }
  })

  it('rejects cleartext candidate-storage endpoints', () => {
    assert.throws(
      () => assertPrivateCandidateS3Config({ endpointUrl: 'http://r2.example.test' }),
      (error) =>
        error instanceof WindowsReleaseCandidateError &&
        error.code === 'insecure-candidate-storage-endpoint'
    )
    assert.deepEqual(assertPrivateCandidateS3Config({ endpointUrl: 'https://r2.example.test' }), {
      endpointUrl: 'https://r2.example.test'
    })
  })
})
