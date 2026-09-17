import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildWindowsReleaseUploadPlan } from './windows-release-upload.mjs'
import { WindowsAlphaReleaseError } from './windows-alpha-release.mjs'

const filename = 'Videorc-0.10.0-win-x64.exe'
const installerBytes = 'installer'
const installerSha256 = createHash('sha256').update(installerBytes).digest('hex')
const installerSha512 = createHash('sha512').update(installerBytes).digest('base64')
const manifest = {
  acceptanceRecordUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1/acceptance',
  acceptanceStatus: 'pass',
  architecture: 'x64',
  bundleVersion: '0.10.0',
  channel: 'alpha',
  displayVersion: '0.10.0 alpha 1',
  filename,
  knownIssuesUrl: 'https://www.videorc.com/windows-alpha',
  minimumWindows: 'Windows 11 or later',
  minimumOS: 'Windows 11 or later',
  objectKey: `releases/windows/0.10.0-alpha.1/${filename}`,
  platform: 'windows',
  product: 'Videorc',
  publisherName: 'Videorc Test Publisher',
  releaseId: '0.10.0-alpha.1',
  releasedAt: '2026-07-18T00:00:00.000Z',
  releaseNotesUrl: 'https://www.videorc.com/releases/0.10.0-alpha.1',
  sha256: installerSha256,
  signingStatus: 'signed',
  sizeBytes: 9,
  sourceCommit: 'b'.repeat(40)
}

async function seed() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'videorc-windows-upload-'))
  const manifestPath = join(releaseDir, 'release.json')
  const ffmpegLicensePath = join(releaseDir, 'LICENSE.txt')
  const ffmpegSourcePath = join(releaseDir, 'SOURCE.txt')
  await writeFile(join(releaseDir, filename), installerBytes)
  await writeFile(join(releaseDir, `${filename}.sha256`), `${installerSha256}  ${filename}\n`)
  await writeFile(join(releaseDir, `${filename}.blockmap`), 'blockmap')
  await writeFile(
    join(releaseDir, 'latest.yml'),
    [
      'version: 0.10.0',
      'files:',
      `  - url: ${filename}`,
      `    sha512: ${installerSha512}`,
      `    size: ${Buffer.byteLength(installerBytes)}`,
      `path: ${filename}`,
      `sha512: ${installerSha512}`,
      "releaseDate: '2026-07-18T00:00:00.000Z'",
      ''
    ].join('\n')
  )
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(ffmpegLicensePath, 'license')
  await writeFile(ffmpegSourcePath, 'source')
  return { ffmpegLicensePath, ffmpegSourcePath, manifestPath, releaseDir }
}

describe('Windows release upload plan', () => {
  it('publishes immutable download files, isolated updater files, and source notices', async () => {
    const paths = await seed()
    const plan = await buildWindowsReleaseUploadPlan({ ...paths, env: {}, manifest })

    assert.equal(plan.prefix, 'releases/windows/0.10.0-alpha.1')
    assert.equal(plan.latestManifestPrefix, 'releases/windows/latest')
    assert.equal(plan.updatesPrefix, 'updates/windows')
    assert.equal(plan.stage, 'public')
    assert.equal(plan.artifacts.find((item) => item.label === 'installer')?.immutable, true)
    assert.equal(plan.artifacts.at(-1)?.immutable, false)
    assert.deepEqual(
      plan.artifacts.map(({ contentType, label, objectKey }) => ({
        contentType,
        label,
        objectKey
      })),
      [
        {
          contentType: 'application/vnd.microsoft.portable-executable',
          label: 'installer',
          objectKey: `releases/windows/0.10.0-alpha.1/${filename}`
        },
        {
          contentType: 'text/plain; charset=utf-8',
          label: 'sha256',
          objectKey: `releases/windows/0.10.0-alpha.1/${filename}.sha256`
        },
        {
          contentType: 'application/json',
          label: 'manifest',
          objectKey: 'releases/windows/0.10.0-alpha.1/release.json'
        },
        {
          contentType: 'text/plain; charset=utf-8',
          label: 'ffmpeg-license',
          objectKey: 'releases/windows/0.10.0-alpha.1/FFMPEG-LICENSE.txt'
        },
        {
          contentType: 'text/plain; charset=utf-8',
          label: 'ffmpeg-source',
          objectKey: 'releases/windows/0.10.0-alpha.1/FFMPEG-SOURCE.txt'
        },
        {
          contentType: 'application/vnd.microsoft.portable-executable',
          label: 'feed-installer',
          objectKey: `updates/windows/${filename}`
        },
        {
          contentType: 'application/octet-stream',
          label: 'feed-blockmap',
          objectKey: `updates/windows/${filename}.blockmap`
        },
        {
          contentType: 'text/yaml; charset=utf-8',
          label: 'feed-manifest',
          objectKey: 'updates/windows/latest.yml'
        },
        {
          contentType: 'application/json',
          label: 'latest-manifest',
          objectKey: 'releases/windows/latest/release.json'
        }
      ]
    )
  })

  it('isolates pending pilot pointers from every stable/public pointer', async () => {
    const paths = await seed()
    const pilotManifest = {
      ...manifest,
      acceptanceRecordUrl: null,
      acceptanceStatus: 'pending'
    }
    await writeFile(paths.manifestPath, JSON.stringify(pilotManifest))
    const plan = await buildWindowsReleaseUploadPlan({
      ...paths,
      env: { VIDEORC_WINDOWS_RELEASE_STAGE: 'pilot' },
      manifest: pilotManifest
    })

    assert.equal(plan.stage, 'pilot')
    assert.equal(plan.latestManifestPrefix, 'releases/windows/pilot')
    assert.equal(plan.updatesPrefix, 'updates/windows/pilot')
    assert.equal(
      plan.artifacts.some((item) => item.label === 'manifest'),
      false
    )
    assert.equal(
      plan.artifacts.some((item) => item.objectKey === 'updates/windows/latest.yml'),
      false
    )
    assert.equal(
      plan.artifacts.some((item) => item.objectKey === 'releases/windows/latest/release.json'),
      false
    )
    assert.equal(
      plan.artifacts.some((item) => item.objectKey === 'changelog/changelog.json'),
      false
    )
    assert.equal(plan.artifacts.at(-2)?.objectKey, 'updates/windows/pilot/latest.yml')
    assert.equal(plan.artifacts.at(-1)?.objectKey, 'releases/windows/pilot/release.json')
    assert.equal(plan.artifacts.at(-1)?.label, 'latest-manifest')
  })

  it('rejects upload-prefix overrides that disagree with the manifest contract', async () => {
    const paths = await seed()
    await assert.rejects(
      buildWindowsReleaseUploadPlan({
        ...paths,
        env: { VIDEORC_WINDOWS_RELEASE_UPLOAD_PREFIX: 'releases/windows/other' },
        manifest
      }),
      (error) =>
        error instanceof WindowsAlphaReleaseError && error.code === 'noncanonical-upload-prefix'
    )
  })

  it('refuses promotion before PASS evidence or with a stale update feed', async () => {
    const paths = await seed()
    await assert.rejects(
      buildWindowsReleaseUploadPlan({
        ...paths,
        env: {},
        manifest: { ...manifest, acceptanceStatus: 'pending', acceptanceRecordUrl: null }
      }),
      (error) => error instanceof WindowsAlphaReleaseError
    )
    await writeFile(join(paths.releaseDir, 'latest.yml'), 'version: 0.10.0\npath: stale.exe\n')
    await assert.rejects(
      buildWindowsReleaseUploadPlan({ ...paths, env: {}, manifest }),
      (error) =>
        error instanceof WindowsAlphaReleaseError && error.code === 'update-feed-artifact-mismatch'
    )
  })
})
