import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertWindowsAlphaReleaseManifest,
  assertWindowsInstallerFilename,
  buildWindowsAlphaReleaseManifest,
  compareNumericVersions,
  parseWindowsUpdateFeed,
  updateFeedFileMetadataFromYml,
  updateFeedArtifactNameFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml,
  WindowsAlphaReleaseError
} from './windows-alpha-release.mjs'

const sourceCommit = 'a'.repeat(40)
const sha256 = 'b'.repeat(64)

function buildManifest(env = {}) {
  return buildWindowsAlphaReleaseManifest({
    artifactPath: '/tmp/Videorc-0.10.0-win-x64.exe',
    env,
    packageVersion: '0.10.0',
    publisherName: 'Videorc Test Publisher',
    sha256,
    sizeBytes: 172_000_000,
    sourceCommit
  })
}

describe('Windows alpha release manifest', () => {
  it('emits the exact platform, storage, signing, and evidence contract', () => {
    const manifest = buildManifest()
    assert.match(manifest.releasedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(
      { ...manifest, releasedAt: '<timestamp>' },
      {
        acceptanceRecordUrl: null,
        acceptanceStatus: 'pending',
        architecture: 'x64',
        bundleVersion: '0.10.0',
        channel: 'alpha',
        displayVersion: '0.10.0 alpha 1',
        filename: 'Videorc-0.10.0-win-x64.exe',
        knownIssuesUrl: 'https://www.videorc.com/windows-alpha',
        minimumOS: 'Windows 11 or later',
        minimumWindows: 'Windows 11 or later',
        objectKey: 'releases/windows/0.10.0-alpha.1/Videorc-0.10.0-win-x64.exe',
        platform: 'windows',
        product: 'Videorc',
        publisherName: 'Videorc Test Publisher',
        releaseId: '0.10.0-alpha.1',
        releasedAt: '<timestamp>',
        releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
        sha256,
        signingStatus: 'signed',
        sizeBytes: 172_000_000,
        sourceCommit
      }
    )
  })

  it('rejects same-core alpha revisions that electron-updater cannot advance to', () => {
    assert.throws(
      () =>
        buildManifest({
          VIDEORC_RELEASE_ID: '0.10.0-alpha.2'
        }),
      (error) => error instanceof WindowsAlphaReleaseError && error.code === 'invalid-release-id'
    )
  })

  it('accepts an explicit dated PASS record for stable promotion', () => {
    const manifest = buildManifest({
      VIDEORC_WINDOWS_ACCEPTANCE_RECORD_URL:
        'https://www.videorc.com/releases/0.10.0-alpha.1/acceptance',
      VIDEORC_WINDOWS_ACCEPTANCE_STATUS: 'pass'
    })

    assert.doesNotThrow(() =>
      assertWindowsAlphaReleaseManifest(manifest, { requireAccepted: true })
    )
  })

  it('refuses stable promotion for pending or unevidenced acceptance', () => {
    assert.throws(
      () => assertWindowsAlphaReleaseManifest(buildManifest(), { requireAccepted: true }),
      (error) =>
        error instanceof WindowsAlphaReleaseError && error.code === 'missing-acceptance-record-url'
    )

    assert.throws(
      () =>
        buildManifest({
          VIDEORC_WINDOWS_ACCEPTANCE_STATUS: 'pass'
        }),
      (error) =>
        error instanceof WindowsAlphaReleaseError && error.code === 'missing-acceptance-record-url'
    )
  })

  it('rejects mutable object keys, weak digests, and noncanonical release notes', () => {
    const manifest = buildManifest()
    for (const [override, code] of [
      [{ objectKey: 'releases/windows/latest/Videorc-0.10.0-win-x64.exe' }, 'invalid-object-key'],
      [{ sha256: 'abc123' }, 'invalid-sha256'],
      [{ sizeBytes: 0 }, 'invalid-size-bytes'],
      [
        { releaseNotesUrl: 'https://videorc.app/releases/0.10.0-alpha.1' },
        'invalid-release-notes-url'
      ],
      [{ signingStatus: 'unsigned' }, 'invalid-signingStatus'],
      [{ bundleVersion: '0.10' }, 'invalid-bundle-version'],
      [{ displayVersion: 'Windows build' }, 'invalid-display-version'],
      [{ filename: 'Videorc-0.9.9-win-x64.exe' }, 'stale-installer-filename'],
      [{ minimumOS: 'Windows 10' }, 'invalid-minimum-windows'],
      [{ releasedAt: 'not-a-date' }, 'invalid-released-at'],
      [{ sourceCommit: 'deadbeef' }, 'invalid-source-commit']
    ]) {
      assert.throws(
        () => assertWindowsAlphaReleaseManifest({ ...manifest, ...override }),
        (error) => error instanceof WindowsAlphaReleaseError && error.code === code
      )
    }
  })
})

describe('Windows installer and updater names', () => {
  it('accepts only the x64 NSIS product name', () => {
    assert.equal(
      assertWindowsInstallerFilename('/tmp/Videorc-0.10.0-win-x64.exe'),
      'Videorc-0.10.0-win-x64.exe'
    )
    for (const name of [
      'Other-0.10.0-win-x64.exe',
      'Videorc-0.10.0-win-arm64.exe',
      'Videorc-0.10.0-win-x64.msi'
    ]) {
      assert.throws(() => assertWindowsInstallerFilename(`/tmp/${name}`))
    }
  })

  it('reads the primary artifact and version from latest.yml', () => {
    const latest = [
      'version: 0.10.0',
      'files:',
      '  - url: Videorc-0.10.0-win-x64.exe',
      '    sha512: ZmVlZA==',
      '    size: 172000000',
      'path: Videorc-0.10.0-win-x64.exe',
      'sha512: ZmVlZA==',
      "releaseDate: '2026-07-18T00:00:00.000Z'",
      ''
    ].join('\n')
    assert.equal(updateFeedVersionFromYml(latest), '0.10.0')
    assert.equal(updateFeedArtifactNameFromYml(latest), 'Videorc-0.10.0-win-x64.exe')
    assert.equal(updateFeedSha512FromYml(latest), 'ZmVlZA==')
    assert.deepEqual(updateFeedFileMetadataFromYml(latest, 'Videorc-0.10.0-win-x64.exe'), {
      sha512: 'ZmVlZA==',
      size: 172_000_000,
      url: 'Videorc-0.10.0-win-x64.exe'
    })
    assert.equal(compareNumericVersions('0.10.1', '0.10.0'), 1)
    assert.equal(compareNumericVersions('0.10.0', '0.10.0'), 0)
    assert.equal(compareNumericVersions('0.9.9', '0.10.0'), -1)
  })

  it('rejects alternate files, absolute URLs, duplicate keys, and extra fields in latest.yml', () => {
    const canonical = [
      'version: 0.10.0',
      'files:',
      '  - url: Videorc-0.10.0-win-x64.exe',
      '    sha512: ZmVlZA==',
      '    size: 172000000',
      'path: Videorc-0.10.0-win-x64.exe',
      'sha512: ZmVlZA==',
      "releaseDate: '2026-07-18T00:00:00.000Z'",
      ''
    ].join('\n')
    const unsafeFeeds = [
      canonical.replace(
        'files:',
        'files:\n  - url: Videorc-0.9.9-win-x64.exe\n    sha512: Zm9v\n    size: 10'
      ),
      canonical.replace(
        'url: Videorc-0.10.0-win-x64.exe',
        'url: https://downloads.example.test/Videorc-0.10.0-win-x64.exe'
      ),
      `${canonical}path: Videorc-0.10.0-win-x64.exe\n`,
      `${canonical}releaseNotes: unexpected\n`
    ]
    for (const feed of unsafeFeeds) {
      assert.throws(() => parseWindowsUpdateFeed(feed), WindowsAlphaReleaseError)
    }
  })
})
