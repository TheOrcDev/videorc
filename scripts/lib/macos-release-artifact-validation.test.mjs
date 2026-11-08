import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  APP_EMBEDDED_PROFILE_RELATIVE_PATH,
  CAMERA_EXTENSION_ENTITLEMENT_KEYS,
  CAMERA_EXTENSION_FORBIDDEN_ENTITLEMENTS,
  CAMERA_EXTENSION_RELATIVE_PATH,
  CAMERA_EXTENSION_REQUIRED_ENTITLEMENTS,
  INHERIT_ENTITLEMENT_KEYS,
  RESTRICTED_CAMERA_ENTITLEMENTS,
  artifactKindFromPath,
  bareBinaryCheckTargets,
  buildMacosReleaseArtifactChecks,
  cameraExtensionCheckTargets,
  entitlementKeyFailures,
  evaluatePathAbsentCheck,
  evaluateSingleEmbeddedProfileCheck,
  nestedExecutableCheckTargets,
  outputExclusionFailures,
  BUNDLED_X_OAUTH1_CONSUMER_ENVS,
  BUNDLED_YOUTUBE_OAUTH_ENVS,
  bundledXOauth1ConsumerCheckTargets,
  bundledYoutubeOauthCheckTargets,
  bundledKickSecretLeakCheckTargets,
  evaluateFileExcludesEnvSecretCheck,
  captureEntitlementCheckTargets,
  evaluateBinaryContainsEnvSecretCheck,
  EXPECTED_MACOS_BUNDLE_IDENTIFIER,
  formatArtifactPath,
  formatReleaseArtifactValidationReport,
  REQUIRED_CAPTURE_ENTITLEMENTS,
  sanitizeReleaseValidationOutput,
  selectLatestReleaseArtifacts,
  stdoutExpectationFailures
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
        'Info.plist bundle identifier',
        'Info.plist camera usage description',
        'Info.plist microphone usage description',
        'capture entitlements (app)',
        'capture entitlements (videorc-backend)',
        'capture entitlements (native_preview_host_helper)',
        'capture entitlements (videorc-mcp)',
        'capture entitlements (ffmpeg)',
        'capture entitlements (ffprobe)',
        'native preview addon signature',
        'Videorc Camera extension Info.plist bundle identifier',
        'Videorc Camera extension package type (SYSX)',
        'Videorc Camera extension CMIOExtensionMachServiceName',
        'Videorc Camera extension usage description',
        'Videorc Camera extension signature',
        'Videorc Camera extension entitlements (exactly sandbox + app group)',
        'Videorc Camera extension embeds no profile',
        'app embedded profile (Videorc Camera)',
        'one embedded profile, in the app only',
        'system extension entitlements (app)',
        'inherit entitlements only (videorc-backend)',
        'inherit entitlements only (native_preview_host_helper)',
        'inherit entitlements only (videorc-mcp)',
        'inherit entitlements only (ffmpeg)',
        'inherit entitlements only (ffprobe)',
        'no restricted entitlement (videorc_native_preview.node)',
        'inherit entitlements only (Videorc Helper.app)',
        'inherit entitlements only (Videorc Helper (GPU).app)',
        'inherit entitlements only (Videorc Helper (Plugin).app)',
        'inherit entitlements only (Videorc Helper (Renderer).app)',
        'inherit entitlements only (chrome_crashpad_handler)',
        'inherit entitlements only (ShipIt)',
        'bundled X OAuth1 consumer key (videorc-backend)',
        'bundled X OAuth1 consumer secret (videorc-backend)',
        'bundled YouTube OAuth client ID (videorc-backend)',
        'bundled YouTube OAuth client secret (videorc-backend)',
        'bundled Kick client secret absent from app.asar'
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

  it('requires exact capture identity and non-empty usage descriptions in the app Info.plist', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.app')
    const infoPlist = '/release/Videorc.app/Contents/Info.plist'

    assert.equal(EXPECTED_MACOS_BUNDLE_IDENTIFIER, 'dev.theorcdev.videorc')
    assert.deepEqual(
      checks.find((check) => check.id === 'info-plist-bundle-identifier'),
      {
        id: 'info-plist-bundle-identifier',
        label: 'Info.plist bundle identifier',
        command: 'plutil',
        args: [
          '-extract',
          'CFBundleIdentifier',
          'raw',
          '-expect',
          'string',
          '-n',
          '-o',
          '-',
          infoPlist
        ],
        expectStdoutEquals: EXPECTED_MACOS_BUNDLE_IDENTIFIER
      }
    )
    assert.deepEqual(
      checks.find((check) => check.id === 'info-plist-camera-usage-description'),
      {
        id: 'info-plist-camera-usage-description',
        label: 'Info.plist camera usage description',
        command: 'plutil',
        args: [
          '-extract',
          'NSCameraUsageDescription',
          'raw',
          '-expect',
          'string',
          '-n',
          '-o',
          '-',
          infoPlist
        ],
        expectStdoutNonEmpty: true
      }
    )
    assert.deepEqual(
      checks.find((check) => check.id === 'info-plist-microphone-usage-description'),
      {
        id: 'info-plist-microphone-usage-description',
        label: 'Info.plist microphone usage description',
        command: 'plutil',
        args: [
          '-extract',
          'NSMicrophoneUsageDescription',
          'raw',
          '-expect',
          'string',
          '-n',
          '-o',
          '-',
          infoPlist
        ],
        expectStdoutNonEmpty: true
      }
    )
  })

  it('does not apply inner-app Info.plist checks directly to a DMG', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.dmg')
    assert.equal(
      checks.some((check) => check.id.startsWith('info-plist-')),
      false
    )
  })
})

describe('stdout expectation gate', () => {
  it('requires an exact bundle identifier rather than substring containment', () => {
    const check = { expectStdoutEquals: EXPECTED_MACOS_BUNDLE_IDENTIFIER }
    assert.deepEqual(stdoutExpectationFailures(check, EXPECTED_MACOS_BUNDLE_IDENTIFIER), [])
    assert.equal(
      stdoutExpectationFailures(check, `prefix.${EXPECTED_MACOS_BUNDLE_IDENTIFIER}`).length,
      1
    )
    assert.equal(
      stdoutExpectationFailures(check, `${EXPECTED_MACOS_BUNDLE_IDENTIFIER}.suffix`).length,
      1
    )
  })

  it('rejects empty or whitespace-only usage descriptions', () => {
    const check = { expectStdoutNonEmpty: true }
    assert.deepEqual(stdoutExpectationFailures(check, 'Videorc uses your camera for overlays.'), [])
    for (const output of ['', '   ', '\n\t']) {
      assert.deepEqual(stdoutExpectationFailures(check, output), ['expected non-empty stdout'])
    }
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
        '/release/Videorc.app/Contents/Resources/videorc-mcp',
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

  it('fails closed when the release backend lacks the baked YouTube OAuth pair', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.app').filter((check) =>
      check.label.startsWith('bundled YouTube OAuth')
    )

    assert.deepEqual(checks, bundledYoutubeOauthCheckTargets('/release/Videorc.app'))
    assert.deepEqual(
      checks.map((check) => check.envName),
      BUNDLED_YOUTUBE_OAUTH_ENVS
    )
    for (const check of checks) {
      assert.equal(check.type, 'binary-contains-env-secret')
      assert.equal(check.path, '/release/Videorc.app/Contents/Resources/videorc-backend')
      assert.equal(
        evaluateBinaryContainsEnvSecretCheck(check, {
          env: {},
          readFile: () => Buffer.from('')
        }).ok,
        false
      )
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

  it('fails when the Kick client secret leaks into app.asar, and passes when Kick is dark', () => {
    const checks = buildMacosReleaseArtifactChecks('/release/Videorc.app').filter(
      (check) => check.type === 'file-excludes-env-secret'
    )
    assert.deepEqual(checks, bundledKickSecretLeakCheckTargets('/release/Videorc.app'))
    const [check] = checks
    assert.equal(check.path, '/release/Videorc.app/Contents/Resources/app.asar')
    const secret = 'fake-kick-secret'

    assert.deepEqual(
      evaluateFileExcludesEnvSecretCheck(check, {
        env: {},
        readFile: () => Buffer.from(secret)
      }),
      { ok: true, output: '' }
    )
    assert.deepEqual(
      evaluateFileExcludesEnvSecretCheck(check, {
        env: { [check.envName]: secret },
        readFile: () => Buffer.from(`asar ${secret} asar`)
      }),
      {
        ok: false,
        output:
          '/release/Videorc.app/Contents/Resources/app.asar contains the VIDEORC_BUNDLED_KICK_CLIENT_SECRET value in plain text'
      }
    )
    assert.deepEqual(
      evaluateFileExcludesEnvSecretCheck(check, {
        env: { [check.envName]: secret },
        readFile: () => Buffer.from('clean asar')
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
      ['app', 'videorc-backend', 'native-preview-host-helper', 'videorc-mcp', 'ffmpeg', 'ffprobe']
    )
  })

  it('requires the packaged in-process native preview addon to be signed', () => {
    const check = buildMacosReleaseArtifactChecks('/a/Videorc.app').find(
      (candidate) => candidate.id === 'native-preview-addon-signature'
    )

    assert.deepEqual(check, {
      id: 'native-preview-addon-signature',
      label: 'native preview addon signature',
      command: 'codesign',
      args: [
        '--verify',
        '--strict',
        '--verbose=2',
        '/a/Videorc.app/Contents/Resources/videorc_native_preview.node'
      ]
    })
  })
})

// Plan 214 B5, shape fixed by spike P0a: a release without the app profile is
// red here; so is the pre-P0a two-profile shape.
describe('Videorc Camera release gate', () => {
  const app = '/a/Videorc.app'
  const extension = `${app}/${CAMERA_EXTENSION_RELATIVE_PATH}`

  it('places the extension where OSSystemExtensionRequest looks, named by its bundle id', () => {
    assert.equal(
      CAMERA_EXTENSION_RELATIVE_PATH,
      'Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension'
    )
    assert.deepEqual(RESTRICTED_CAMERA_ENTITLEMENTS, [
      'com.apple.developer.system-extension.install',
      'com.apple.security.application-groups',
      'com.apple.application-identifier',
      'com.apple.developer.team-identifier'
    ])
    assert.deepEqual(CAMERA_EXTENSION_ENTITLEMENT_KEYS, [
      'com.apple.security.app-sandbox',
      'com.apple.security.application-groups'
    ])
    assert.deepEqual(CAMERA_EXTENSION_FORBIDDEN_ENTITLEMENTS, [
      'com.apple.developer.system-extension.install',
      'com.apple.application-identifier',
      'com.apple.developer.team-identifier'
    ])
    assert.deepEqual(INHERIT_ENTITLEMENT_KEYS, [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.device.audio-input',
      'com.apple.security.device.camera'
    ])
    assert.equal(APP_EMBEDDED_PROFILE_RELATIVE_PATH, 'Contents/embedded.provisionprofile')
  })

  it('checks the extension bundle, its Info.plist keys, SYSX, signature and exact entitlements', () => {
    const checks = cameraExtensionCheckTargets(app)
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]))
    assert.equal(
      byId['camera-extension-bundle-identifier'].expectStdoutEquals,
      'dev.theorcdev.videorc.camera'
    )
    assert.ok(
      byId['camera-extension-bundle-identifier'].args.includes(`${extension}/Contents/Info.plist`)
    )
    assert.equal(byId['camera-extension-package-type'].expectStdoutEquals, 'SYSX')
    assert.equal(
      byId['camera-extension-mach-service'].expectStdoutEquals,
      'C2PA37RB58.dev.theorcdev.videorc.camera'
    )
    assert.equal(byId['camera-extension-usage-description'].expectStdoutNonEmpty, true)
    assert.deepEqual(byId['camera-extension-signature'].args, [
      '--verify',
      '--strict',
      '--verbose=2',
      extension
    ])
    const entitlements = byId['camera-extension-entitlements']
    assert.deepEqual(entitlements.args, ['-d', '--entitlements', ':-', extension])
    assert.deepEqual(entitlements.expectOutputIncludes, CAMERA_EXTENSION_REQUIRED_ENTITLEMENTS)
    assert.deepEqual(CAMERA_EXTENSION_REQUIRED_ENTITLEMENTS, [
      'com.apple.security.app-sandbox',
      'com.apple.security.application-groups',
      'C2PA37RB58.dev.theorcdev.videorc'
    ])
    assert.deepEqual(entitlements.expectEntitlementKeys, CAMERA_EXTENSION_ENTITLEMENT_KEYS)
    assert.deepEqual(entitlements.expectOutputExcludes, CAMERA_EXTENSION_FORBIDDEN_ENTITLEMENTS)
    assert.deepEqual(byId['camera-extension-no-profile'], {
      id: 'camera-extension-no-profile',
      label: 'Videorc Camera extension embeds no profile',
      type: 'path-absent',
      path: `${extension}/Contents/embedded.provisionprofile`
    })
    assert.equal(
      checks.some((check) => check.id === 'camera-extension-profile'),
      false
    )
  })

  it('requires the one app profile and the restricted keys on the app only', () => {
    const byId = Object.fromEntries(
      cameraExtensionCheckTargets(app).map((check) => [check.id, check])
    )
    assert.deepEqual(byId['app-profile'].args, [
      'cms',
      '-D',
      '-i',
      `${app}/Contents/embedded.provisionprofile`
    ])
    assert.deepEqual(byId['app-profile'].expectOutputIncludes, [
      'C2PA37RB58.dev.theorcdev.videorc',
      'com.apple.developer.system-extension.install'
    ])
    assert.deepEqual(byId['single-embedded-profile'], {
      id: 'single-embedded-profile',
      label: 'one embedded profile, in the app only',
      type: 'single-embedded-profile',
      path: app
    })
    assert.deepEqual(byId['restricted-entitlements-app'].args, ['-d', '--entitlements', ':-', app])
    assert.deepEqual(byId['restricted-entitlements-app'].expectOutputIncludes, [
      'com.apple.developer.system-extension.install',
      'com.apple.security.application-groups',
      'C2PA37RB58.dev.theorcdev.videorc'
    ])
  })

  it('pins every other executable to exactly the inherit keys: bare tools, helpers, crashpad, ShipIt', () => {
    assert.deepEqual(
      bareBinaryCheckTargets(app).map((target) => target.id),
      [
        'videorc-backend',
        'native-preview-host-helper',
        'videorc-mcp',
        'ffmpeg',
        'ffprobe',
        'native-preview-addon'
      ]
    )
    assert.deepEqual(
      nestedExecutableCheckTargets(app).map((target) => [target.id, posixPath(target.path)]),
      [
        ['helper-main', '/a/Videorc.app/Contents/Frameworks/Videorc Helper.app'],
        ['helper-gpu', '/a/Videorc.app/Contents/Frameworks/Videorc Helper (GPU).app'],
        ['helper-plugin', '/a/Videorc.app/Contents/Frameworks/Videorc Helper (Plugin).app'],
        ['helper-renderer', '/a/Videorc.app/Contents/Frameworks/Videorc Helper (Renderer).app'],
        [
          'crashpad-handler',
          '/a/Videorc.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'
        ],
        [
          'shipit',
          '/a/Videorc.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'
        ]
      ]
    )
    const nested = cameraExtensionCheckTargets(app).filter((check) =>
      check.id.startsWith('no-restricted-entitlements-')
    )
    assert.equal(nested.length, 12)
    for (const check of nested) {
      assert.deepEqual(check.expectOutputExcludes, RESTRICTED_CAMERA_ENTITLEMENTS)
      assert.equal(check.args[0], '-d')
      if (check.id === 'no-restricted-entitlements-native-preview-addon') {
        // codesign embeds no entitlements into a Mach-O bundle: only the
        // restricted keys are forbidden, there is no exact set to expect.
        assert.equal(check.expectEntitlementKeys, undefined)
      } else {
        assert.deepEqual(check.expectEntitlementKeys, INHERIT_ENTITLEMENT_KEYS)
      }
    }
    const backend = nested.find(
      (check) => check.id === 'no-restricted-entitlements-videorc-backend'
    )
    assert.deepEqual(
      outputExclusionFailures(backend, '<key>com.apple.security.device.camera</key><true/>'),
      []
    )
    assert.deepEqual(
      outputExclusionFailures(
        backend,
        '<key>com.apple.developer.system-extension.install</key><true/>'
      ),
      ['forbidden entitlement present: com.apple.developer.system-extension.install']
    )
    assert.deepEqual(outputExclusionFailures({ command: 'codesign', args: [] }, 'anything'), [])
  })

  it('judges the exact entitlement key set a binary printed', () => {
    const five = INHERIT_ENTITLEMENT_KEYS.map((key) => `<key>${key}</key><true/>`).join('')
    const check = { expectEntitlementKeys: INHERIT_ENTITLEMENT_KEYS }
    assert.deepEqual(entitlementKeyFailures(check, `Executable=/x\n<dict>${five}</dict>`), [])
    assert.deepEqual(
      entitlementKeyFailures(
        check,
        `<dict>${five}<key>com.apple.security.application-groups</key><array/></dict>`
      ),
      ['unexpected entitlement: com.apple.security.application-groups']
    )
    assert.deepEqual(
      entitlementKeyFailures(
        check,
        '<dict><key>com.apple.security.device.camera</key><true/></dict>'
      ),
      [
        'missing entitlement: com.apple.security.cs.allow-jit',
        'missing entitlement: com.apple.security.cs.allow-unsigned-executable-memory',
        'missing entitlement: com.apple.security.cs.disable-library-validation',
        'missing entitlement: com.apple.security.device.audio-input'
      ]
    )
    assert.deepEqual(entitlementKeyFailures({ command: 'codesign' }, 'anything'), [])
  })

  it('refuses a profile inside the extension and more than the one app profile', () => {
    const absent = { type: 'path-absent', path: `${extension}/Contents/embedded.provisionprofile` }
    assert.deepEqual(evaluatePathAbsentCheck(absent, { exists: () => false }), {
      ok: true,
      output: ''
    })
    assert.equal(evaluatePathAbsentCheck(absent, { exists: () => true }).ok, false)
    assert.throws(() => evaluatePathAbsentCheck({ type: 'other' }, { exists: () => false }))

    const single = { type: 'single-embedded-profile', path: app }
    assert.deepEqual(
      evaluateSingleEmbeddedProfileCheck(single, {
        profiles: () => ['Contents/embedded.provisionprofile']
      }),
      { ok: true, output: '' }
    )
    const two = evaluateSingleEmbeddedProfileCheck(single, {
      profiles: () => [
        'Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension/Contents/embedded.provisionprofile',
        'Contents/embedded.provisionprofile'
      ]
    })
    assert.equal(two.ok, false)
    assert.match(
      two.output,
      /expected exactly one embedded profile at Contents\/embedded\.provisionprofile, found Contents\/Library/
    )
    const none = evaluateSingleEmbeddedProfileCheck(single, { profiles: () => [] })
    assert.equal(none.ok, false)
    assert.match(none.output, /found none/)
  })

  it('leaves DMGs to the inner app', () => {
    const labels = buildMacosReleaseArtifactChecks('/release/Videorc.dmg').map(
      (check) => check.label
    )
    assert.equal(
      labels.some((label) => label.includes('Videorc Camera')),
      false
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
