import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateWindowsReleasePreflight,
  formatWindowsReleasePreflightReport,
  missingWindowsReleaseSigningEnv,
  WINDOWS_RELEASE_SIGNING_ENV
} from './windows-release-preflight.mjs'

const completeEnv = Object.fromEntries(
  WINDOWS_RELEASE_SIGNING_ENV.map((name) => [name, `${name.toLowerCase()}-value`])
)
completeEnv.VIDEORC_RELEASE_ID = '0.10.0-alpha.1'
completeEnv.VIDEORC_WINDOWS_SIGNING_ENDPOINT = 'https://weu.codesigning.azure.net'

function facts(overrides = {}) {
  return {
    arch: 'x64',
    changelogEntrySupportsWindows: true,
    env: completeEnv,
    gitClean: true,
    packageVersion: '0.10.0',
    paths: {
      ffmpegPin: true,
      ffmpegPolicy: true,
      icon: true,
      releaseOutputDir: true
    },
    platform: 'win32',
    tools: { cargo: true, git: true, pnpm: true, powershell: true },
    ...overrides
  }
}

describe('Windows release preflight', () => {
  it('passes only a clean, fully configured Windows x64 release checkout', () => {
    const result = evaluateWindowsReleasePreflight(facts())
    assert.equal(result.ok, true)
    assert.match(formatWindowsReleasePreflightReport(result), /^windows-release-preflight: PASS/)
  })

  it('fails closed for a non-Windows host, dirty tree, or stale release id', () => {
    for (const override of [
      { platform: 'darwin' },
      { gitClean: false },
      { env: { ...completeEnv, VIDEORC_RELEASE_ID: '0.9.9-alpha.1' } },
      { changelogEntrySupportsWindows: false }
    ]) {
      const result = evaluateWindowsReleasePreflight(facts(override))
      assert.equal(result.ok, false)
      assert.ok(result.failures.length >= 1)
    }
  })

  it('reports every missing signing value without printing secret values', () => {
    const env = {
      ...completeEnv,
      VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME: '',
      VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME: undefined
    }
    assert.deepEqual(missingWindowsReleaseSigningEnv(env), [
      'VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME',
      'VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME'
    ])

    assert.equal(missingWindowsReleaseSigningEnv(env).length, 2)
    assert.deepEqual(
      missingWindowsReleaseSigningEnv({
        ...completeEnv,
        VIDEORC_WINDOWS_SIGNING_ENDPOINT: 'https://attacker.example.test'
      }),
      ['VIDEORC_WINDOWS_SIGNING_ENDPOINT']
    )
  })

  it('rejects long-lived Azure, certificate, and username-password credentials', () => {
    for (const name of [
      'AZURE_CLIENT_SECRET',
      'AZURE_CLIENT_CERTIFICATE_PATH',
      'AZURE_USERNAME',
      'AZURE_PASSWORD',
      'WIN_CSC_LINK'
    ]) {
      const result = evaluateWindowsReleasePreflight(
        facts({ env: { ...completeEnv, [name]: 'forbidden-value' } })
      )
      assert.equal(result.ok, false)
      assert.match(formatWindowsReleasePreflightReport(result), new RegExp(`${name} absent`))
      assert.equal(formatWindowsReleasePreflightReport(result).includes('forbidden-value'), false)
    }
  })
})
