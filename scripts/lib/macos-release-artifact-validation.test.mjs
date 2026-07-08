import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  artifactKindFromPath,
  buildMacosReleaseArtifactChecks,
  BUNDLED_X_OAUTH1_CONSUMER_ENVS,
  bundledXOauth1ConsumerCheckTargets,
  captureEntitlementCheckTargets,
  evaluateBinaryContainsEnvSecretCheck,
  formatArtifactPath,
  formatReleaseArtifactValidationReport,
  REQUIRED_CAPTURE_ENTITLEMENTS,
  sanitizeReleaseValidationOutput,
  selectLatestReleaseArtifacts
} from './macos-release-artifact-validation.mjs'

// relative() emits platform separators, so repo-relative path assertions must
// not hardcode '/' — these tests run on both macOS and Windows boxes.
function posixPath(value) {
  return value.replaceAll('\\', '/')
}

describe('artifactKindFromPath', () => {
  it('recognizes app bundles and DMGs only', () => {
    assert.equal(artifactKindFromPath('/tmp/Videorc.app'), 'app')
    assert.equal(artifactKindFromPath('/tmp/Videorc.dmg'), 'dmg')
    assert.equal(artifactKindFromPath('/tmp/Videorc.dmg.blockmap'), null)
  })
})

describe('buildMacosReleaseArtifactChecks', () => {
  it('uses strict app validation commands', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.app')

    assert.deepEqual(
      checks.map((check) => check.label),
      [
        'codesign verify',
        'codesign display',
        'Gatekeeper assess',
        'stapler validate',
        'capture entitlements (app)',
        'capture entitlements (videorc-backend)',
        'capture entitlements (native_preview_host_helper)',
        'capture entitlements (ffmpeg)',
        'capture entitlements (ffprobe)',
        'bundled X OAuth1 consumer key (videorc-backend)',
        'bundled X OAuth1 consumer secret (videorc-backend)'
      ]
    )
    assert.deepEqual(checks[0].args, [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '/release/Videorc.app'
    ])
    assert.deepEqual(checks[2].args, [
      '--assess',
      '--type',
      'execute',
      '--verbose',
      '/release/Videorc.app'
    ])
  })

  it('uses primary-signature assessment for DMGs', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.dmg')

    assert.deepEqual(checks[0].args, ['--verify', '--verbose=2', '/release/Videorc.dmg'])
    assert.deepEqual(checks[2].args, [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose',
      '/release/Videorc.dmg'
    ])
  })

  it('skips entitlement checks for DMGs (entitlements live in the app bundle)', () => {
    const labels = buildMacosReleaseArtifactChecks('/release/Videorc.dmg').map(
      (check) => check.label
    )
    assert.equal(
      labels.some((label) => label.startsWith('capture entitlements')),
      false
    )
  })
})

describe('capture entitlement gate', () => {
  it('requires the AV device entitlements on the app and every bundled capture tool', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.app').filter((check) =>
      check.label.startsWith('capture entitlements')
    )

    assert.deepEqual(
      checks.map((check) => check.args.at(-1)),
      [
        '/release/Videorc.app',
        '/release/Videorc.app/Contents/Resources/videorc-backend',
        '/release/Videorc.app/Contents/Resources/native_preview_host_helper',
        '/release/Videorc.app/Contents/Resources/ffmpeg/bin/ffmpeg',
        '/release/Videorc.app/Contents/Resources/ffmpeg/bin/ffprobe'
      ]
    )
    for (const check of checks) {
      assert.deepEqual(check.args.slice(0, 3), ['-d', '--entitlements', ':-'])
      assert.deepEqual(check.expectOutputIncludes, REQUIRED_CAPTURE_ENTITLEMENTS)
    }
  })

  it('fails closed when the release backend lacks the baked X OAuth1 consumer pair', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.app').filter((check) =>
      check.label.startsWith('bundled X OAuth1')
    )

    assert.deepEqual(checks, bundledXOauth1ConsumerCheckTargets('/release/Videorc.app'))
    assert.deepEqual(
      checks.map((check) => check.envName),
      BUNDLED_X_OAUTH1_CONSUMER_ENVS
    )
    for (const check of checks) {
      assert.equal(check.type, 'binary-contains-env-secret')
      assert.equal(check.command, undefined)
      assert.equal(check.path, '/release/Videorc.app/Contents/Resources/videorc-backend')
    }
  })

  it('requires the exact release-env X consumer values to be embedded', () => {
    const [keyCheck] = bundledXOauth1ConsumerCheckTargets('/release/Videorc.app')
    const secret = 'fake-x-consumer-key'

    assert.deepEqual(
      evaluateBinaryContainsEnvSecretCheck(keyCheck, {
        env: {},
        readFile: () => Buffer.from(secret)
      }),
      {
        ok: false,
        output: `missing required environment variable: ${keyCheck.envName}`
      }
    )

    assert.deepEqual(
      evaluateBinaryContainsEnvSecretCheck(keyCheck, {
        env: { [keyCheck.envName]: secret },
        readFile: () => Buffer.from('different binary contents')
      }),
      {
        ok: false,
        output:
          '/release/Videorc.app/Contents/Resources/videorc-backend does not contain the VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY value from the release environment'
      }
    )

    assert.deepEqual(
      evaluateBinaryContainsEnvSecretCheck(keyCheck, {
        env: { [keyCheck.envName]: secret },
        readFile: () => Buffer.from(`binary prefix ${secret} binary suffix`)
      }),
      { ok: true, output: '' }
    )
  })

  it('pins the required entitlements to camera + microphone', () => {
    assert.deepEqual(REQUIRED_CAPTURE_ENTITLEMENTS, [
      'com.apple.security.device.camera',
      'com.apple.security.device.audio-input'
    ])
  })

  it('targets the same tool set the signing scripts sign', () => {
    assert.deepEqual(
      captureEntitlementCheckTargets('/a/Videorc.app').map((target) => target.id),
      ['app', 'videorc-backend', 'native-preview-host-helper', 'ffmpeg', 'ffprobe']
    )
  })
})

describe('selectLatestReleaseArtifacts', () => {
  it('selects the newest app and newest DMG, ignoring unsupported files', () => {
    const selected = selectLatestReleaseArtifacts([
      { path: '/release/old/Videorc.app', mtimeMs: 10 },
      { path: '/release/new/Videorc.app', mtimeMs: 20 },
      { path: '/release/Videorc-old.dmg', mtimeMs: 15 },
      { path: '/release/Videorc-new.dmg', mtimeMs: 25 },
      { path: '/release/Videorc-new.dmg.blockmap', mtimeMs: 30 }
    ])

    assert.deepEqual(
      selected.map((artifact) => artifact.path),
      ['/release/new/Videorc.app', '/release/Videorc-new.dmg']
    )
  })
})

describe('release artifact report redaction', () => {
  it('formats repo-relative artifact paths', () => {
    assert.equal(
      posixPath(
        formatArtifactPath('/repo/apps/desktop/release/mac-arm64/Videorc.app', {
          repoRoot: '/repo',
          homeDir: '/Users/orcdev'
        })
      ),
      'apps/desktop/release/mac-arm64/Videorc.app'
    )
  })

  it('redacts home and repo paths from command output', () => {
    const output = sanitizeReleaseValidationOutput(
      '/repo/apps/desktop/release/mac-arm64/Videorc.app\n/Users/orcdev/Library/secret',
      {
        repoRoot: '/repo',
        homeDir: '/Users/orcdev'
      }
    )

    assert.equal(output, '<repo>/apps/desktop/release/mac-arm64/Videorc.app\n<home>/Library/secret')
  })

  it('includes only failing command excerpts', () => {
    const report = formatReleaseArtifactValidationReport({
      artifactLabel: 'apps/desktop/release/Videorc.dmg',
      results: [
        { label: 'codesign verify', ok: true, output: 'unused success output' },
        { label: 'Gatekeeper assess', ok: false, output: 'rejected\n/path detail' }
      ]
    })

    assert.match(report, /macos-release-artifact: FAIL apps\/desktop\/release\/Videorc\.dmg/)
    assert.match(report, /\[ok\] codesign verify/)
    assert.match(report, /\[fail\] Gatekeeper assess/)
    assert.match(report, /  rejected/)
    assert.doesNotMatch(report, /unused success output/)
  })
})
