import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  assertReleaseUploadTlsPeer,
  buildReleaseUploadHttpsAgentOptions,
  ReleaseUploadHttpsTransportError
} from './release-upload-https-transport.mjs'
import {
  assertMacosD3ExactPromotionUploadRoutes,
  buildMacosD3PublicationReservation,
  buildReleasePutCondition,
  buildReleaseUploadPlan,
  buildS3ObjectUrl,
  buildSignedS3Request,
  exactMacosPromotionChangelogGeneratedAt,
  getReleaseUploadS3Config,
  inspectReleaseUploadArtifact,
  MACOS_D3_PROMOTION_WORKFLOW_PATH,
  MACOS_D3_PUBLICATION_RESERVATION_PROFILE,
  MACOS_RELEASE_REPOSITORY,
  macUpdateZipName,
  partitionReleaseUploadArtifacts,
  publishReleaseUploadArtifact,
  publishReleaseUploadPhases,
  reverifyReleaseUploadPublication,
  ReleaseUploadConfigError,
  ReleaseUploadTransportError,
  sha256Base64FromHex,
  updateFeedZipNameFromYml,
  verifyReleaseUploadArtifact
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
  VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY: 'download-secret',
  VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: 'Test Issuer'
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
      sessionToken: null,
      tlsPolicy: {
        allowedIssuerOrganizations: ['Test Issuer'],
        allowedSpkiSha256: []
      }
    })
  })

  it('allows release-upload-specific environment names to override web names', () => {
    assert.deepEqual(
      getReleaseUploadS3Config({
        ...env,
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'UPLOADKEY',
        VIDEORC_RELEASE_UPLOAD_S3_BUCKET: 'release-bucket',
        VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL: 'https://s3.example.test',
        VIDEORC_RELEASE_UPLOAD_S3_FORCE_PATH_STYLE: '0',
        VIDEORC_RELEASE_UPLOAD_S3_REGION: 'us-east-1',
        VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'upload-secret',
        VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN: 'session-token'
      }),
      {
        accessKeyId: 'UPLOADKEY',
        bucket: 'release-bucket',
        endpointUrl: 'https://s3.example.test/',
        forcePathStyle: true,
        region: 'us-east-1',
        secretAccessKey: 'upload-secret',
        sessionToken: 'session-token',
        tlsPolicy: {
          allowedIssuerOrganizations: ['Test Issuer'],
          allowedSpkiSha256: []
        }
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
      'https://r2.example.test?redirect=attacker',
      'https://r2.example.test/videorc-downloads',
      'https://r2.example.test/another/base/path',
      'https://r2.example.test//'
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

  it('defaults known R2 and AWS endpoints to their expected issuer and fails custom endpoints closed', () => {
    const r2 = getReleaseUploadS3Config({
      ...env,
      VIDEORC_DOWNLOAD_S3_ENDPOINT_URL: 'https://account.r2.cloudflarestorage.com',
      VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: ''
    })
    assert.deepEqual(r2.tlsPolicy, {
      allowedIssuerOrganizations: ['Google Trust Services'],
      allowedSpkiSha256: []
    })

    const aws = getReleaseUploadS3Config({
      ...env,
      VIDEORC_DOWNLOAD_S3_ENDPOINT_URL: '',
      VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: ''
    })
    assert.deepEqual(aws.tlsPolicy, {
      allowedIssuerOrganizations: ['Amazon'],
      allowedSpkiSha256: []
    })

    assert.throws(
      () =>
        getReleaseUploadS3Config({
          ...env,
          VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: ''
        }),
      (error) => error instanceof ReleaseUploadConfigError && error.code === 'missing-tls-policy'
    )
  })

  it('rejects malformed TLS pins before making a request', () => {
    assert.throws(
      () =>
        getReleaseUploadS3Config({
          ...env,
          VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: '',
          VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_SPKI_SHA256: 'not-a-sha256'
        }),
      (error) =>
        error instanceof ReleaseUploadConfigError && error.code === 'invalid-tls-spki-policy'
    )
  })

  it('canonicalizes TLS issuer and SPKI allowlists before they are bound', () => {
    const config = getReleaseUploadS3Config({
      ...env,
      VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: ' Zulu CA,Alpha CA ',
      VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_SPKI_SHA256: `${'B'.repeat(64)},${'a'.repeat(64)}`
    })
    assert.deepEqual(config.tlsPolicy, {
      allowedIssuerOrganizations: ['Alpha CA', 'Zulu CA'],
      allowedSpkiSha256: ['a'.repeat(64), 'b'.repeat(64)]
    })

    assert.throws(
      () =>
        getReleaseUploadS3Config({
          ...env,
          VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: '',
          VIDEORC_DOWNLOAD_S3_TLS_ALLOWED_SPKI_SHA256: `${'A'.repeat(64)},${'a'.repeat(64)}`
        }),
      (error) => error instanceof ReleaseUploadConfigError && error.code === 'invalid-tls-policy'
    )
  })
})

describe('release HTTPS peer policy', () => {
  it('requires a fresh authorized TLS handshake for every signed request', () => {
    const options = buildReleaseUploadHttpsAgentOptions({
      allowedIssuerOrganizations: ['Google Trust Services'],
      allowedSpkiSha256: []
    })
    assert.equal(options.keepAlive, false)
    assert.equal(options.maxCachedSessions, 0)
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(typeof options.checkServerIdentity, 'function')
  })

  it('accepts the configured issuer and rejects a Packetland issuer', () => {
    const tlsPolicy = {
      allowedIssuerOrganizations: ['Google Trust Services'],
      allowedSpkiSha256: []
    }
    assert.deepEqual(
      assertReleaseUploadTlsPeer({
        certificate: { issuer: { O: 'Google Trust Services' } },
        tlsPolicy
      }),
      { issuerOrganization: 'Google Trust Services', spkiSha256: null }
    )
    assert.throws(
      () =>
        assertReleaseUploadTlsPeer({
          certificate: { issuer: { O: 'Packetland' } },
          tlsPolicy
        }),
      (error) =>
        error instanceof ReleaseUploadHttpsTransportError && error.code === 'tls-issuer-rejected'
    )
  })

  it('requires an exact configured SPKI SHA-256 on every peer check', () => {
    const expectedSpki = 'a'.repeat(64)
    const tlsPolicy = {
      allowedIssuerOrganizations: [],
      allowedSpkiSha256: [expectedSpki]
    }
    assert.deepEqual(
      assertReleaseUploadTlsPeer(
        { certificate: { raw: Buffer.from('fixture') }, tlsPolicy },
        { spkiSha256FromCertificate: () => expectedSpki }
      ),
      { issuerOrganization: '', spkiSha256: expectedSpki }
    )
    assert.throws(
      () =>
        assertReleaseUploadTlsPeer(
          { certificate: { raw: Buffer.from('fixture') }, tlsPolicy },
          { spkiSha256FromCertificate: () => 'b'.repeat(64) }
        ),
      (error) =>
        error instanceof ReleaseUploadHttpsTransportError && error.code === 'tls-spki-rejected'
    )
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
        immutable: artifact.immutable,
        label: artifact.label,
        objectKey: artifact.objectKey,
        sizeBytes: artifact.sizeBytes
      })),
      [
        {
          contentType: 'application/x-apple-diskimage',
          immutable: true,
          label: 'dmg',
          objectKey: 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg',
          sizeBytes: 3
        },
        {
          contentType: 'text/plain; charset=utf-8',
          immutable: true,
          label: 'sha256',
          objectKey: 'releases/macos/0.9.0-beta.1/Videorc-0.9.0-mac-arm64.dmg.sha256',
          sizeBytes: 3
        },
        {
          contentType: 'application/json',
          immutable: true,
          label: 'manifest',
          objectKey: 'releases/macos/0.9.0-beta.1/release.json',
          sizeBytes: Buffer.byteLength(manifestJson)
        },
        {
          contentType: 'application/zip',
          immutable: false,
          label: 'feed-zip',
          objectKey: 'updates/macos/Videorc-0.9.0-mac-arm64.zip',
          sizeBytes: Buffer.byteLength('zip-bytes')
        },
        {
          contentType: 'application/octet-stream',
          immutable: false,
          label: 'feed-blockmap',
          objectKey: 'updates/macos/Videorc-0.9.0-mac-arm64.zip.blockmap',
          sizeBytes: Buffer.byteLength('blockmap')
        },
        {
          // The stable download manifest: videorc-web's
          // VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY points here once and every
          // release refreshes the download page automatically.
          contentType: 'application/json',
          immutable: false,
          label: 'latest-manifest',
          objectKey: 'releases/macos/latest/release.json',
          sizeBytes: Buffer.byteLength(manifestJson)
        },
        {
          contentType: 'text/yaml; charset=utf-8',
          immutable: false,
          label: 'feed-manifest',
          objectKey: 'updates/macos/latest-mac.yml',
          sizeBytes: Buffer.byteLength(latestMacYml)
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
      immutable: false,
      label: 'changelog',
      objectKey: 'changelog/changelog.json',
      path: changelogJsonPath,
      sizeBytes: Buffer.byteLength('{"entries":[]}')
    })

    const prefixed = await buildReleaseUploadPlan({
      changelogJsonPath,
      env: { VIDEORC_RELEASE_CHANGELOG_PREFIX: ' public/changelog ' },
      manifest,
      manifestPath,
      releaseDir
    })
    assert.equal(prefixed.artifacts.at(-1)?.objectKey, 'public/changelog/changelog.json')
  })

  it('keeps exact-promotion updater payloads immutable and ahead of stable pointers', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()
    const changelogJsonPath = join(releaseDir, 'changelog.json')
    await writeFile(changelogJsonPath, '{"entries":[]}')

    const plan = await buildReleaseUploadPlan({
      changelogJsonPath,
      env: {},
      exactPromotion: true,
      manifest,
      manifestPath,
      releaseDir
    })
    const { immutableArtifacts, pointerArtifacts } = partitionReleaseUploadArtifacts(plan.artifacts)

    assert.deepEqual(
      immutableArtifacts.map((artifact) => artifact.label),
      ['dmg', 'sha256', 'manifest', 'feed-zip', 'feed-blockmap']
    )
    assert.deepEqual(
      pointerArtifacts.map((artifact) => artifact.label),
      ['latest-manifest', 'feed-manifest', 'changelog']
    )
    assert.deepEqual(plan.artifacts, [...immutableArtifacts, ...pointerArtifacts])
  })

  it('keeps normal updater payloads replaceable across beta ids sharing one bundle version', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()
    const first = await buildReleaseUploadPlan({
      env: {},
      manifest,
      manifestPath,
      releaseDir
    })
    const second = await buildReleaseUploadPlan({
      env: {},
      manifest: { ...manifest, releaseId: '0.9.0-beta.2' },
      manifestPath,
      releaseDir
    })

    for (const label of ['feed-zip', 'feed-blockmap']) {
      const firstArtifact = first.artifacts.find((artifact) => artifact.label === label)
      const secondArtifact = second.artifacts.find((artifact) => artifact.label === label)
      assert.equal(firstArtifact.objectKey, secondArtifact.objectKey)
      assert.equal(firstArtifact.immutable, false)
      assert.equal(secondArtifact.immutable, false)
    }
  })

  it('rejects configured prefixes with empty or dot components instead of collapsing them', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()
    for (const prefix of [
      'releases//macos/0.9.0-beta.1',
      'releases/ /macos/0.9.0-beta.1',
      'releases/./macos/0.9.0-beta.1',
      'releases/macos/../0.9.0-beta.1',
      'releases/macos/0.9.0-beta.1/'
    ]) {
      await assert.rejects(
        buildReleaseUploadPlan({
          env: { VIDEORC_RELEASE_UPLOAD_PREFIX: prefix },
          manifest,
          manifestPath,
          releaseDir
        }),
        (error) =>
          error instanceof ReleaseUploadConfigError && error.code === 'invalid-upload-object-key'
      )
    }
  })

  it('allows explicit archive, feed, and latest-manifest prefixes', async () => {
    const { releaseDir, manifestPath } = await seedReleaseDir()

    const plan = await buildReleaseUploadPlan({
      env: {
        VIDEORC_RELEASE_UPLOAD_PREFIX: ' macos/beta/latest ',
        VIDEORC_RELEASE_UPDATES_PREFIX: ' channels/stable ',
        VIDEORC_RELEASE_LATEST_MANIFEST_PREFIX: ' downloads/current '
      },
      manifest,
      manifestPath,
      releaseDir
    })

    assert.equal(plan.prefix, 'macos/beta/latest')
    assert.equal(plan.updatesPrefix, 'channels/stable')
    assert.equal(plan.artifacts.at(0)?.objectKey, 'macos/beta/latest/Videorc-0.9.0-mac-arm64.dmg')
    assert.equal(plan.artifacts.at(5)?.objectKey, 'downloads/current/release.json')
    assert.equal(plan.artifacts.at(6)?.objectKey, 'channels/stable/latest-mac.yml')
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

  it('rejects a path-bearing endpoint even when URL construction bypasses environment parsing', () => {
    const config = {
      ...getReleaseUploadS3Config(env),
      endpointUrl: 'https://r2.example.test/videorc-downloads'
    }
    assert.throws(
      () => buildS3ObjectUrl(config, 'releases/macos/0.9.0-beta.1/release.json'),
      (error) => error instanceof ReleaseUploadConfigError && error.code === 'invalid-endpoint-url'
    )
  })

  it('rejects collapsible object-key components before URL construction', () => {
    const config = getReleaseUploadS3Config(env)
    for (const objectKey of [
      '',
      '/release.json',
      'releases//release.json',
      'releases/./release.json',
      'releases/../release.json',
      'releases/release.json/'
    ]) {
      assert.throws(
        () => buildS3ObjectUrl(config, objectKey),
        (error) =>
          error instanceof ReleaseUploadConfigError && error.code === 'invalid-upload-object-key'
      )
    }
  })

  it('round-trips every component of the bound object key without URL collapse', () => {
    const config = getReleaseUploadS3Config(env)
    const objectKey = 'releases/macos/0.9.0-beta.1/Videorc beta+1?#.dmg'
    const url = buildS3ObjectUrl(config, objectKey)
    const roundTripped = url.pathname
      .split('/')
      .slice(2)
      .map((part) => decodeURIComponent(part))
      .join('/')

    assert.equal(roundTripped, objectKey)
    assert.equal(
      url.pathname,
      '/videorc-downloads/releases/macos/0.9.0-beta.1/Videorc%20beta%2B1%3F%23.dmg'
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

  it('signs the actual PUT payload hash and its base64 S3 checksum', () => {
    const config = getReleaseUploadS3Config(env)
    const payloadSha256 = sha256('signed payload')
    const request = buildSignedS3Request({
      additionalHeaders: { 'If-None-Match': '*' },
      config,
      method: 'PUT',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json',
      payloadSha256
    })

    assert.equal(request.headers['X-Amz-Content-Sha256'], payloadSha256)
    assert.equal(request.headers['X-Amz-Checksum-Sha256'], sha256Base64FromHex(payloadSha256))
    assert.equal(request.headers['if-none-match'], '*')
    assert.match(
      request.headers.Authorization,
      /SignedHeaders=host;if-none-match;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date/
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

describe('conditional release publication', () => {
  it('treats exact bytes with a wrong response envelope as different', async () => {
    const artifact = inlineArtifact({
      body: 'receipt-bound bytes',
      immutable: true,
      label: 'manifest',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })
    const config = getReleaseUploadS3Config(env)
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-length': String(artifact.sizeBytes + 1) },
      { 'x-amz-meta-videorc-sha256': '0'.repeat(64) },
      { 'x-amz-checksum-sha256': sha256Base64FromHex('0'.repeat(64)) }
    ]) {
      const inspected = await inspectReleaseUploadArtifact({
        artifact,
        config,
        transport: requestTransport(async () =>
          response(artifact.body, 200, { etag: '"wrong-envelope"', ...headers })
        )
      })
      assert.equal(inspected.state, 'different')
      await assert.rejects(
        verifyReleaseUploadArtifact({
          artifact,
          config,
          transport: requestTransport(async () =>
            response(artifact.body, 200, { etag: '"wrong-envelope"', ...headers })
          )
        }),
        (error) =>
          error instanceof ReleaseUploadTransportError && error.code === 'remote-artifact-mismatch'
      )
    }
  })

  it('reads no more than the expected size plus one byte and aborts an oversized stream', async () => {
    const artifact = inlineArtifact({
      body: 'four',
      immutable: true,
      label: 'manifest',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })
    let aborted = false
    const body = {
      async *[Symbol.asyncIterator]() {
        try {
          yield Buffer.from('oversized-response-body')
          await new Promise(() => {})
        } finally {
          aborted = true
        }
      }
    }
    const inspected = await inspectReleaseUploadArtifact({
      artifact,
      bodyReadTimeoutMs: 50,
      config: getReleaseUploadS3Config(env),
      transport: requestTransport(async () =>
        rawResponse(body, artifact, { 'content-length': String(artifact.sizeBytes) })
      )
    })
    assert.equal(inspected.state, 'different')
    assert.equal(inspected.sizeBytes, artifact.sizeBytes + 1)
    assert.equal(inspected.sha256, null)
    assert.equal(aborted, true)
  })

  it('aborts a response body that returns the expected prefix but never finishes', async () => {
    const artifact = inlineArtifact({
      body: 'bounded',
      immutable: true,
      label: 'manifest',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })
    let aborted = false
    let calls = 0
    const iterator = {
      next() {
        calls += 1
        if (calls === 1) return Promise.resolve({ done: false, value: artifact.body })
        return new Promise(() => {})
      },
      return() {
        aborted = true
        return Promise.resolve({ done: true })
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
    await assert.rejects(
      inspectReleaseUploadArtifact({
        artifact,
        bodyReadTimeoutMs: 20,
        config: getReleaseUploadS3Config(env),
        transport: requestTransport(async () => rawResponse(iterator, artifact))
      }),
      (error) =>
        error instanceof ReleaseUploadTransportError &&
        error.code === 'remote-response-body-timeout'
    )
    assert.equal(aborted, true)
  })

  it('does not follow or retry a redirect from the signed S3 request', async () => {
    const artifact = inlineArtifact({
      body: 'immutable bytes',
      immutable: true,
      label: 'manifest',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })
    let requestCount = 0
    await assert.rejects(
      publishReleaseUploadArtifact({
        artifact,
        config: getReleaseUploadS3Config(env),
        transport: requestTransport(async () => {
          requestCount += 1
          return response(null, 307, { location: 'https://attacker.example/release.json' })
        })
      }),
      (error) =>
        error instanceof ReleaseUploadTransportError && error.code === 'remote-verification-failed'
    )
    assert.equal(requestCount, 1)
  })

  it('creates an immutable object with signed If-None-Match and verifies exact remote bytes', async () => {
    const artifact = inlineArtifact({
      body: 'immutable bytes',
      immutable: true,
      label: 'dmg',
      objectKey: 'releases/macos/0.9.0-beta.1/Videorc.dmg'
    })
    const calls = []
    const transport = requestTransport(async (_url, init) => {
      calls.push(init)
      if (calls.length === 1) return response(null, 404)
      if (calls.length === 2) return response(null, 200)
      return response(artifact.body, 200, { etag: '"immutable-etag"' })
    })

    const result = await publishReleaseUploadArtifact({
      artifact,
      config: getReleaseUploadS3Config(env),
      transport
    })

    assert.equal(result.action, 'uploaded')
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET', 'PUT', 'GET']
    )
    assert.equal(calls[0].headers['x-amz-checksum-mode'], 'ENABLED')
    assert.match(calls[0].headers.Authorization, /x-amz-checksum-mode/)
    const put = calls[1]
    assert.equal(put.headers['if-none-match'], '*')
    assert.equal(put.headers['X-Amz-Content-Sha256'], artifact.sha256)
    assert.equal(put.headers['X-Amz-Checksum-Sha256'], sha256Base64FromHex(artifact.sha256))
    assert.match(
      put.headers.Authorization,
      /SignedHeaders=host;if-none-match;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date;x-amz-meta-videorc-sha256/
    )
  })

  it('reuses an existing immutable object only after exact size/hash verification', async () => {
    const artifact = inlineArtifact({
      body: 'immutable bytes',
      immutable: true,
      label: 'manifest',
      objectKey: 'releases/macos/0.9.0-beta.1/release.json'
    })
    let calls = 0
    const reused = await publishReleaseUploadArtifact({
      artifact,
      config: getReleaseUploadS3Config(env),
      transport: requestTransport(async () => {
        calls += 1
        return response(artifact.body, 200, { etag: '"same"' })
      })
    })
    assert.equal(reused.action, 'reused')
    assert.equal(calls, 1)

    await assert.rejects(
      publishReleaseUploadArtifact({
        artifact,
        config: getReleaseUploadS3Config(env),
        transport: requestTransport(async () =>
          response('different bytes', 200, { etag: '"different"' })
        )
      }),
      (error) =>
        error instanceof ReleaseUploadTransportError &&
        error.code === 'immutable-artifact-collision'
    )
  })

  it('accepts an immutable create race only when the winner stored exact bytes', async () => {
    const artifact = inlineArtifact({
      body: 'immutable bytes',
      immutable: true,
      label: 'feed-zip',
      objectKey: 'updates/macos/Videorc-0.9.0.zip'
    })
    const responses = [response(null, 404), response(null, 412), response(artifact.body)]

    const result = await publishReleaseUploadArtifact({
      artifact,
      config: getReleaseUploadS3Config(env),
      transport: requestTransport(async () => responses.shift())
    })

    assert.equal(result.action, 'reused')
    assert.equal(responses.length, 0)
  })

  it('updates a changed stable pointer with its exact signed ETag', async () => {
    const artifact = inlineArtifact({
      body: 'new pointer body',
      immutable: false,
      label: 'latest-manifest',
      objectKey: 'releases/macos/latest/release.json'
    })
    const calls = []
    const transport = requestTransport(async (_url, init) => {
      calls.push(init)
      if (calls.length === 1) return response('old pointer body', 200, { etag: '"old-etag"' })
      if (calls.length === 2) return response(null, 200)
      return response(artifact.body, 200, { etag: '"new-etag"' })
    })

    const result = await publishReleaseUploadArtifact({
      artifact,
      config: getReleaseUploadS3Config(env),
      transport
    })

    assert.equal(result.action, 'uploaded')
    assert.equal(calls[1].headers['if-match'], '"old-etag"')
    assert.match(calls[1].headers.Authorization, /SignedHeaders=host;if-match;/)
  })

  it('skips an already-identical pointer and creates a missing pointer conditionally', async () => {
    const artifact = inlineArtifact({
      body: 'pointer body',
      immutable: false,
      label: 'feed-manifest',
      objectKey: 'updates/macos/latest-mac.yml'
    })
    let identicalCalls = 0
    const identical = await publishReleaseUploadArtifact({
      artifact,
      config: getReleaseUploadS3Config(env),
      transport: requestTransport(async () => {
        identicalCalls += 1
        return response(artifact.body, 200, { etag: '"same"' })
      })
    })
    assert.equal(identical.action, 'skipped')
    assert.equal(identicalCalls, 1)

    assert.deepEqual(buildReleasePutCondition({ artifact, current: { state: 'missing' } }), {
      'if-none-match': '*'
    })

    const missingCalls = []
    await publishReleaseUploadArtifact({
      artifact,
      config: getReleaseUploadS3Config(env),
      transport: requestTransport(async (_url, init) => {
        missingCalls.push(init)
        if (missingCalls.length === 1) return response(null, 404)
        if (missingCalls.length === 2) return response(null, 200)
        return response(artifact.body, 200, { etag: '"created"' })
      })
    })
    assert.equal(missingCalls[1].headers['if-none-match'], '*')
    assert.match(missingCalls[1].headers.Authorization, /SignedHeaders=host;if-none-match;/)
  })
})

describe('first accepted D3 publication reservation', () => {
  it('binds exact-promotion routes to the sealed release.json object key', () => {
    const input = reservationInput({ includeChangelog: true })
    const releaseManifest = exactPromotionReleaseManifest()

    assert.doesNotThrow(() =>
      assertMacosD3ExactPromotionUploadRoutes({
        artifacts: input.artifacts,
        prefix: input.prefix,
        releaseManifest
      })
    )

    for (const mutate of [
      (routes) => ({ ...routes, prefix: 'attacker/releases' }),
      (routes) => ({
        ...routes,
        artifacts: routes.artifacts.map((artifact) =>
          artifact.label === 'dmg'
            ? { ...artifact, objectKey: 'attacker/Videorc-0.9.0.dmg' }
            : artifact
        )
      }),
      (routes) => ({
        ...routes,
        artifacts: routes.artifacts.map((artifact) =>
          artifact.label === 'feed-manifest'
            ? { ...artifact, objectKey: 'attacker/latest-mac.yml' }
            : artifact
        )
      })
    ]) {
      assert.throws(
        () =>
          assertMacosD3ExactPromotionUploadRoutes(
            mutate({ artifacts: input.artifacts, prefix: input.prefix, releaseManifest })
          ),
        (error) =>
          error instanceof ReleaseUploadConfigError &&
          error.code === 'exact-promotion-route-mismatch'
      )
    }
  })

  it('adopts the exact stable reservation from a fresh run after a pointer failure', async () => {
    const releaseManifest = exactPromotionReleaseManifest()
    const firstGeneratedAt = exactMacosPromotionChangelogGeneratedAt(releaseManifest)
    const firstInput = reservationInput({
      changelogGeneratedAt: firstGeneratedAt,
      includeChangelog: true
    })
    const firstReservation = buildMacosD3PublicationReservation(firstInput)
    const storage = reservationStorageTransport(firstInput.config)
    let failFirstPointer = true
    const publishArtifactImpl = async (params) => {
      const { artifact } = params
      if (artifact.label === 'd3-publication-reservation') {
        return await publishReleaseUploadArtifact({ ...params, transport: storage })
      }
      if (!artifact.immutable && failFirstPointer) {
        failFirstPointer = false
        throw new Error('simulated failure after reservation')
      }
      return {
        action: 'uploaded',
        verification: { state: 'identical' }
      }
    }

    await assert.rejects(
      publishReleaseUploadPhases({
        artifacts: firstInput.artifacts,
        config: firstInput.config,
        publishArtifactImpl,
        reservationArtifactFactory: async () => firstReservation.artifact
      }),
      /simulated failure after reservation/
    )

    const retryGeneratedAt = exactMacosPromotionChangelogGeneratedAt(releaseManifest)
    const retryInput = reservationInput({
      changelogGeneratedAt: retryGeneratedAt,
      includeChangelog: true,
      runId: '987654'
    })
    const retryReservation = buildMacosD3PublicationReservation(retryInput)
    const retryResults = await publishReleaseUploadPhases({
      artifacts: retryInput.artifacts,
      config: retryInput.config,
      publishArtifactImpl,
      reservationArtifactFactory: async () => retryReservation.artifact
    })

    assert.equal(firstGeneratedAt, retryGeneratedAt)
    assert.notEqual(firstReservation.artifact.sha256, retryReservation.artifact.sha256)
    assert.equal(
      retryReservation.document.release.artifacts.some(
        (artifact) => artifact.label === 'changelog'
      ),
      true
    )
    const adopted = retryResults.find((entry) => entry.phase === 'reservation')
    assert.equal(adopted?.result.action, 'adopted')
    assert.equal(adopted?.artifact.sha256, firstReservation.artifact.sha256)
    assert.equal(adopted?.result.reservationDocument.workflow.runId, '12345')
    assert.equal(adopted?.result.publisherWorkflow.runId, '987654')
    assert.equal(storage.objects.size, 1)
  })

  it('is deterministic, version-scoped, and binds the official workflow and destination', () => {
    const input = reservationInput()
    const first = buildMacosD3PublicationReservation(input)
    const reordered = buildMacosD3PublicationReservation({
      ...input,
      artifacts: [...input.artifacts].reverse()
    })

    assert.equal(first.artifact.immutable, true)
    assert.equal(
      first.artifact.objectKey,
      'releases/macos/0.9.0-beta.1/capture-decay-d3-publication-reservation.json'
    )
    assert.equal(first.artifact.body.toString(), reordered.artifact.body.toString())
    assert.equal(first.artifact.sha256, reordered.artifact.sha256)
    assert.deepEqual(first.document.workflow, {
      repository: MACOS_RELEASE_REPOSITORY,
      path: MACOS_D3_PROMOTION_WORKFLOW_PATH,
      runId: '12345',
      sourceCommit: 'b'.repeat(40)
    })
    assert.deepEqual(first.document.destination, {
      bucket: 'videorc-downloads',
      endpointUrl: 'https://r2.example.test/',
      forcePathStyle: true,
      region: 'auto',
      releasePrefix: 'releases/macos/0.9.0-beta.1',
      reservationObjectKey:
        'releases/macos/0.9.0-beta.1/capture-decay-d3-publication-reservation.json',
      tlsPolicy: {
        allowedIssuerOrganizations: ['Test Issuer'],
        allowedSpkiSha256: []
      }
    })
    assert.equal(first.document.schemaVersion, 3)
    assert.equal(first.document.profile, MACOS_D3_PUBLICATION_RESERVATION_PROFILE)

    const changedTlsPolicy = buildMacosD3PublicationReservation({
      ...input,
      config: {
        ...input.config,
        tlsPolicy: {
          allowedIssuerOrganizations: ['Different Issuer'],
          allowedSpkiSha256: []
        }
      }
    })
    assert.notEqual(changedTlsPolicy.artifact.sha256, first.artifact.sha256)
  })

  it('is reserved after verified immutables and before verified stable pointers', async () => {
    const input = reservationInput()
    const reservation = buildMacosD3PublicationReservation(input)
    const events = []

    await publishReleaseUploadPhases({
      artifacts: input.artifacts,
      config: input.config,
      onPublished: ({ artifact }) => events.push(`verified:${artifact.label}`),
      publishArtifactImpl: async ({ artifact }) => {
        events.push(`publish:${artifact.label}`)
        return { action: 'uploaded', verification: { state: 'identical' } }
      },
      reservationArtifactFactory: async () => {
        events.push('reserve')
        return reservation.artifact
      }
    })
    events.push('receipt')

    assert.deepEqual(events, [
      'publish:dmg',
      'verified:dmg',
      'publish:sha256',
      'verified:sha256',
      'publish:manifest',
      'verified:manifest',
      'publish:feed-zip',
      'verified:feed-zip',
      'publish:feed-blockmap',
      'verified:feed-blockmap',
      'reserve',
      'publish:d3-publication-reservation',
      'verified:d3-publication-reservation',
      'publish:latest-manifest',
      'verified:latest-manifest',
      'publish:feed-manifest',
      'verified:feed-manifest',
      'receipt'
    ])
  })

  it('preserves the creator run while allowing a fresh publisher run and rejects stable drift', async () => {
    const first = buildMacosD3PublicationReservation(reservationInput())
    const otherRun = buildMacosD3PublicationReservation(reservationInput({ runId: '12346' }))
    const config = getReleaseUploadS3Config(env)

    const resumed = await publishReleaseUploadArtifact({
      artifact: first.artifact,
      config,
      transport: requestTransport(async () => artifactResponse(first.artifact))
    })
    assert.equal(resumed.action, 'reused')

    const adopted = await publishReleaseUploadArtifact({
      artifact: otherRun.artifact,
      config,
      transport: requestTransport(async () => artifactResponse(first.artifact))
    })
    assert.equal(adopted.action, 'adopted')
    assert.equal(adopted.publishedArtifact.sha256, first.artifact.sha256)
    assert.equal(adopted.reservationDocument.workflow.runId, '12345')
    assert.equal(adopted.publisherWorkflow.runId, '12346')

    for (const driftedInput of [
      { ...reservationInput({ runId: '12346' }), acceptedRecordSha256: 'e'.repeat(64) },
      { ...reservationInput({ runId: '12346' }), publicationSourceCommit: 'e'.repeat(40) },
      {
        ...reservationInput({ runId: '12346' }),
        config: {
          ...config,
          tlsPolicy: {
            allowedIssuerOrganizations: ['Different Issuer'],
            allowedSpkiSha256: []
          }
        }
      }
    ]) {
      const drifted = buildMacosD3PublicationReservation(driftedInput)
      await assert.rejects(
        publishReleaseUploadArtifact({
          artifact: drifted.artifact,
          config: driftedInput.config,
          transport: requestTransport(async () => artifactResponse(first.artifact))
        }),
        (error) =>
          error instanceof ReleaseUploadTransportError &&
          error.code === 'immutable-artifact-collision'
      )
    }
  })

  it('rejects any repository or workflow path other than the pinned promotion workflow', () => {
    for (const workflow of [
      {
        path: MACOS_D3_PROMOTION_WORKFLOW_PATH,
        repository: 'fork/videorc',
        runId: '12345'
      },
      {
        path: '.github/workflows/other.yml',
        repository: MACOS_RELEASE_REPOSITORY,
        runId: '12345'
      }
    ]) {
      assert.throws(
        () => buildMacosD3PublicationReservation({ ...reservationInput(), workflow }),
        ReleaseUploadConfigError
      )
    }
  })

  it('rejects a dot component in the reservation prefix itself', () => {
    assert.throws(
      () => buildMacosD3PublicationReservation({ ...reservationInput(), prefix: '.' }),
      (error) =>
        error instanceof ReleaseUploadConfigError && error.code === 'invalid-upload-object-key'
    )
  })

  it('re-verifies the complete artifact and reservation set before receipt evidence', async () => {
    const input = reservationInput({ includeChangelog: true })
    const reservation = buildMacosD3PublicationReservation(input)
    const results = await publishReleaseUploadPhases({
      artifacts: input.artifacts,
      config: input.config,
      publishArtifactImpl: async () => ({
        action: 'uploaded',
        verification: { state: 'identical' }
      }),
      reservationArtifactFactory: async () => reservation.artifact
    })
    const remoteArtifacts = new Map(
      [...input.artifacts, reservation.artifact].map((artifact) => {
        const body = Buffer.from(artifact.body ?? Buffer.from(artifact.label))
        return [
          artifact.objectKey,
          { ...artifact, body, sha256: sha256(body), sizeBytes: body.byteLength }
        ]
      })
    )
    const mutatedBody = Buffer.from('mutated after first verification')
    remoteArtifacts.set(input.artifacts[0].objectKey, {
      ...input.artifacts[0],
      body: mutatedBody,
      sha256: sha256(mutatedBody),
      sizeBytes: mutatedBody.byteLength
    })

    await assert.rejects(
      reverifyReleaseUploadPublication({
        artifacts: input.artifacts,
        config: input.config,
        publicationResults: results,
        reservationArtifact: reservation.artifact,
        transport: objectMapTransport(remoteArtifacts, input.config)
      }),
      (error) =>
        error instanceof ReleaseUploadTransportError && error.code === 'remote-artifact-mismatch'
    )

    const incomplete = results.filter((entry) => entry.artifact.label !== 'changelog')
    await assert.rejects(
      reverifyReleaseUploadPublication({
        artifacts: input.artifacts,
        config: input.config,
        publicationResults: incomplete,
        reservationArtifact: reservation.artifact,
        transport: objectMapTransport(remoteArtifacts, input.config)
      }),
      (error) =>
        error instanceof ReleaseUploadConfigError && error.code === 'incomplete-publication-results'
    )
  })
})

describe('S3 credential validation', () => {
  const base = {
    VIDEORC_RELEASE_UPLOAD_S3_BUCKET: 'videorc-releases',
    VIDEORC_RELEASE_UPLOAD_S3_REGION: 'auto',
    VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com'
  }

  it('accepts a clean credential pair', () => {
    const config = getReleaseUploadS3Config({
      ...base,
      VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'a'.repeat(32),
      VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'b'.repeat(64)
    })
    assert.equal(config.accessKeyId, 'a'.repeat(32))
  })

  it('rejects a credential carrying a trailing .env comment, naming the variable', () => {
    // The exact shape that reached production: value + " # rotated — <date>".
    assert.throws(
      () =>
        getReleaseUploadS3Config({
          ...base,
          VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: `${'a'.repeat(32)} # rotated — 2026-08-01`,
          VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'b'.repeat(64)
        }),
      /VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID must be a single printable ASCII token/
    )
  })

  it('rejects a secret with an embedded em dash', () => {
    assert.throws(
      () =>
        getReleaseUploadS3Config({
          ...base,
          VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'a'.repeat(32),
          VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: `${'b'.repeat(64)}—`
        }),
      /SECRET_ACCESS_KEY must be a single printable ASCII token/
    )
  })

  it('never echoes the credential value in the error', () => {
    try {
      getReleaseUploadS3Config({
        ...base,
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'SUPERSECRETVALUE — leak',
        VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'b'.repeat(64)
      })
      assert.fail('expected a config error')
    } catch (error) {
      assert.doesNotMatch(error.message, /SUPERSECRETVALUE/)
    }
  })
})

function inlineArtifact({ body, immutable, label, objectKey }) {
  const bytes = Buffer.from(body)
  return {
    body: bytes,
    contentType: 'application/octet-stream',
    immutable,
    label,
    objectKey,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength
  }
}

function reservationInput({
  changelogGeneratedAt = null,
  includeChangelog = false,
  runId = '12345'
} = {}) {
  const definitions = [
    ['dmg', true, 'releases/macos/0.9.0-beta.1/Videorc-0.9.0.dmg'],
    ['sha256', true, 'releases/macos/0.9.0-beta.1/Videorc-0.9.0.dmg.sha256'],
    ['manifest', true, 'releases/macos/0.9.0-beta.1/release.json'],
    ['feed-zip', true, 'updates/macos/Videorc-0.9.0.zip'],
    ['feed-blockmap', true, 'updates/macos/Videorc-0.9.0.zip.blockmap'],
    ['latest-manifest', false, 'releases/macos/latest/release.json'],
    ['feed-manifest', false, 'updates/macos/latest-mac.yml']
  ]
  const artifacts = definitions.map(([label, immutable, objectKey]) =>
    inlineArtifact({ body: label, immutable, label, objectKey })
  )
  if (includeChangelog) {
    artifacts.push(
      inlineArtifact({
        body: `${JSON.stringify({ entries: [], generatedAt: changelogGeneratedAt, schemaVersion: 1 })}\n`,
        immutable: false,
        label: 'changelog',
        objectKey: 'changelog/changelog.json'
      })
    )
  }
  return {
    acceptedRecordSha256: 'a'.repeat(64),
    artifacts,
    config: getReleaseUploadS3Config(env),
    manifestSha256: artifacts.find((artifact) => artifact.label === 'manifest').sha256,
    prefix: 'releases/macos/0.9.0-beta.1',
    publicationSourceCommit: 'b'.repeat(40),
    releaseId: '0.9.0-beta.1',
    sealedCandidateArtifactSetSha256: 'c'.repeat(64),
    sealedCandidateManifestSha256: 'd'.repeat(64),
    workflow: {
      path: MACOS_D3_PROMOTION_WORKFLOW_PATH,
      repository: MACOS_RELEASE_REPOSITORY,
      runId
    }
  }
}

function exactPromotionReleaseManifest() {
  return {
    filename: 'Videorc-0.9.0.dmg',
    objectKey: 'releases/macos/0.9.0-beta.1/Videorc-0.9.0.dmg',
    releasedAt: '2026-08-28T12:34:56.000Z'
  }
}

function response(body, status = 200, headers = {}) {
  const bytes = body === null ? null : Buffer.from(body)
  const digest = bytes === null ? null : sha256(bytes)
  return new Response(bytes, {
    headers: {
      ...(bytes === null
        ? {}
        : {
            'content-length': String(bytes.byteLength),
            'content-type': 'application/octet-stream',
            'x-amz-checksum-sha256': sha256Base64FromHex(digest),
            'x-amz-meta-videorc-sha256': digest
          }),
      ...headers
    },
    status
  })
}

function artifactResponse(artifact, headers = {}) {
  return response(artifact.body, 200, {
    'content-length': String(artifact.sizeBytes),
    'content-type': artifact.contentType,
    etag: '"reservation"',
    'x-amz-checksum-sha256': sha256Base64FromHex(artifact.sha256),
    'x-amz-meta-videorc-sha256': artifact.sha256,
    ...headers
  })
}

function rawResponse(body, artifact, headers = {}) {
  return {
    body,
    headers: new Headers({
      'content-length': String(artifact.sizeBytes),
      'content-type': artifact.contentType,
      etag: '"stream"',
      'x-amz-checksum-sha256': sha256Base64FromHex(artifact.sha256),
      'x-amz-meta-videorc-sha256': artifact.sha256,
      ...headers
    }),
    ok: true,
    status: 200
  }
}

function requestTransport(request) {
  return { close() {}, request }
}

function objectMapTransport(objects, config) {
  const basePathSegments = config.forcePathStyle ? [config.bucket] : []
  return requestTransport(async (requestUrl) => {
    const pathSegments = new URL(requestUrl).pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    const objectKey = pathSegments.slice(basePathSegments.length).join('/')
    const artifact = objects.get(objectKey)
    return artifact === undefined
      ? response(null, 404)
      : artifactResponse(artifact, { etag: '"current"' })
  })
}

function reservationStorageTransport(config) {
  const objects = new Map()
  return {
    objects,
    close() {},
    async request(requestUrl, init) {
      const objectKey = requestObjectKey(requestUrl, config)
      if (init.method === 'GET') {
        const artifact = objects.get(objectKey)
        return artifact ? artifactResponse(artifact) : response(null, 404)
      }
      assert.equal(init.method, 'PUT')
      const body = Buffer.from(init.body)
      objects.set(objectKey, {
        body,
        contentType: init.headers['Content-Type'],
        immutable: true,
        label: 'd3-publication-reservation',
        objectKey,
        sha256: sha256(body),
        sizeBytes: body.byteLength
      })
      return response(null, 200)
    }
  }
}

function requestObjectKey(requestUrl, config) {
  const basePathSegments = config.forcePathStyle ? [config.bucket] : []
  const pathSegments = new URL(requestUrl).pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
  return pathSegments.slice(basePathSegments.length).join('/')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
