import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { deriveMacosD3DestinationBindingFromRelease } from './macos-d3-destination-binding-plan.mjs'
import {
  getReleaseUploadS3Config,
  getReleaseUploadS3DestinationConfig
} from './release-upload-s3.mjs'

const destinationEnv = {
  VIDEORC_RELEASE_UPLOAD_S3_BUCKET: 'videorc-releases',
  VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL: 'https://account.r2.cloudflarestorage.com/',
  VIDEORC_RELEASE_UPLOAD_S3_FORCE_PATH_STYLE: '1',
  VIDEORC_RELEASE_UPLOAD_S3_REGION: 'auto',
  VIDEORC_RELEASE_UPLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS:
    ' Google Trust Services,Example Backup CA '
}
const execFileAsync = promisify(execFile)

describe('macOS D3 prepublication destination binding', () => {
  it('exposes the credential-free derivation command through the package scripts', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    )
    assert.equal(
      packageJson.scripts['release:derive:capture-decay-d3-destination-binding'],
      'node scripts/derive-macos-d3-destination-binding.mjs'
    )
  })

  it('derives the exact credential-free route commitment and includes changelog by default', async () => {
    const fixture = await releaseFixture()
    try {
      const first = await deriveMacosD3DestinationBindingFromRelease({
        env: destinationEnv,
        manifestPath: fixture.manifestPath,
        releaseDir: fixture.releaseDir
      })
      const second = await deriveMacosD3DestinationBindingFromRelease({
        env: {
          ...destinationEnv,
          VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'ignored-writer-key',
          VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'ignored-writer-secret'
        },
        manifestPath: fixture.manifestPath,
        releaseDir: fixture.releaseDir
      })

      assert.match(first.destinationBinding.sha256, /^[a-f0-9]{64}$/)
      assert.equal(second.destinationBinding.sha256, first.destinationBinding.sha256)
      assert.deepEqual(
        first.destinationBinding.document.uploadPlan.map((route) => [
          route.label,
          route.phase,
          route.objectKey
        ]),
        [
          ['dmg', 'immutable', 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg'],
          ['sha256', 'immutable', 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg.sha256'],
          ['manifest', 'immutable', 'releases/macos/0.9.0-beta.1/release.json'],
          ['feed-zip', 'immutable', 'updates/macos/Videorc-0.9.0-mac-arm64.zip'],
          ['feed-blockmap', 'immutable', 'updates/macos/Videorc-0.9.0-mac-arm64.zip.blockmap'],
          [
            'd3-publication-reservation',
            'reservation',
            'releases/macos/0.9.0-beta.1/capture-decay-d3-publication-reservation.json'
          ],
          ['latest-manifest', 'pointer', 'releases/macos/latest/release.json'],
          ['feed-manifest', 'pointer', 'updates/macos/latest-mac.yml'],
          ['changelog', 'pointer', 'changelog/changelog.json']
        ]
      )
      assert.deepEqual(first.destinationBinding.document.destination, {
        bucket: 'videorc-releases',
        endpointUrl: 'https://account.r2.cloudflarestorage.com/',
        forcePathStyle: true,
        region: 'auto',
        tlsPolicy: {
          allowedIssuerOrganizations: ['Example Backup CA', 'Google Trust Services'],
          allowedSpkiSha256: []
        }
      })

      const command = await execFileAsync(
        process.execPath,
        [
          fileURLToPath(new URL('../derive-macos-d3-destination-binding.mjs', import.meta.url)),
          '--release-dir',
          fixture.releaseDir,
          '--manifest',
          fixture.manifestPath
        ],
        { env: { ...destinationEnv, PATH: process.env.PATH ?? '' } }
      )
      assert.equal(command.stderr, '')
      assert.equal(command.stdout, `${first.destinationBinding.sha256}\n`)

      const withoutChangelog = await deriveMacosD3DestinationBindingFromRelease({
        env: destinationEnv,
        includeChangelog: false,
        manifestPath: fixture.manifestPath,
        releaseDir: fixture.releaseDir
      })
      assert.notEqual(withoutChangelog.destinationBinding.sha256, first.destinationBinding.sha256)
      assert.equal(
        withoutChangelog.destinationBinding.document.uploadPlan.some(
          (route) => route.label === 'changelog'
        ),
        false
      )
    } finally {
      await rm(fixture.releaseDir, { force: true, recursive: true })
    }
  })

  it('uses the uploader destination normalization without requiring writer credentials', () => {
    const credentialFree = getReleaseUploadS3DestinationConfig(destinationEnv)
    const uploader = getReleaseUploadS3Config({
      ...destinationEnv,
      VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'writer-key',
      VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'writer-secret'
    })
    assert.deepEqual(credentialFree, {
      bucket: uploader.bucket,
      endpointUrl: uploader.endpointUrl,
      forcePathStyle: uploader.forcePathStyle,
      region: uploader.region,
      tlsPolicy: uploader.tlsPolicy
    })
  })

  it('fails closed when release.json, the checksum sidecar, or the DMG disagree', async () => {
    for (const mutate of [
      async (fixture) => writeFile(fixture.dmgPath, 'changed-dmg'),
      async (fixture) => writeFile(fixture.sidecarPath, `${'0'.repeat(64)}  wrong.dmg\n`),
      async (fixture) => {
        const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'))
        manifest.objectKey = `releases/macos/${manifest.releaseId}/different.dmg`
        await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      }
    ]) {
      const fixture = await releaseFixture()
      try {
        await mutate(fixture)
        await assert.rejects(
          deriveMacosD3DestinationBindingFromRelease({
            env: destinationEnv,
            manifestPath: fixture.manifestPath,
            releaseDir: fixture.releaseDir
          })
        )
      } finally {
        await rm(fixture.releaseDir, { force: true, recursive: true })
      }
    }
  })

  it('fails closed when latest-mac.yml does not bind the exact ZIP bytes and version', async () => {
    for (const replacement of [
      ['version: 0.9.0', 'version: 0.8.0'],
      ['size: 16', 'size: 17'],
      ['path: Videorc-0.9.0-mac-arm64.zip', 'path: stale.zip'],
      ['sha512:', `sha512: ${Buffer.from('wrong').toString('base64')} #`]
    ]) {
      const fixture = await releaseFixture()
      try {
        const feed = await readFile(fixture.feedPath, 'utf8')
        await writeFile(fixture.feedPath, feed.replace(...replacement))
        await assert.rejects(
          deriveMacosD3DestinationBindingFromRelease({
            env: destinationEnv,
            manifestPath: fixture.manifestPath,
            releaseDir: fixture.releaseDir
          })
        )
      } finally {
        await rm(fixture.releaseDir, { force: true, recursive: true })
      }
    }
  })
})

async function releaseFixture() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'videorc-d3-destination-'))
  const filename = 'Videorc-0.9.0-mac-arm64.dmg'
  const zipFilename = 'Videorc-0.9.0-mac-arm64.zip'
  const dmgBytes = Buffer.from('signed-dmg-fixture')
  const zipBytes = Buffer.from('update-zip-bytes')
  const dmgSha256 = sha256(dmgBytes)
  const dmgSha512 = createHash('sha512').update(dmgBytes).digest('base64')
  const zipSha512 = createHash('sha512').update(zipBytes).digest('base64')
  const manifest = {
    product: 'Videorc',
    channel: 'beta',
    releaseId: '0.9.0-beta.1',
    displayVersion: '0.9.0 beta 1',
    bundleVersion: '0.9.0',
    platform: 'macos',
    architecture: 'arm64',
    filename,
    objectKey: `releases/macos/0.9.0-beta.1/${filename}`,
    sha256: dmgSha256,
    sizeBytes: dmgBytes.byteLength,
    minimumMacOS: 'macOS 13 Ventura or later',
    releasedAt: '2026-08-29T12:00:00.000Z',
    releaseNotesUrl: 'https://www.videorc.com/releases/0.9.0-beta.1'
  }
  const manifestPath = join(releaseDir, 'release.json')
  const dmgPath = join(releaseDir, filename)
  const sidecarPath = join(releaseDir, `${filename}.sha256`)
  const feedPath = join(releaseDir, 'latest-mac.yml')
  await Promise.all([
    writeFile(dmgPath, dmgBytes),
    writeFile(sidecarPath, `${dmgSha256}  ${filename}\n`),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(releaseDir, zipFilename), zipBytes),
    writeFile(join(releaseDir, `${zipFilename}.blockmap`), 'blockmap'),
    writeFile(
      feedPath,
      [
        'version: 0.9.0',
        'files:',
        `  - url: ${zipFilename}`,
        `    sha512: '${zipSha512}'`,
        `    size: ${zipBytes.byteLength}`,
        `  - url: ${filename}`,
        `    sha512: '${dmgSha512}'`,
        `    size: ${dmgBytes.byteLength}`,
        `path: ${zipFilename}`,
        `sha512: '${zipSha512}'`,
        "releaseDate: '2026-08-29T12:00:00.000Z'",
        ''
      ].join('\n')
    )
  ])
  return { dmgPath, feedPath, manifestPath, releaseDir, sidecarPath }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
