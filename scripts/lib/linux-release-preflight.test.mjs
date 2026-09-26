import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateLinuxReleasePreflight,
  formatLinuxReleasePreflightReport,
  isHttpsReleaseUploadEndpoint,
  linuxReleaseUploadEndpoint,
  missingLinuxReleaseUploadEnv
} from './linux-release-preflight.mjs'
import { RELEASE_BUNDLED_OAUTH_ENV } from './release-bundled-oauth.mjs'

const completeEnv = {
  VIDEORC_RELEASE_ID: '0.10.0-alpha.1',
  VIDEORC_LINUX_RELEASE_STAGE: 'candidate',
  ...Object.fromEntries(
    RELEASE_BUNDLED_OAUTH_ENV.map((name) => [name, `${name.toLowerCase()}-value`])
  )
}

function facts(overrides = {}) {
  return {
    arch: 'x64',
    changelogEntrySupportsLinux: true,
    env: completeEnv,
    gitClean: true,
    packageVersion: '0.10.0',
    paths: {
      ffmpegPin: true,
      ffmpegPolicy: true,
      icon: true,
      releaseOutputDir: true
    },
    platform: 'linux',
    tools: { cargo: true, git: true, pnpm: true },
    ...overrides
  }
}

describe('Linux release preflight', () => {
  it('passes only a clean Linux x64 candidate checkout', () => {
    const result = evaluateLinuxReleasePreflight(facts())
    assert.equal(result.ok, true)
    assert.match(formatLinuxReleasePreflightReport(result), /^linux-release-preflight: PASS/)
  })

  it('fails closed on each missing bundled OAuth credential', () => {
    for (const name of RELEASE_BUNDLED_OAUTH_ENV) {
      const result = evaluateLinuxReleasePreflight(facts({ env: { ...completeEnv, [name]: '' } }))
      assert.equal(result.ok, false)
      assert.deepEqual(
        result.failures.map((item) => item.id),
        [`bundled-oauth-${name}`]
      )
    }
  })

  it('fails closed for a non-Linux host, dirty tree, or stale release id', () => {
    for (const override of [
      { platform: 'darwin' },
      { gitClean: false },
      { env: { ...completeEnv, VIDEORC_RELEASE_ID: '0.9.9-alpha.1' } },
      { changelogEntrySupportsLinux: false },
      { env: { ...completeEnv, VIDEORC_LINUX_RELEASE_STAGE: 'public' } }
    ]) {
      const result = evaluateLinuxReleasePreflight(facts(override))
      assert.equal(result.ok, false)
      assert.ok(result.failures.length >= 1)
    }
  })

  it('accepts alpha.N that matches the desktop package version', () => {
    const result = evaluateLinuxReleasePreflight(
      facts({
        env: { ...completeEnv, VIDEORC_RELEASE_ID: '0.10.0-alpha.4' }
      })
    )
    assert.equal(result.ok, true)
  })

  it('reports missing upload credentials without printing secret values', () => {
    assert.deepEqual(
      missingLinuxReleaseUploadEnv({
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'id',
        VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'secret'
      }),
      [
        'VIDEORC_RELEASE_UPLOAD_S3_BUCKET',
        'VIDEORC_RELEASE_UPLOAD_S3_REGION',
        'VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL'
      ]
    )
  })

  it('accepts the legacy primary S3 slot or VIDEORC_DOWNLOAD_S3_* fallbacks', () => {
    assert.deepEqual(
      missingLinuxReleaseUploadEnv({
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'id',
        VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'secret',
        VIDEORC_RELEASE_UPLOAD_S3_BUCKET: 'releases',
        VIDEORC_RELEASE_UPLOAD_S3_REGION: 'auto',
        VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com'
      }),
      []
    )
    assert.deepEqual(
      missingLinuxReleaseUploadEnv({
        VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID: 'id',
        VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY: 'secret',
        VIDEORC_DOWNLOAD_S3_BUCKET: 'releases',
        VIDEORC_DOWNLOAD_S3_REGION: 'auto',
        VIDEORC_DOWNLOAD_S3_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com'
      }),
      []
    )
  })

  it('accepts Neon-only credentials when the primary origin is neon', () => {
    const neonOnly = {
      VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'NEON',
      VIDEORC_RELEASE_UPLOAD_NEON_S3_ACCESS_KEY_ID: 'id',
      VIDEORC_RELEASE_UPLOAD_NEON_S3_SECRET_ACCESS_KEY: 'secret',
      VIDEORC_RELEASE_UPLOAD_NEON_S3_BUCKET: 'releases',
      VIDEORC_RELEASE_UPLOAD_NEON_S3_REGION: 'eu-central-1',
      VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL:
        'https://example.storage.eu-central-1.aws.neon.tech'
    }
    assert.deepEqual(missingLinuxReleaseUploadEnv(neonOnly), [])
    assert.equal(
      linuxReleaseUploadEndpoint(neonOnly),
      'https://example.storage.eu-central-1.aws.neon.tech'
    )
    assert.equal(isHttpsReleaseUploadEndpoint(linuxReleaseUploadEndpoint(neonOnly)), true)
  })

  it('reports missing Neon upload fields without printing secret values', () => {
    assert.deepEqual(
      missingLinuxReleaseUploadEnv({
        VIDEORC_DOWNLOAD_STORAGE_PRIMARY: 'neon',
        VIDEORC_RELEASE_UPLOAD_NEON_S3_ACCESS_KEY_ID: 'id',
        VIDEORC_RELEASE_UPLOAD_NEON_S3_SECRET_ACCESS_KEY: 'secret'
      }),
      [
        'VIDEORC_RELEASE_UPLOAD_NEON_S3_BUCKET',
        'VIDEORC_RELEASE_UPLOAD_NEON_S3_REGION',
        'VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL'
      ]
    )
  })

  it('does not treat Neon credentials as complete when the primary origin is unset', () => {
    assert.deepEqual(
      missingLinuxReleaseUploadEnv({
        VIDEORC_RELEASE_UPLOAD_NEON_S3_ACCESS_KEY_ID: 'id',
        VIDEORC_RELEASE_UPLOAD_NEON_S3_SECRET_ACCESS_KEY: 'secret',
        VIDEORC_RELEASE_UPLOAD_NEON_S3_BUCKET: 'releases',
        VIDEORC_RELEASE_UPLOAD_NEON_S3_REGION: 'eu-central-1',
        VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL:
          'https://example.storage.eu-central-1.aws.neon.tech'
      }),
      [
        'VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID',
        'VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY',
        'VIDEORC_RELEASE_UPLOAD_S3_BUCKET',
        'VIDEORC_RELEASE_UPLOAD_S3_REGION',
        'VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL'
      ]
    )
  })
})
