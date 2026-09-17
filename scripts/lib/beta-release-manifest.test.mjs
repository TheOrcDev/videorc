import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertVideorcDmgArtifact,
  buildMacosBetaReleaseManifest,
  formatSha256File,
  inferMacosArchitecture
} from './beta-release-manifest.mjs'

describe('macOS beta release manifest', () => {
  it('builds default Beta 1 metadata for a Videorc DMG', () => {
    const manifest = buildMacosBetaReleaseManifest({
      artifactPath: '/repo/apps/desktop/release/Videorc-0.9.0-mac-arm64.dmg',
      packageVersion: '0.9.0',
      sha256: 'abc123',
      sizeBytes: 42,
      releasedAt: '2026-06-22T00:00:00.000Z',
      env: {}
    })

    assert.deepEqual(manifest, {
      product: 'Videorc',
      channel: 'beta',
      releaseId: '0.9.0-beta.1',
      displayVersion: '0.9.0 beta 1',
      bundleVersion: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      filename: 'Videorc-0.9.0-mac-arm64.dmg',
      objectKey: 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg',
      sha256: 'abc123',
      sizeBytes: 42,
      minimumMacOS: 'macOS 13 Ventura or later',
      releasedAt: '2026-06-22T00:00:00.000Z',
      releaseNotesUrl: 'https://www.videorc.com/releases/0.9.0-beta.1'
    })
  })

  it('allows release metadata overrides without changing the bundle version', () => {
    const manifest = buildMacosBetaReleaseManifest({
      artifactPath: '/repo/apps/desktop/release/Videorc-0.9.0-mac-universal.dmg',
      packageVersion: '0.9.0',
      sha256: 'def456',
      sizeBytes: 99,
      releasedAt: '2026-06-22T00:00:00.000Z',
      env: {
        VIDEORC_RELEASE_ID: '0.9.0-beta.2',
        VIDEORC_RELEASE_DISPLAY_VERSION: '0.9.0 beta 2',
        VIDEORC_RELEASE_NOTES_URL: 'https://www.videorc.com/releases/beta-2'
      }
    })

    assert.equal(manifest.releaseId, '0.9.0-beta.2')
    assert.equal(manifest.displayVersion, '0.9.0 beta 2')
    assert.equal(manifest.bundleVersion, '0.9.0')
    assert.equal(manifest.architecture, 'universal')
    assert.equal(manifest.releaseNotesUrl, 'https://www.videorc.com/releases/beta-2')
  })

  it('rejects stale artifacts with the old product name', () => {
    assert.throws(
      () => assertVideorcDmgArtifact('/repo/apps/desktop/release/Videogre-0.1.0-mac-arm64.dmg'),
      /Videorc product name/
    )
  })

  it('infers supported macOS artifact architectures', () => {
    assert.equal(inferMacosArchitecture('Videorc-0.9.0-mac-arm64.dmg'), 'arm64')
    assert.equal(inferMacosArchitecture('Videorc-0.9.0-mac-x64.dmg'), 'x64')
    assert.equal(inferMacosArchitecture('Videorc-0.9.0-mac-universal.dmg'), 'universal')
    assert.equal(inferMacosArchitecture('Videorc-0.9.0.dmg'), 'unknown')
  })

  it('formats sha256 sidecar files', () => {
    assert.equal(
      formatSha256File({ sha256: 'abc123', filename: 'Videorc-0.9.0-mac-arm64.dmg' }),
      'abc123  Videorc-0.9.0-mac-arm64.dmg\n'
    )
  })
})
