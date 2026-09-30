import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  RELEASE_BUNDLED_OAUTH_ENV,
  releaseBundledOauthChecks
} from './release-bundled-oauth.mjs'

const completeBundledOauthEnv = Object.fromEntries(
  RELEASE_BUNDLED_OAUTH_ENV.map((name) => [name, `${name.toLowerCase()}-real-value`])
)

const workflow = (name) =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')

describe('release bundled OAuth credentials', () => {
  it('passes when every required credential is set', () => {
    const checks = releaseBundledOauthChecks(completeBundledOauthEnv)
    assert.equal(checks.length, RELEASE_BUNDLED_OAUTH_ENV.length)
    assert.ok(checks.every((check) => check.ok))
  })

  it('fails each missing, blank or template credential on its own, without its value', () => {
    const env = {
      ...completeBundledOauthEnv,
      VIDEORC_BUNDLED_TWITCH_CLIENT_ID: undefined,
      VIDEORC_BUNDLED_KICK_CLIENT_SECRET: '   ',
      VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY: 'paste-your-client-id-here',
      // An unset GitHub secret expands to "": YouTube sign-in would ship dead.
      VIDEORC_BUNDLED_YOUTUBE_CLIENT_SECRET: ''
    }
    const failed = releaseBundledOauthChecks(env).filter((check) => !check.ok)
    assert.deepEqual(
      failed.map((check) => check.id),
      [
        'bundled-oauth-VIDEORC_BUNDLED_TWITCH_CLIENT_ID',
        'bundled-oauth-VIDEORC_BUNDLED_KICK_CLIENT_SECRET',
        'bundled-oauth-VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY',
        'bundled-oauth-VIDEORC_BUNDLED_YOUTUBE_CLIENT_SECRET'
      ]
    )
    assert.match(failed[2].detail, /template text/)
    for (const check of failed) {
      assert.doesNotMatch(`${check.label} ${check.detail}`, /paste-your|real-value/)
    }
  })

  // The Windows/Linux alpha builds and the hosted macOS release compile the
  // backend in GitHub Actions. The values only reach `cargo build` if the
  // workflow maps each secret into the step that builds, and into the step
  // that runs the preflight or artifact validate.
  it('maps every credential from a repository secret into the building workflows', () => {
    const windows = workflow('release-windows-alpha.yml')
    const linux = workflow('release-linux-alpha.yml')
    const macos = workflow('release-macos.yml')
    for (const name of RELEASE_BUNDLED_OAUTH_ENV) {
      const mapping = `${name}: \${{ secrets.${name} }}`
      assert.equal(windows.split(mapping).length - 1, 1, `Windows build step maps ${name}`)
      // Linux: once for the preflight step, once for the package step.
      assert.equal(linux.split(mapping).length - 1, 2, `Linux preflight + package map ${name}`)
      // macOS: once for the signed build, once for release:validate:macos.
      assert.equal(macos.split(mapping).length - 1, 2, `macOS build + validate map ${name}`)
    }
    for (const text of [windows, linux, macos]) {
      assert.doesNotMatch(text, /VIDEORC_BUNDLED_X_CLIENT_ID/)
    }
  })
})
