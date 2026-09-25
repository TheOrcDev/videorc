import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateLinuxReleasePreflight,
  formatLinuxReleasePreflightReport,
  missingLinuxReleaseUploadEnv
} from './linux-release-preflight.mjs'

const completeEnv = {
  VIDEORC_RELEASE_ID: '0.10.0-alpha.1',
  VIDEORC_LINUX_RELEASE_STAGE: 'candidate'
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
})
