import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REQUIRED_RELEASE_ENV_VARS,
  evaluateMacosReleasePreflight,
  formatMacosReleasePreflightReport
} from './macos-release-preflight.mjs'

function completeEnv(overrides = {}) {
  return {
    CSC_LINK: 'secret-certificate-link',
    CSC_KEY_PASSWORD: 'secret-cert-password',
    APPLE_ID: 'creator@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret-apple-password',
    APPLE_TEAM_ID: 'TEAMID1234',
    ...overrides
  }
}

const completeTools = {
  codesign: true,
  spctl: true,
  notarytool: true,
  stapler: true
}

const completePaths = {
  macEntitlements: true,
  releaseOutputDir: true
}

describe('evaluateMacosReleasePreflight', () => {
  it('passes when every macOS release prerequisite is present', () => {
    const result = evaluateMacosReleasePreflight({
      env: completeEnv(),
      tools: completeTools,
      paths: completePaths
    })

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.checks.filter((check) => !check.ok),
      []
    )
  })

  it('fails with named missing prerequisites without printing secret values', () => {
    const env = completeEnv({
      APPLE_ID: '',
      CSC_LINK: 'never-print-this-certificate'
    })
    const result = evaluateMacosReleasePreflight({
      env,
      tools: {
        ...completeTools,
        notarytool: false
      },
      paths: {
        ...completePaths,
        releaseOutputDir: false
      }
    })
    const report = formatMacosReleasePreflightReport(result)

    assert.equal(result.ok, false)
    assert.match(report, /macos-release-preflight: FAIL/)
    assert.match(report, /env: APPLE_ID \(missing\)/)
    assert.match(report, /tool: xcrun notarytool \(missing\)/)
    assert.match(report, /path: apps\/desktop\/release \(missing or not writable\)/)
    assert.doesNotMatch(report, /never-print-this-certificate/)
  })

  it('requires every signing and notarization environment variable', () => {
    for (const name of REQUIRED_RELEASE_ENV_VARS) {
      const result = evaluateMacosReleasePreflight({
        env: completeEnv({ [name]: '   ' }),
        tools: completeTools,
        paths: completePaths
      })

      assert.equal(result.ok, false, `${name} should be required`)
      assert.match(
        formatMacosReleasePreflightReport(result),
        new RegExp(`env: ${name} \\(missing\\)`)
      )
    }
  })

  it('fails on non-macOS hosts', () => {
    const result = evaluateMacosReleasePreflight({
      platform: 'linux',
      env: completeEnv(),
      tools: completeTools,
      paths: completePaths
    })

    assert.equal(result.ok, false)
    assert.match(formatMacosReleasePreflightReport(result), /platform: macOS host \(got linux\)/)
  })
})
