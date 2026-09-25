import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { load as loadYaml } from 'js-yaml'

import {
  assertIsolatedLinuxObjectKey,
  assertLinuxAlphaReleaseManifest,
  assertLinuxAppImageArtifactNameTemplate,
  assertLinuxAppImageFilename,
  buildLinuxAlphaReleaseManifest,
  buildLinuxUpdateFeedYml,
  findLatestLinuxAppImage,
  LinuxAlphaReleaseError,
  linuxAlphaAppImageFilename,
  parseLinuxAlphaReleaseId,
  parseLinuxUpdateFeed,
  updateFeedArtifactNameFromYml,
  updateFeedSha512FromYml,
  updateFeedVersionFromYml
} from './linux-alpha-release.mjs'

const sourceCommit = 'a'.repeat(40)
const sha256 = 'b'.repeat(64)
const sha512 = Buffer.from('c'.repeat(64), 'hex').toString('base64')

function buildManifest(env = {}) {
  return buildLinuxAlphaReleaseManifest({
    artifactPath: '/tmp/Videorc-0.10.0-linux-x64.AppImage',
    env,
    packageVersion: '0.10.0',
    sha256,
    sizeBytes: 180_000_000,
    sourceCommit
  })
}

describe('Linux alpha release manifest', () => {
  it('emits the isolated unsigned candidate contract', () => {
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
        filename: 'Videorc-0.10.0-linux-x64.AppImage',
        knownIssuesUrl: 'https://www.videorc.com/linux-alpha',
        minimumOS: 'Ubuntu 24.04 LTS or later',
        objectKey: 'releases/linux-alpha/0.10.0-alpha.1/Videorc-0.10.0-linux-x64.AppImage',
        platform: 'linux',
        product: 'Videorc',
        releaseId: '0.10.0-alpha.1',
        releasedAt: '<timestamp>',
        releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
        sha256,
        signingStatus: 'unsigned',
        sizeBytes: 180_000_000,
        sourceCommit,
        stage: 'candidate'
      }
    )
  })

  it('accepts a same-core alpha.N revision for the Linux lane', () => {
    const manifest = buildManifest({
      VIDEORC_RELEASE_ID: '0.10.0-alpha.2'
    })
    assert.equal(manifest.releaseId, '0.10.0-alpha.2')
    assert.equal(manifest.displayVersion, '0.10.0 alpha 2')
    assert.equal(
      manifest.objectKey,
      'releases/linux-alpha/0.10.0-alpha.2/Videorc-0.10.0-linux-x64.AppImage'
    )
  })

  it('rejects public promotion without an acceptance record', () => {
    assert.throws(
      () =>
        buildManifest({
          VIDEORC_LINUX_RELEASE_STAGE: 'public'
        }),
      (error) =>
        error instanceof LinuxAlphaReleaseError && error.code === 'public-stage-not-accepted'
    )
  })

  it('rejects macOS or Windows storage keys and feed names', () => {
    const manifest = buildManifest()
    for (const [override, code] of [
      [
        { objectKey: 'releases/windows/0.10.0-alpha.1/Videorc-0.10.0-linux-x64.AppImage' },
        'cross-platform-object-key'
      ],
      [
        { objectKey: 'releases/macos/0.10.0-alpha.1/Videorc-0.10.0-linux-x64.AppImage' },
        'cross-platform-object-key'
      ],
      [{ platform: 'windows' }, 'invalid-platform'],
      [{ signingStatus: 'signed' }, 'invalid-signingStatus'],
      [{ bundleVersion: '0.10' }, 'invalid-bundle-version'],
      [{ filename: 'Videorc-0.9.9-linux-x64.AppImage' }, 'stale-appimage-filename'],
      [{ minimumOS: 'Ubuntu 22.04' }, 'invalid-minimum-linux'],
      [{ sourceCommit: 'deadbeef' }, 'invalid-source-commit']
    ]) {
      assert.throws(
        () => assertLinuxAlphaReleaseManifest({ ...manifest, ...override }),
        (error) => error instanceof LinuxAlphaReleaseError && error.code === code
      )
    }
  })
})

describe('Linux AppImage and updater names', () => {
  it('pins the desktop Linux artifactName to the x64 contract', async () => {
    const builderConfig = loadYaml(
      await readFile(
        join(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/electron-builder.yml'),
        'utf8'
      )
    )
    assert.equal(
      builderConfig.linux.artifactName,
      '${productName}-${version}-${os}-x64.${ext}'
    )
    assert.equal(
      assertLinuxAppImageArtifactNameTemplate(builderConfig.linux.artifactName),
      builderConfig.linux.artifactName
    )
    assert.equal(linuxAlphaAppImageFilename('0.10.0'), 'Videorc-0.10.0-linux-x64.AppImage')
    assert.throws(
      () =>
        assertLinuxAppImageArtifactNameTemplate(
          '${productName}-${version}-${os}-${arch}.${ext}'
        ),
      (error) =>
        error instanceof LinuxAlphaReleaseError && error.code === 'linux-artifact-name-uses-arch'
    )
    assert.throws(
      () =>
        assertLinuxAppImageArtifactNameTemplate(
          '${productName}-${version}-${os}-x86_64.${ext}'
        ),
      (error) =>
        error instanceof LinuxAlphaReleaseError && error.code === 'linux-artifact-name-mismatch'
    )
  })

  it('ignores electron-builder AppImage names that use x86_64', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'linux-alpha-appimage-'))
    try {
      await writeFile(join(releaseDir, 'Videorc-0.10.0-linux-x86_64.AppImage'), 'stale')
      assert.equal(await findLatestLinuxAppImage(releaseDir), null)
      await writeFile(join(releaseDir, 'Videorc-0.10.0-linux-x64.AppImage'), 'ok')
      const found = await findLatestLinuxAppImage(releaseDir)
      assert.equal(found?.path, join(releaseDir, 'Videorc-0.10.0-linux-x64.AppImage'))
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })

  it('accepts only the x64 AppImage product name', () => {
    assert.equal(
      assertLinuxAppImageFilename('/tmp/Videorc-0.10.0-linux-x64.AppImage'),
      'Videorc-0.10.0-linux-x64.AppImage'
    )
    for (const name of [
      'Videorc-0.10.0-linux-x64.exe',
      'Videorc-0.10.0-mac-arm64.dmg',
      'Videorc-0.10.0-linux-x86_64.AppImage',
      'other-0.10.0-linux-x64.AppImage'
    ]) {
      assert.throws(
        () => assertLinuxAppImageFilename(`/tmp/${name}`),
        (error) =>
          error instanceof LinuxAlphaReleaseError && error.code === 'invalid-appimage-filename'
      )
    }
  })

  it('parses <version>-alpha.N release ids', () => {
    assert.deepEqual(parseLinuxAlphaReleaseId('0.10.0-alpha.3'), {
      bundleVersion: '0.10.0',
      prereleaseNumber: 3
    })
    assert.throws(
      () => parseLinuxAlphaReleaseId('0.10.0-beta.1'),
      (error) => error instanceof LinuxAlphaReleaseError && error.code === 'invalid-release-id'
    )
  })

  it('writes and parses a Linux-only update feed', () => {
    const yml = buildLinuxUpdateFeedYml({
      filename: 'Videorc-0.10.0-linux-x64.AppImage',
      releaseDate: '2026-09-25T00:00:00.000Z',
      sha512,
      sizeBytes: 180_000_000,
      version: '0.10.0'
    })
    const feed = parseLinuxUpdateFeed(yml)
    assert.equal(feed.version, '0.10.0')
    assert.equal(updateFeedArtifactNameFromYml(yml), 'Videorc-0.10.0-linux-x64.AppImage')
    assert.equal(updateFeedVersionFromYml(yml), '0.10.0')
    assert.equal(updateFeedSha512FromYml(yml), sha512)
    assert.match(yml, /latest-linux\.yml|Videorc-0\.10\.0-linux-x64\.AppImage/)
    assert.doesNotMatch(yml, /latest\.yml|latest-mac\.yml/)
  })

  it('rejects object keys that would mutate another platform lane', () => {
    assert.doesNotThrow(() =>
      assertIsolatedLinuxObjectKey(
        'candidates/linux-alpha/0.10.0-alpha.1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/latest-linux.yml'
      )
    )
    for (const key of [
      'releases/windows/latest/latest.yml',
      'updates/macos/latest-mac.yml',
      'candidates/windows/0.10.0-alpha.1/deadbeef/latest.yml',
      'releases/linux-alpha/0.10.0-alpha.1/latest.yml'
    ]) {
      assert.throws(
        () => assertIsolatedLinuxObjectKey(key),
        (error) =>
          error instanceof LinuxAlphaReleaseError && error.code === 'cross-platform-object-key'
      )
    }
  })
})
