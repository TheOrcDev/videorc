import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REQUIRED_CAMERA_PROFILE_ENV_VARS,
  REQUIRED_RELEASE_ENV_VARS,
  evaluateMacosReleasePreflight,
  formatMacosReleasePreflightReport
} from './macos-release-preflight.mjs'

function completeEnv(overrides = {}) {
  return {
    APPLE_ID: 'creator@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret-apple-password',
    VIDEORC_MACOS_PROFILE_APP: 'base64-app-profile-never-printed',
    VIDEORC_MACOS_PROFILE_CAMERA: 'base64-camera-profile-never-printed',
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
  macInheritEntitlements: true,
  releaseOutputDir: true
}

// The primary signing path: electron-builder auto-detects the keychain
// "Developer ID Application" identity. dist:release bakes APPLE_TEAM_ID, so the
// ambient env never needs the certificate or team id.
const keychainSigning = { keychainIdentity: true }

describe('evaluateMacosReleasePreflight', () => {
  it('passes with keychain signing and only the notarization env vars present', () => {
    const result = evaluateMacosReleasePreflight({
      env: completeEnv(),
      tools: completeTools,
      paths: completePaths,
      signing: keychainSigning
    })

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.checks.filter((check) => !check.ok),
      []
    )
  })

  it('does not require APPLE_TEAM_ID in the ambient env (dist:release bakes it)', () => {
    const result = evaluateMacosReleasePreflight({
      env: completeEnv(),
      tools: completeTools,
      paths: completePaths,
      signing: keychainSigning
    })

    assert.equal(result.ok, true)
    assert.doesNotMatch(formatMacosReleasePreflightReport(result), /APPLE_TEAM_ID/)
  })

  it('fails with named missing prerequisites without printing secret values', () => {
    const result = evaluateMacosReleasePreflight({
      env: completeEnv({
        APPLE_ID: '',
        CSC_LINK: 'never-print-this-certificate',
        CSC_KEY_PASSWORD: 'never-print-this-password'
      }),
      tools: {
        ...completeTools,
        notarytool: false
      },
      paths: {
        ...completePaths,
        releaseOutputDir: false
      },
      signing: { keychainIdentity: false }
    })
    const report = formatMacosReleasePreflightReport(result)

    assert.equal(result.ok, false)
    assert.match(report, /macos-release-preflight: FAIL/)
    assert.match(report, /env: APPLE_ID \(missing\)/)
    assert.match(report, /tool: xcrun notarytool \(missing\)/)
    assert.match(report, /path: apps\/desktop\/release \(missing or not writable\)/)
    assert.doesNotMatch(report, /never-print-this-certificate/)
    assert.doesNotMatch(report, /never-print-this-password/)
  })

  it('requires every notarization environment variable', () => {
    for (const name of REQUIRED_RELEASE_ENV_VARS) {
      const result = evaluateMacosReleasePreflight({
        env: completeEnv({ [name]: '   ' }),
        tools: completeTools,
        paths: completePaths,
        signing: keychainSigning
      })

      assert.equal(result.ok, false, `${name} should be required`)
      assert.match(
        formatMacosReleasePreflightReport(result),
        new RegExp(`env: ${name} \\(missing\\)`)
      )
    }
  })

  it('requires both Videorc Camera provisioning profiles and points at B0 (plan 214)', () => {
    assert.deepEqual(REQUIRED_CAMERA_PROFILE_ENV_VARS, [
      'VIDEORC_MACOS_PROFILE_APP',
      'VIDEORC_MACOS_PROFILE_CAMERA'
    ])
    for (const name of REQUIRED_CAMERA_PROFILE_ENV_VARS) {
      const result = evaluateMacosReleasePreflight({
        env: completeEnv({ [name]: '' }),
        tools: completeTools,
        paths: completePaths,
        signing: keychainSigning
      })
      const report = formatMacosReleasePreflightReport(result)
      assert.equal(result.ok, false, `${name} should be required`)
      assert.match(
        report,
        new RegExp(
          `env: ${name} \\(missing: the Videorc Camera provisioning profile \\(plan 214 B0`
        )
      )
      assert.doesNotMatch(report, /never-printed/)
    }
  })

  it('requires the inherit entitlements plist beside the app plist', () => {
    const result = evaluateMacosReleasePreflight({
      env: completeEnv(),
      tools: completeTools,
      paths: { ...completePaths, macInheritEntitlements: false },
      signing: keychainSigning
    })
    assert.equal(result.ok, false)
    assert.match(
      formatMacosReleasePreflightReport(result),
      /path: apps\/desktop\/build-resources\/entitlements\.mac\.inherit\.plist \(missing or not writable\)/
    )
  })

  it('fails on non-macOS hosts', () => {
    const result = evaluateMacosReleasePreflight({
      platform: 'linux',
      env: completeEnv(),
      tools: completeTools,
      paths: completePaths,
      signing: keychainSigning
    })

    assert.equal(result.ok, false)
    assert.match(formatMacosReleasePreflightReport(result), /platform: macOS host \(got linux\)/)
  })
})

describe('evaluateMacosReleasePreflight signing', () => {
  const base = {
    env: completeEnv(),
    tools: completeTools,
    paths: completePaths
  }

  it('accepts a keychain Developer ID identity with no CSC certificate', () => {
    const result = evaluateMacosReleasePreflight({ ...base, signing: { keychainIdentity: true } })

    assert.equal(result.ok, true)
    assert.match(
      formatMacosReleasePreflightReport(result),
      /signing: Developer ID Application \(keychain identity\)/
    )
  })

  it('accepts a CSC_LINK certificate when no keychain identity is present', () => {
    const result = evaluateMacosReleasePreflight({
      ...base,
      env: completeEnv({ CSC_LINK: 'cert', CSC_KEY_PASSWORD: 'pw' }),
      signing: { keychainIdentity: false }
    })

    assert.equal(result.ok, true)
    assert.match(
      formatMacosReleasePreflightReport(result),
      /signing: Developer ID Application \(CSC_LINK certificate\)/
    )
  })

  it('requires the CSC key password alongside CSC_LINK', () => {
    const result = evaluateMacosReleasePreflight({
      ...base,
      env: completeEnv({ CSC_LINK: 'cert' }),
      signing: { keychainIdentity: false }
    })

    assert.equal(result.ok, false)
  })

  it('fails when neither a keychain identity nor a CSC certificate is available', () => {
    const result = evaluateMacosReleasePreflight({ ...base, signing: { keychainIdentity: false } })

    assert.equal(result.ok, false)
    assert.match(
      formatMacosReleasePreflightReport(result),
      /signing: Developer ID Application \(no keychain identity and no CSC_LINK certificate\)/
    )
  })
})
