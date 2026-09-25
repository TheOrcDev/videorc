import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildLinuxUpdateFeedYml } from './linux-alpha-release.mjs'
import {
  LinuxReleaseValidationError,
  formatLinuxReleaseValidationReport,
  validateLinuxReleaseFacts
} from './linux-release-artifact-validation.mjs'

const sourceCommit = 'd'.repeat(40)
const sha256 = 'e'.repeat(64)
const sha512 = Buffer.from('f'.repeat(64), 'hex').toString('base64')
const filename = 'Videorc-0.10.0-linux-x64.AppImage'

function manifest(overrides = {}) {
  return {
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
    sizeBytes: 180_000_000,
    sourceCommit,
    stage: 'candidate',
    ...overrides
  }
}

function facts(overrides = {}) {
  return {
    actualSha256: sha256,
    actualSha512: sha512,
    actualSizeBytes: 180_000_000,
    expectedSourceCommit: sourceCommit,
    feedYml: buildLinuxUpdateFeedYml({
      filename,
      releaseDate: '2026-09-25T00:00:00.000Z',
      sha512,
      sizeBytes: 180_000_000,
      version: '0.10.0'
    }),
    ffmpegCapabilities: { ok: true, problems: [] },
    files: {
      appImage: true,
      backend: true,
      ffmpeg: true,
      ffmpegBuildConfig: true,
      ffmpegLicense: true,
      ffmpegSource: true,
      ffprobe: true,
      unpackedApp: true
    },
    manifest: manifest(),
    sha256FileText: `${sha256}  ${filename}\n`,
    ...overrides
  }
}

describe('Linux release artifact validation', () => {
  it('passes a matching unsigned AppImage, Linux feed, and LGPL FFmpeg report', () => {
    const result = validateLinuxReleaseFacts(facts())
    assert.equal(result.ok, true)
    assert.match(formatLinuxReleaseValidationReport(result), /^linux-release-artifact: PASS/)
    assert.ok(result.checks.some((check) => check.id === 'ffmpeg-lgpl'))
  })

  it('fails closed when bundled FFmpeg is not LGPL VAAPI/OpenH264', () => {
    assert.throws(
      () =>
        validateLinuxReleaseFacts(
          facts({
            ffmpegCapabilities: { ok: false, problems: ['forbidden configure flag --enable-gpl'] }
          })
        ),
      (error) => error instanceof LinuxReleaseValidationError && error.code === 'ffmpeg-lgpl'
    )
  })

  it('fails when the source commit or sidecar drifts', () => {
    assert.throws(
      () => validateLinuxReleaseFacts(facts({ expectedSourceCommit: 'c'.repeat(40) })),
      (error) =>
        error instanceof LinuxReleaseValidationError && error.code === 'source-commit-contract'
    )
    assert.throws(
      () => validateLinuxReleaseFacts(facts({ sha256FileText: `${sha256}  other\n` })),
      (error) => error instanceof LinuxReleaseValidationError && error.code === 'sha256-sidecar'
    )
  })
})
