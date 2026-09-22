import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  assertNoReleaseOriginPending,
  clearReleaseOriginPending,
  planReleaseUploadOrigins,
  probeReleaseUploadOrigin,
  readReleaseOriginPending,
  resolveReleaseUploadOrigins,
  writeReleaseOriginPending
} from './release-upload-origins.mjs'
import {
  buildReleasePutCondition,
  getReleaseUploadS3Config,
  inspectReleaseUploadArtifact,
  ReleaseUploadConfigError,
  releaseUploadOriginCapabilities,
  sha256Base64FromHex
} from './release-upload-s3.mjs'
import { isImmutableReleaseObjectKey } from '../sync-release-origins.mjs'

const r2Env = {
  VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID: 'R2KEY',
  VIDEORC_DOWNLOAD_S3_BUCKET: 'videorc-releases',
  VIDEORC_DOWNLOAD_S3_ENDPOINT_URL: 'https://account.r2.cloudflarestorage.com',
  VIDEORC_DOWNLOAD_S3_REGION: 'auto',
  VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY: 'r2-secret'
}
const hetznerEnv = {
  VIDEORC_RELEASE_UPLOAD_HETZNER_S3_ACCESS_KEY_ID: 'HZKEY',
  VIDEORC_RELEASE_UPLOAD_HETZNER_S3_BUCKET: 'videorc-releases',
  VIDEORC_RELEASE_UPLOAD_HETZNER_S3_ENDPOINT_URL: 'https://fsn1.your-objectstorage.com',
  VIDEORC_RELEASE_UPLOAD_HETZNER_S3_REGION: 'eu-central',
  VIDEORC_RELEASE_UPLOAD_HETZNER_S3_SECRET_ACCESS_KEY: 'hz-secret'
}
const bothEnv = { ...r2Env, ...hetznerEnv }
const neonEnv = {
  VIDEORC_RELEASE_UPLOAD_NEON_S3_ACCESS_KEY_ID: 'NEONKEY',
  VIDEORC_RELEASE_UPLOAD_NEON_S3_BUCKET: 'videorc-releases',
  VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL:
    'https://br-quiet-lake-a1b2c3d4.storage.c-2.eu-central-1.aws.neon.tech',
  VIDEORC_RELEASE_UPLOAD_NEON_S3_FORCE_PATH_STYLE: 'true',
  VIDEORC_RELEASE_UPLOAD_NEON_S3_REGION: 'eu-central-1',
  VIDEORC_RELEASE_UPLOAD_NEON_S3_SECRET_ACCESS_KEY: 'neon-secret'
}
const allEnv = { ...bothEnv, ...neonEnv }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hetznerConfig() {
  return resolveReleaseUploadOrigins(bothEnv).origins.find(({ name }) => name === 'hetzner').config
}

describe('release origin capabilities', () => {
  it('knows the measured Hetzner differences and leaves every other origin on S3 defaults', () => {
    assert.deepEqual(releaseUploadOriginCapabilities(hetznerConfig()), {
      checksumHeaders: false,
      ifMatchEtagForm: 'unquoted'
    })
    assert.deepEqual(releaseUploadOriginCapabilities(getReleaseUploadS3Config(r2Env)), {
      checksumHeaders: true,
      ifMatchEtagForm: 'quoted'
    })
  })

  it('keeps Neon on S3 defaults until the compat probe measures otherwise', () => {
    const neon = resolveReleaseUploadOrigins({
      ...neonEnv,
      VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'neon'
    }).origins[0].config
    assert.deepEqual(releaseUploadOriginCapabilities(neon), {
      checksumHeaders: true,
      ifMatchEtagForm: 'quoted'
    })
    assert.deepEqual(neon.tlsPolicy.allowedIssuerOrganizations, ['Amazon'])
    assert.equal(neon.forcePathStyle, true)
    assert.equal(neon.region, 'eu-central-1')
  })

  it("pins Let's Encrypt for Hetzner and Google Trust Services for R2 without extra environment", () => {
    assert.deepEqual(hetznerConfig().tlsPolicy.allowedIssuerOrganizations, ["Let's Encrypt"])
    assert.deepEqual(getReleaseUploadS3Config(r2Env).tlsPolicy.allowedIssuerOrganizations, [
      'Google Trust Services'
    ])
  })

  it('sends Hetzner the bare ETag and every other origin the entity tag verbatim', () => {
    const artifact = { immutable: false, objectKey: 'updates/macos/latest-mac.yml' }
    const current = { etag: '"9b2cf535f27731c974343645a3985328"', state: 'different' }
    assert.deepEqual(
      buildReleasePutCondition({
        artifact,
        capabilities: releaseUploadOriginCapabilities(hetznerConfig()),
        current
      }),
      { 'if-match': '9b2cf535f27731c974343645a3985328' }
    )
    assert.deepEqual(buildReleasePutCondition({ artifact, current }), {
      'if-match': '"9b2cf535f27731c974343645a3985328"'
    })
  })

  it('accepts a missing checksum header only where the origin cannot return one', async () => {
    const body = Buffer.from('release bytes')
    const artifact = {
      contentType: 'application/octet-stream',
      immutable: true,
      label: 'dmg',
      objectKey: 'releases/macos/0.9.97-beta.1/Videorc.dmg',
      sha256: sha256(body),
      sizeBytes: body.byteLength
    }
    const respond = (extraHeaders) => ({
      close() {},
      request: async () =>
        new Response(body, {
          headers: {
            'content-length': String(body.byteLength),
            'content-type': 'application/octet-stream',
            'x-amz-meta-videorc-sha256': artifact.sha256,
            ...extraHeaders
          },
          status: 200
        })
    })
    const inspect = (config, extraHeaders = {}) =>
      inspectReleaseUploadArtifact({ artifact, config, transport: respond(extraHeaders) })
    const correct = { 'x-amz-checksum-sha256': sha256Base64FromHex(artifact.sha256) }
    const wrong = { 'x-amz-checksum-sha256': sha256Base64FromHex('0'.repeat(64)) }

    assert.equal((await inspect(hetznerConfig())).state, 'identical')
    assert.equal((await inspect(hetznerConfig(), correct)).state, 'identical')
    assert.equal((await inspect(hetznerConfig(), wrong)).state, 'different')
    assert.equal((await inspect(getReleaseUploadS3Config(r2Env))).state, 'different')
    assert.equal((await inspect(getReleaseUploadS3Config(r2Env), correct)).state, 'identical')
  })
})

describe('release origin resolution', () => {
  it('is the historical single origin when nothing else is configured', () => {
    const { origins, primaryName } = resolveReleaseUploadOrigins(r2Env)
    assert.equal(primaryName, 'r2')
    assert.deepEqual(
      origins.map(({ name }) => name),
      ['r2']
    )
  })

  it('orders mirrors first and the primary last', () => {
    assert.deepEqual(
      resolveReleaseUploadOrigins(bothEnv).origins.map(({ name }) => name),
      ['hetzner', 'r2']
    )
    assert.deepEqual(
      resolveReleaseUploadOrigins({
        ...bothEnv,
        VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'hetzner'
      }).origins.map(({ name }) => name),
      ['r2', 'hetzner']
    )
  })

  it('orders three origins mirrors first in a stable order and the primary last', () => {
    const order = (primary) =>
      resolveReleaseUploadOrigins({
        ...allEnv,
        ...(primary ? { VIDEORC_DOWNLOAD_STORAGE_PRIMARY: primary } : {})
      }).origins.map(({ name }) => name)
    assert.deepEqual(order(null), ['hetzner', 'neon', 'r2'])
    assert.deepEqual(order('neon'), ['r2', 'hetzner', 'neon'])
    assert.deepEqual(order(' NEON '), ['r2', 'hetzner', 'neon'])
    assert.deepEqual(order('hetzner'), ['r2', 'neon', 'hetzner'])
  })

  it('publishes to neon alone with no r2 or hetzner environment', async () => {
    const env = { ...neonEnv, VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'neon' }
    const { origins, primaryName } = resolveReleaseUploadOrigins(env)
    assert.equal(primaryName, 'neon')
    assert.deepEqual(
      origins.map(({ name }) => name),
      ['neon']
    )
    const probed = []
    const plan = await planReleaseUploadOrigins({
      env,
      probe: async ({ config }) => {
        probed.push(config.endpointUrl)
        return { reachable: true, reason: null }
      }
    })
    assert.deepEqual(probed, [neonEnv.VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL + '/'])
    assert.equal(plan.primaryName, 'neon')
    assert.equal(plan.primaryBlocked, false)
    assert.deepEqual(
      plan.reachable.map(({ name }) => name),
      ['neon']
    )
    assert.equal(plan.reachable.at(-1).config.bucket, 'videorc-releases')
  })

  it('never falls back to an unconfigured r2 when only neon is configured', () => {
    assert.throws(
      () => resolveReleaseUploadOrigins(neonEnv),
      (error) =>
        error instanceof ReleaseUploadConfigError &&
        error.code === 'primary-origin-not-configured' &&
        /VIDEORC_DOWNLOAD_STORAGE_PRIMARY is unset/.test(error.message) &&
        /configured: neon/.test(error.message)
    )
    assert.throws(
      () => resolveReleaseUploadOrigins({ ...neonEnv, VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'r2' }),
      (error) =>
        error instanceof ReleaseUploadConfigError &&
        error.code === 'primary-origin-not-configured' &&
        !/is unset/.test(error.message)
    )
    assert.throws(
      () => resolveReleaseUploadOrigins({ ...r2Env, VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'neon' }),
      (error) =>
        error instanceof ReleaseUploadConfigError && error.code === 'primary-origin-not-configured'
    )
  })

  it('refuses an unknown or unconfigured primary and two names for one bucket', () => {
    assert.throws(
      () => resolveReleaseUploadOrigins({ ...r2Env, VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'b2' }),
      ReleaseUploadConfigError
    )
    assert.throws(
      () => resolveReleaseUploadOrigins({ ...r2Env, VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'hetzner' }),
      ReleaseUploadConfigError
    )
    assert.throws(
      () =>
        resolveReleaseUploadOrigins({
          ...bothEnv,
          VIDEORC_RELEASE_UPLOAD_HETZNER_S3_ENDPOINT_URL: r2Env.VIDEORC_DOWNLOAD_S3_ENDPOINT_URL,
          VIDEORC_RELEASE_UPLOAD_HETZNER_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS: 'Any'
        }),
      ReleaseUploadConfigError
    )
  })
})

describe('release origin reachability', () => {
  const transportFactory = (request) => () => ({ close() {}, request })

  it('treats a transport failure as blocked and a rejected credential as a hard error', async () => {
    const config = hetznerConfig()
    assert.deepEqual(
      await probeReleaseUploadOrigin({
        config,
        transportFactory: transportFactory(async () => new Response(null, { status: 404 }))
      }),
      { reachable: true, reason: null }
    )
    const blocked = await probeReleaseUploadOrigin({
      config,
      transportFactory: transportFactory(async () => {
        throw Object.assign(new Error('issuer organization is not allowed: Packetland.'), {
          code: 'tls-issuer-rejected'
        })
      })
    })
    assert.equal(blocked.reachable, false)
    assert.match(blocked.reason, /tls-issuer-rejected.*Packetland/)
    await assert.rejects(
      probeReleaseUploadOrigin({
        config,
        transportFactory: transportFactory(async () => new Response(null, { status: 403 }))
      }),
      ReleaseUploadConfigError
    )
  })

  it('publishes around a blocked mirror but never silently around a blocked primary', async () => {
    const probeBlocking =
      (blockedName) =>
      async ({ config }) =>
        config.endpointUrl.includes(blockedName === 'r2' ? 'r2.cloudflarestorage' : 'objectstorage')
          ? { reachable: false, reason: 'tls-issuer-rejected: forged' }
          : { reachable: true, reason: null }

    const mirrorDown = await planReleaseUploadOrigins({
      env: bothEnv,
      probe: probeBlocking('hetzner')
    })
    assert.deepEqual(
      mirrorDown.reachable.map(({ name }) => name),
      ['r2']
    )
    assert.deepEqual(
      mirrorDown.blocked.map(({ name }) => name),
      ['hetzner']
    )
    assert.equal(mirrorDown.primaryBlocked, false)

    await assert.rejects(
      planReleaseUploadOrigins({ env: bothEnv, probe: probeBlocking('r2') }),
      (error) =>
        error instanceof ReleaseUploadConfigError &&
        error.code === 'primary-origin-blocked' &&
        /VIDEORC_DOWNLOAD_STORAGE_PRIMARY=hetzner/.test(error.message)
    )
    const mirrorOnly = await planReleaseUploadOrigins({
      allowMirrorOnly: true,
      env: bothEnv,
      probe: probeBlocking('r2')
    })
    assert.equal(mirrorOnly.primaryBlocked, true)
    assert.deepEqual(
      mirrorOnly.reachable.map(({ name }) => name),
      ['hetzner']
    )

    await assert.rejects(
      planReleaseUploadOrigins({
        env: bothEnv,
        probe: async () => ({ reachable: false, reason: 'timeout' })
      }),
      (error) => error.code === 'no-reachable-origin'
    )
  })
})

describe('pending origin records', () => {
  it('blocks the next release until the missed origin is synced', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'videorc-origin-pending-'))
    try {
      await assertNoReleaseOriginPending(repoRoot)
      const [path] = await writeReleaseOriginPending({
        artifacts: [
          {
            contentType: 'application/zip',
            immutable: false,
            label: 'feed-zip',
            objectKey: 'updates/macos/Videorc-0.9.97-mac-arm64.zip',
            path: '/private/local/path/that/must/not/be/recorded.zip',
            sha256: 'a'.repeat(64),
            sizeBytes: 150806007
          }
        ],
        blocked: [{ name: 'r2', reason: 'tls-issuer-rejected: forged' }],
        platform: 'macos',
        releaseId: '0.9.97-beta.1',
        repoRoot
      })
      const [pending] = await readReleaseOriginPending(repoRoot)
      assert.equal(pending.path, path)
      assert.equal(pending.document.origin, 'r2')
      assert.deepEqual(pending.document.artifacts, [
        {
          contentType: 'application/zip',
          immutable: false,
          label: 'feed-zip',
          objectKey: 'updates/macos/Videorc-0.9.97-mac-arm64.zip',
          sha256: 'a'.repeat(64),
          sizeBytes: 150806007
        }
      ])
      await assert.rejects(
        assertNoReleaseOriginPending(repoRoot),
        (error) =>
          error.code === 'origin-sync-pending' && /macos 0\.9\.97-beta\.1/.test(error.message)
      )
      await clearReleaseOriginPending(path)
      await assertNoReleaseOriginPending(repoRoot)
    } finally {
      await rm(repoRoot, { force: true, recursive: true })
    }
  })
})

describe('origin sync classification', () => {
  it('never overwrites versioned releases or candidates and treats everything else as a pointer', () => {
    for (const objectKey of [
      'releases/macos/0.9.97-beta.1/Videorc-0.9.97-mac-arm64.dmg',
      'releases/windows/0.9.97-alpha.1/release.json',
      'candidates/windows/0.9.97-alpha.1/abc/latest.yml'
    ]) {
      assert.equal(isImmutableReleaseObjectKey(objectKey), true, objectKey)
    }
    for (const objectKey of [
      'releases/macos/latest/release.json',
      'releases/windows/pilot/release.json',
      'updates/macos/latest-mac.yml',
      'updates/macos/Videorc-0.9.97-mac-arm64.zip',
      'changelog/changelog.json'
    ]) {
      assert.equal(isImmutableReleaseObjectKey(objectKey), false, objectKey)
    }
  })
})
