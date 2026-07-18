import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildReleaseUploadPlan,
  buildS3ObjectUrl,
  buildSignedS3Request,
  getReleaseUploadS3Config,
  macUpdateZipName,
  ReleaseUploadConfigError,
  updateFeedZipNameFromYml
} from './release-upload-s3.mjs'

const manifest = {
  filename: 'Videorc-0.9.0-mac-arm64.dmg',
  releaseId: '0.9.0-beta.1'
}

const latestMacYml = [
  'version: 0.9.0',
  'files:',
  '  - url: Videorc-0.9.0-mac-arm64.zip',
  '    sha512: deadbeef',
  '    size: 9',
  'path: Videorc-0.9.0-mac-arm64.zip',
  'sha512: deadbeef',
  ''
].join('\n')

// Seed a release dir with the dmg + checksum + manifest AND the electron-updater
// feed trio (latest-mac.yml, zip, blockmap) the upload now requires.
async function seedReleaseDir() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'videorc-release-upload-'))
  await writeFile(join(releaseDir, manifest.filename), 'dmg')
  await writeFile(join(releaseDir, `${manifest.filename}.sha256`), 'sha')
  const manifestPath = join(releaseDir, 'release.json')
  const manifestJson = JSON.stringify(manifest)
  await writeFile(manifestPath, manifestJson)
  await writeFile(join(releaseDir, 'latest-mac.yml'), latestMacYml)
  await writeFile(join(releaseDir, 'Videorc-0.9.0-mac-arm64.zip'), 'zip-bytes')
  await writeFile(join(releaseDir, 'Videorc-0.9.0-mac-arm64.zip.blockmap'), 'blockmap')
  return { releaseDir, manifestPath, manifestJson }
}

const env = {
  VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID: 'VIDEORCTEST',
  VIDEORC_DOWNLOAD_S3_BUCKET: 'videorc-downloads',
  VIDEORC_DOWNLOAD_S3_ENDPOINT_URL: 'https://r2.example.test',
  VIDEORC_DOWNLOAD_S3_REGION: 'auto',
  VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY: 'download-secret'
}

describe('release S3 upload config', () => {
  it('uses the web download S3 environment names by default', () => {
    assert.deepEqual(getReleaseUploadS3Config(env), {
      accessKeyId: 'VIDEORCTEST',
      bucket: 'videorc-downloads',
      endpointUrl: 'https://r2.example.test/',
      forcePathStyle: true,
      region: 'auto',
      secretAccessKey: 'download-secret',
      sessionToken: null
    })
  })

  it('allows release-upload-specific environment names to override web names', () => {
    assert.deepEqual(
      getReleaseUploadS3Config({
        ...env,
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'UPLOADKEY',
        VIDEORC_RELEASE_UPLOAD_S3_BUCKET: 'release-bucket',
        VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL: 'https://s3.example.test/base',
        VIDEORC_RELEASE_UPLOAD_S3_FORCE_PATH_STYLE: '0',
        VIDEORC_RELEASE_UPLOAD_S3_REGION: 'us-east-1',
        VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'upload-secret',
        VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN: 'session-token'
      }),
      {
        accessKeyId: 'UPLOADKEY',
        bucket: 'release-bucket',
        endpointUrl: 'https://s3.example.test/base',
        forcePathStyle: true,
        region: 'us-east-1',
        secretAccessKey: 'upload-secret',
        sessionToken: 'session-token'
      }
    )
  })

  it('fails closed when required S3 credentials are missing', () => {
    assert.throws(
      () => getReleaseUploadS3Config({ VIDEORC_DOWNLOAD_S3_BUCKET: 'bucket' }),
      (error) => error instanceof ReleaseUploadConfigError && error.code === 'missing-access-key-id'
    )
  })

  it('rejects invalid S3 endpoints', () => {
    for (const endpoint of [
      'ftp://r2.example.test',
      'http://r2.example.test',
      'https://user:password@r2.example.test',
      'https://r2.example.test?redirect=attacker'
    ]) {
      assert.throws(
        () =>
          getReleaseUploadS3Config({
            ...env,
            VIDEORC_DOWNLOAD_S3_ENDPOINT_URL: endpoint
          }),
        (error) =>
          error instanceof ReleaseUploadConfigError && error.code === 'invalid-endpoint-url'
      )
    }
  })
})

describe('release S3 upload plan', () => {
  it('uploads the dmg archive plus the electron-updater feed trio', async () => {
    const { releaseDir, manifestPath, manifestJson } = await seedReleaseDir()

    const plan = await buildReleaseUploadPlan({
      env: {},
      manifest,
      manifestPath,
      releaseDir
    })

    assert.equal(plan.releaseId, '0.9.0-beta.1')
    assert.equal(plan.prefix, 'releases/macos/0.9.0-beta.1')
    assert.equal(plan.updatesPrefix, 'updates/macos')
    assert.deepEqual(
      plan.artifacts.map((artifact) => ({
        contentType: artifact.contentType,
        label: artifact.label,
        objectKey: artifact.objectKey,
        sizeBytes: artifact.sizeBytes
      })),
      [
        {
          contentType: 'application/x-apple-diskimage',
          label: 'dmg',
          objectKey: 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg',
          sizeBytes: 3
        },
        {
          contentType: 'text/plain; charset=utf-8',
          label: 'sha256',
          objectKey: 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg.sha256',
          sizeBytes: 3
        },
        {
          contentType: 'application/json',
          label: 'manifest',
          objectKey: 'releases/macos/0.9.0-beta.1/release.json',
          sizeBytes: Buffer.byteLength(manifestJson)
        },
        {
          // The stable download manifest: videorc-web's
          // VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY points here once and every
          // release refreshes the download page automatically.
          contentType: 'application/json',
          label: 'latest-manifest',
          objectKey: 'releases/macos/latest/release.json',
          sizeBytes: Buffer.byteLength(manifestJson)
        },
        {
          contentType: 'text/yaml; charset=utf-8',
          label: 'feed-manifest',
          objectKey: 'updates/macos/latest-mac.yml',
          sizeBytes: Buffer.byteLength(latestMacYml)
        },
        {
          contentType: 'application/zip',
          label: 'feed-zip',
          objectKey: 'updates/macos/Videorc-0.9.0-mac-arm64.zip',
          sizeBytes: Buffer.byteLength('zip-bytes')
        },
        {
          contentType: 'application/octet-stream',
          label: 'feed-blockmap',
          objectKey: 'updates/macos/Videorc-0.9.0-mac-arm64.zip.blockmap',
          sizeBytes: Buffer.byteLength('blockmap')
        }
      ]
    )
  })

  it('appends the compiled changelog to a stable prefix when a path is provided', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()
    const changelogJsonPath = join(releaseDir, 'changelog.json')
    await writeFile(changelogJsonPath, '{"entries":[]}')

    const plan = await buildReleaseUploadPlan({
      changelogJsonPath,
      env: {},
      manifest,
      manifestPath,
      releaseDir
    })

    assert.deepEqual(plan.artifacts.at(-1), {
      contentType: 'application/json',
      label: 'changelog',
      objectKey: 'changelog/changelog.json',
      path: changelogJsonPath,
      sizeBytes: Buffer.byteLength('{"entries":[]}')
    })

    const prefixed = await buildReleaseUploadPlan({
      changelogJsonPath,
      env: { VIDEORC_RELEASE_CHANGELOG_PREFIX: ' public/changelog/ ' },
      manifest,
      manifestPath,
      releaseDir
    })
    assert.equal(prefixed.artifacts.at(-1)?.objectKey, 'public/changelog/changelog.json')
  })

  it('allows explicit archive, feed, and latest-manifest prefixes', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()

    const plan = await buildReleaseUploadPlan({
      env: {
        VIDEORC_RELEASE_UPLOAD_PREFIX: ' macos/beta/latest/ ',
        VIDEORC_RELEASE_UPDATES_PREFIX: ' channels/stable/ ',
        VIDEORC_RELEASE_LATEST_MANIFEST_PREFIX: ' downloads/current/ '
      },
      manifest,
      manifestPath,
      releaseDir
    })

    assert.equal(plan.prefix, 'macos/beta/latest')
    assert.equal(plan.updatesPrefix, 'channels/stable')
    assert.equal(plan.artifacts.at(0)?.objectKey, 'macos/beta/latest/Videorc-0.9.0-mac-arm64.dmg')
    assert.equal(plan.artifacts.at(3)?.objectKey, 'downloads/current/release.json')
    assert.equal(plan.artifacts.at(4)?.objectKey, 'channels/stable/latest-mac.yml')
  })

  it('fails closed when the feed manifest is missing', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()
    await rm(join(releaseDir, 'latest-mac.yml'))

    await assert.rejects(
      buildReleaseUploadPlan({ env: {}, manifest, manifestPath, releaseDir }),
      (error) =>
        error instanceof ReleaseUploadConfigError && error.code === 'missing-update-feed-manifest'
    )
  })

  it('fails closed when latest-mac.yml points at a stale zip', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()
    await writeFile(
      join(releaseDir, 'latest-mac.yml'),
      latestMacYml.replaceAll('Videorc-0.9.0-mac-arm64.zip', 'Videorc-0.8.0-mac-arm64.zip')
    )

    await assert.rejects(
      buildReleaseUploadPlan({ env: {}, manifest, manifestPath, releaseDir }),
      (error) =>
        error instanceof ReleaseUploadConfigError && error.code === 'update-feed-zip-mismatch'
    )
  })
})

describe('update feed helpers', () => {
  it('derives the update zip name from the dmg name', () => {
    assert.equal(macUpdateZipName('Videorc-0.9.0-mac-arm64.dmg'), 'Videorc-0.9.0-mac-arm64.zip')
  })

  it('rejects a non-dmg filename', () => {
    assert.throws(
      () => macUpdateZipName('Videorc-0.9.0-mac-arm64.zip'),
      (error) => error instanceof ReleaseUploadConfigError && error.code === 'invalid-dmg-filename'
    )
  })

  it('reads the primary zip from latest-mac.yml', () => {
    assert.equal(updateFeedZipNameFromYml(latestMacYml), 'Videorc-0.9.0-mac-arm64.zip')
    assert.equal(updateFeedZipNameFromYml('version: 1.0.0\n'), null)
  })
})

describe('release S3 request signing', () => {
  it('builds path-style object URLs for S3-compatible endpoints', () => {
    const config = getReleaseUploadS3Config(env)
    assert.equal(
      buildS3ObjectUrl(config, 'releases/macos/0.9.0-beta.1/release.json').toString(),
      'https://r2.example.test/videorc-downloads/releases/macos/0.9.0-beta.1/release.json'
    )
  })

  it('signs PUT and HEAD requests without exposing the secret access key', () => {
    const config = getReleaseUploadS3Config(env)
    const put = buildSignedS3Request({
      config,
      method: 'PUT',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })
    const head = buildSignedS3Request({
      config,
      method: 'HEAD',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })

    assert.equal(put.url.includes('download-secret'), false)
    assert.equal(put.headers.Authorization.includes('download-secret'), false)
    assert.match(put.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=VIDEORCTEST\//)
    assert.equal(head.headers['X-Amz-Content-Sha256'], 'UNSIGNED-PAYLOAD')
  })

  it('canonicalizes and signs additional x-amz metadata headers', () => {
    const config = getReleaseUploadS3Config(env)
    const request = buildSignedS3Request({
      additionalHeaders: {
        'X-Amz-Meta-Sha256': `  ${'a'.repeat(64)}  `,
        'x-amz-meta-source': 'candidate   workflow'
      },
      config,
      method: 'PUT',
      objectKey: 'candidates/windows/0.10.0-alpha.1/release.json'
    })

    assert.equal(request.headers['x-amz-meta-sha256'], 'a'.repeat(64))
    assert.equal(request.headers['x-amz-meta-source'], 'candidate workflow')
    assert.match(
      request.headers.Authorization,
      /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256;x-amz-meta-source/
    )
  })

  it('rejects host/reserved overrides and unsafe additional signed headers', () => {
    const config = getReleaseUploadS3Config(env)
    for (const additionalHeaders of [
      { Host: 'attacker.example.test' },
      { Authorization: 'replacement' },
      { 'X-Amz-Date': 'replacement' },
      { 'x-amz-meta-test': 'line one\nline two' },
      { 'invalid header': 'value' }
    ]) {
      assert.throws(
        () =>
          buildSignedS3Request({
            additionalHeaders,
            config,
            method: 'PUT',
            objectKey: 'candidate'
          }),
        ReleaseUploadConfigError
      )
    }
  })
})
