import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONDITIONAL_MACOS_RELEASE_GITHUB_SECRETS,
  evaluateMacosReleaseGithubSecrets,
  formatMacosReleaseGithubSecretsReport,
  REQUIRED_MACOS_RELEASE_GITHUB_SECRETS
} from './github-release-secrets.mjs'

describe('evaluateMacosReleaseGithubSecrets', () => {
  it('passes when every required macOS release secret is installed', () => {
    const result = evaluateMacosReleaseGithubSecrets({
      presentSecretNames: REQUIRED_MACOS_RELEASE_GITHUB_SECRETS.map((secret) => secret.name)
    })

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.checks.filter((check) => check.required && !check.ok),
      []
    )
  })

  it('fails closed for missing signing, notarization, and storage secrets', () => {
    const result = evaluateMacosReleaseGithubSecrets({
      presentSecretNames: ['CSC_LINK', 'APPLE_ID', 'VIDEORC_DOWNLOAD_S3_BUCKET']
    })
    const report = formatMacosReleaseGithubSecretsReport(result, {
      repo: 'TheOrcDev/videorc'
    })

    assert.equal(result.ok, false)
    assert.match(report, /macos-release-github-secrets: FAIL/)
    assert.match(report, /repo: TheOrcDev\/videorc/)
    assert.match(report, /required: CSC_KEY_PASSWORD/)
    assert.match(report, /required: APPLE_APP_SPECIFIC_PASSWORD/)
    assert.match(report, /required: VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY/)
  })

  it('does not require conditional endpoint/session-token secrets for AWS S3', () => {
    const result = evaluateMacosReleaseGithubSecrets({
      presentSecretNames: REQUIRED_MACOS_RELEASE_GITHUB_SECRETS.map((secret) => secret.name)
    })
    const conditionalChecks = result.checks.filter((check) => !check.required)

    assert.equal(result.ok, true)
    assert.equal(conditionalChecks.length, CONDITIONAL_MACOS_RELEASE_GITHUB_SECRETS.length)
    assert.ok(conditionalChecks.every((check) => !check.ok))
  })

  it('normalizes blank and duplicate secret names without exposing values', () => {
    const result = evaluateMacosReleaseGithubSecrets({
      presentSecretNames: [
        ' CSC_LINK ',
        'CSC_LINK',
        '',
        'not-a-secret-value',
        ...REQUIRED_MACOS_RELEASE_GITHUB_SECRETS.slice(1).map((secret) => secret.name)
      ]
    })
    const report = formatMacosReleaseGithubSecretsReport(result)

    assert.equal(result.ok, true)
    assert.doesNotMatch(report, /not-a-secret-value/)
  })
})
