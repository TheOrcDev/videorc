import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  validateWindowsReleaseFacts,
  WindowsReleaseValidationError
} from './windows-release-artifact-validation.mjs'

const publisher = 'Videorc Test Publisher'
const sha256 = 'a'.repeat(64)
const sha512 = Buffer.alloc(64, 7).toString('base64')
const manifest = {
  acceptanceRecordUrl: null,
  acceptanceStatus: 'pending',
  architecture: 'x64',
  bundleVersion: '0.10.0',
  channel: 'alpha',
  displayVersion: '0.10.0 alpha 1',
  filename: 'Videorc-0.10.0-win-x64.exe',
  knownIssuesUrl: 'https://www.videorc.com/windows-alpha',
  minimumWindows: 'Windows 11 or later',
  minimumOS: 'Windows 11 or later',
  objectKey: 'releases/windows/0.10.0-alpha.1/Videorc-0.10.0-win-x64.exe',
  platform: 'windows',
  product: 'Videorc',
  publisherName: publisher,
  releaseId: '0.10.0-alpha.1',
  releasedAt: '2026-07-18T00:00:00.000Z',
  releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
  sha256,
  signingStatus: 'signed',
  sizeBytes: 172_000_000,
  sourceCommit: 'b'.repeat(40)
}

function facts(overrides = {}) {
  return {
    actualSha256: sha256,
    actualSha512: sha512,
    actualSizeBytes: manifest.sizeBytes,
    appSignature: { publisher, status: 'Valid', timestampPresent: true },
    appUpdateYml:
      'provider: generic\nurl: https://www.videorc.com/api/updates/\npublisherName:\n  - Videorc Test Publisher\n',
    expectedPublisher: publisher,
    expectedSourceCommit: manifest.sourceCommit,
    feedYml: [
      'version: 0.10.0',
      'files:',
      `  - url: ${manifest.filename}`,
      `    sha512: ${sha512}`,
      `    size: ${manifest.sizeBytes}`,
      `path: ${manifest.filename}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-07-18T00:00:00.000Z'",
      ''
    ].join('\n'),
    files: {
      backend: true,
      blockmap: true,
      ffmpeg: true,
      ffmpegLicense: true,
      ffmpegSource: true,
      ffprobe: true,
      packagedApp: true
    },
    manifest,
    sha256FileText: `${sha256}  ${manifest.filename}\n`,
    signature: { publisher, status: 'Valid', timestampPresent: true },
    ...overrides
  }
}

describe('Windows release artifact validation', () => {
  it('accepts a signed, timestamped, internally consistent release', () => {
    assert.equal(validateWindowsReleaseFacts(facts()).ok, true)
  })

  it('fails exact publisher, timestamp, checksum, feed, and bundled-file mismatches', () => {
    for (const [override, code] of [
      [{ expectedPublisher: 'Unrelated Publisher' }, 'publisher-contract'],
      [{ expectedSourceCommit: 'c'.repeat(40) }, 'source-commit-contract'],
      [
        { signature: { publisher, status: 'NotSigned', timestampPresent: false } },
        'signature-status'
      ],
      [
        { signature: { publisher: 'Other', status: 'Valid', timestampPresent: true } },
        'signature-publisher'
      ],
      [
        { signature: { publisher, status: 'Valid', timestampPresent: false } },
        'signature-timestamp'
      ],
      [
        {
          appSignature: {
            publisher: 'Other Publisher',
            status: 'Valid',
            timestampPresent: true
          }
        },
        'app-signature'
      ],
      [{ actualSha256: 'c'.repeat(64) }, 'artifact-sha256'],
      [{ actualSizeBytes: 1 }, 'artifact-size'],
      [{ feedYml: 'version: 0.10.0\npath: stale.exe\n' }, 'update-feed-artifact'],
      [{ actualSha512: Buffer.alloc(64, 8).toString('base64') }, 'update-feed-sha512'],
      [
        {
          feedYml: facts().feedYml.replace(
            `size: ${manifest.sizeBytes}`,
            `size: ${manifest.sizeBytes - 1}`
          )
        },
        'update-feed-size'
      ],
      [
        { appUpdateYml: 'provider: generic\nurl: https://storage.example.test/\n' },
        'baked-update-provider'
      ],
      [
        {
          appUpdateYml:
            'provider: generic\nurl: https://www.videorc.com/api/updates/\npublisherName: Other Publisher\n'
        },
        'baked-update-provider'
      ],
      [{ files: { ...facts().files, ffprobe: false } }, 'file-ffprobe']
    ]) {
      assert.throws(
        () => validateWindowsReleaseFacts(facts(override)),
        (error) => error instanceof WindowsReleaseValidationError && error.code === code
      )
    }
  })
})
