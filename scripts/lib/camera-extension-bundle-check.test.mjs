import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  appBundleRootForApp,
  appSignatureFromCodesignDisplay,
  cameraExtensionForbiddenPaths,
  cameraExtensionLayout,
  cameraExtensionLayoutProblems,
  cameraExtensionPaths,
  cameraExtensionSignedShapeProblems,
  describeCameraExtensionLayout,
  isCameraExtensionEmbedded,
  isDeveloperIdBuild
} from './camera-extension-bundle-check.mjs'
import {
  cameraExtensionInfoPlist,
  loadCameraExtensionIdentifiers,
  plistXml
} from './camera-extension-identifiers.mjs'
import { cameraExtensionCheckTargets } from './macos-release-artifact-validation.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const identifiers = loadCameraExtensionIdentifiers(repoRoot)

const developerId = { signed: true, adhoc: false, teamIdentifier: 'C2PA37RB58' }
const adhoc = { signed: true, adhoc: true, teamIdentifier: null }
const unsigned = { signed: false, adhoc: false, teamIdentifier: null }

// Three fixtures on disk: a release-shaped app without the camera (red), a
// complete P0a layout (green), and the pre-P0a two-profile layout (stale).
// Signatures are not forged; the tests that need one take it as data.
let fixtureRoot
let redApp
let greenApp
let staleApp

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'videorc-camera-fixture-'))
  redApp = join(fixtureRoot, 'red', 'Videorc.app')
  greenApp = join(fixtureRoot, 'green', 'Videorc.app')
  staleApp = join(fixtureRoot, 'stale', 'Videorc.app')
  for (const app of [redApp, greenApp, staleApp]) {
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'MacOS', 'Videorc'), '#!/bin/sh\nexit 0\n')
  }
  for (const app of [greenApp, staleApp]) {
    const paths = cameraExtensionPaths(app, identifiers)
    mkdirSync(dirname(paths.executable), { recursive: true })
    writeFileSync(
      paths.infoPlist,
      plistXml(cameraExtensionInfoPlist(identifiers, { version: '0.18.0' }))
    )
    writeFileSync(paths.executable, '#!/bin/sh\nexit 0\n')
    writeFileSync(paths.appProfile, 'not a real profile')
  }
  writeFileSync(
    cameraExtensionForbiddenPaths(staleApp, identifiers).extensionProfile,
    'not a real profile'
  )
})

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('appBundleRootForApp', () => {
  it('accepts a bundle or its executable', () => {
    assert.equal(appBundleRootForApp('/x/Videorc.app'), resolve('/x/Videorc.app'))
    assert.equal(
      appBundleRootForApp('/x/Videorc.app/Contents/MacOS/Videorc'),
      resolve('/x/Videorc.app')
    )
  })
})

describe('appSignatureFromCodesignDisplay', () => {
  it('reads Developer ID, ad hoc and unsigned', () => {
    assert.deepEqual(
      appSignatureFromCodesignDisplay(
        'Executable=/x\nIdentifier=dev.theorcdev.videorc\nAuthority=Developer ID Application: Uros Miric (C2PA37RB58)\nTeamIdentifier=C2PA37RB58\n'
      ),
      developerId
    )
    assert.deepEqual(
      appSignatureFromCodesignDisplay('Signature=adhoc\nTeamIdentifier=not set\n'),
      adhoc
    )
    assert.deepEqual(
      appSignatureFromCodesignDisplay('/x: code object is not signed at all', { exitCode: 1 }),
      unsigned
    )
    assert.equal(isDeveloperIdBuild(developerId, identifiers), true)
    assert.equal(
      isDeveloperIdBuild({ ...developerId, teamIdentifier: 'OTHER' }, identifiers),
      false
    )
  })
})

describe('camera extension bundle layout', () => {
  it('names the P0a files: the bundle and executable by bundle id, one profile on the app', () => {
    const paths = cameraExtensionPaths('/x/Videorc.app', identifiers)
    assert.deepEqual(Object.keys(paths), ['extension', 'infoPlist', 'executable', 'appProfile'])
    assert.ok(
      paths.extension.endsWith(
        join(
          'Contents',
          'Library',
          'SystemExtensions',
          'dev.theorcdev.videorc.camera.systemextension'
        )
      )
    )
    assert.ok(paths.executable.endsWith(join('Contents', 'MacOS', 'dev.theorcdev.videorc.camera')))
    assert.ok(
      cameraExtensionForbiddenPaths('/x/Videorc.app', identifiers).extensionProfile.endsWith(
        join('.systemextension', 'Contents', 'embedded.provisionprofile')
      )
    )
  })

  it('a Developer ID build without the camera is red and names the one profile variable', () => {
    const layout = cameraExtensionLayout(redApp, { identifiers, exists: existsSync })
    assert.deepEqual(Object.values(layout.present), [false, false, false, false])
    assert.deepEqual(layout.stray, { extensionProfile: false })
    const problems = cameraExtensionLayoutProblems(layout, { identifiers, signature: developerId })
    assert.equal(problems.length, 4)
    assert.match(
      problems[0],
      /the extension bundle is missing \(Contents\/Library\/SystemExtensions\/dev\.theorcdev\.videorc\.camera\.systemextension\)/
    )
    assert.ok(problems.every((line) => line.includes('set VIDEORC_MACOS_PROFILE_APP (plan 214)')))
    assert.ok(problems.every((line) => !line.includes('VIDEORC_MACOS_PROFILE_CAMERA')))
    assert.equal(
      describeCameraExtensionLayout(layout, developerId, identifiers),
      'absent (Developer ID build without the Videorc Camera profile)'
    )
    assert.equal(isCameraExtensionEmbedded(layout), false)
  })

  it('an unsigned or ad hoc build without the camera is only described, not red', () => {
    const layout = cameraExtensionLayout(redApp, { identifiers, exists: existsSync })
    assert.deepEqual(
      cameraExtensionLayoutProblems(layout, { identifiers, signature: unsigned }),
      []
    )
    assert.deepEqual(cameraExtensionLayoutProblems(layout, { identifiers, signature: adhoc }), [])
    assert.equal(
      describeCameraExtensionLayout(layout, unsigned, identifiers),
      'absent (unsigned build)'
    )
    assert.equal(
      describeCameraExtensionLayout(layout, adhoc, identifiers),
      'absent (ad hoc or non-Videorc signature)'
    )
  })

  it('a complete P0a layout is green on a Developer ID build', () => {
    const layout = cameraExtensionLayout(greenApp, { identifiers, exists: existsSync })
    assert.deepEqual(Object.values(layout.present), [true, true, true, true])
    assert.deepEqual(
      cameraExtensionLayoutProblems(layout, { identifiers, signature: developerId }),
      []
    )
    assert.equal(describeCameraExtensionLayout(layout, developerId, identifiers), 'embedded')
    assert.equal(isCameraExtensionEmbedded(layout), true)
  })

  it('a profile inside the extension (the pre-P0a shape) is red on every build', () => {
    const layout = cameraExtensionLayout(staleApp, { identifiers, exists: existsSync })
    assert.deepEqual(layout.stray, { extensionProfile: true })
    for (const signature of [developerId, adhoc, unsigned]) {
      const problems = cameraExtensionLayoutProblems(layout, { identifiers, signature })
      assert.ok(
        problems.some((line) =>
          /the extension carries an embedded\.provisionprofile .*The extension embeds no profile \(plan 214 P0a\)/.test(
            line
          )
        ),
        JSON.stringify(problems)
      )
    }
  })

  it('half an extension or an extension in an unsigned build is a problem', () => {
    const layout = cameraExtensionLayout(greenApp, {
      identifiers,
      exists: (path) => !path.endsWith('embedded.provisionprofile')
    })
    const half = cameraExtensionLayoutProblems(layout, { identifiers, signature: unsigned })
    assert.equal(half.length, 1)
    assert.match(half[0], /half-embedded; missing the app's embedded.provisionprofile/)
    assert.equal(describeCameraExtensionLayout(layout, unsigned, identifiers), 'partial')

    const full = cameraExtensionLayout(greenApp, { identifiers, exists: existsSync })
    const inUnsigned = cameraExtensionLayoutProblems(full, { identifiers, signature: adhoc })
    assert.match(inUnsigned[0], /not Developer ID signed by Videorc/)
  })

  it(
    "the validator's Info.plist checks pass on the green fixture and fail on the red one (macOS plutil)",
    { skip: process.platform !== 'darwin' },
    () => {
      const run = (check) => {
        const result = spawnSync(check.command, check.args, { encoding: 'utf8' })
        const stdout = result.stdout ?? ''
        const okEquals =
          check.expectStdoutEquals === undefined || stdout === check.expectStdoutEquals
        const okNonEmpty = check.expectStdoutNonEmpty !== true || stdout.trim().length > 0
        return result.status === 0 && okEquals && okNonEmpty
      }
      const plutilChecks = (app) =>
        cameraExtensionCheckTargets(app).filter((check) => check.command === 'plutil')
      assert.equal(plutilChecks(greenApp).length, 4)
      for (const check of plutilChecks(greenApp)) {
        assert.equal(run(check), true, check.label)
      }
      for (const check of plutilChecks(redApp)) {
        assert.equal(run(check), false, check.label)
      }
    }
  )
})

describe('cameraExtensionSignedShapeProblems (P0a facts 1 to 6)', () => {
  const inherit = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.device.audio-input',
    'com.apple.security.device.camera'
  ]
  const good = {
    extensionEntitlementKeys: [
      'com.apple.security.app-sandbox',
      'com.apple.security.application-groups'
    ],
    extensionSignatureOk: true,
    packageType: 'SYSX',
    appEntitlementKeys: [
      ...inherit,
      'com.apple.developer.system-extension.install',
      'com.apple.security.application-groups',
      'com.apple.application-identifier',
      'com.apple.developer.team-identifier'
    ],
    nestedEntitlements: [
      { label: 'videorc-backend', keys: inherit },
      { label: 'Videorc Helper (GPU).app', keys: inherit },
      { label: 'ShipIt', keys: inherit }
    ],
    embeddedProfiles: ['Contents/embedded.provisionprofile']
  }

  it('accepts the shape the spike launched and notarized', () => {
    assert.deepEqual(cameraExtensionSignedShapeProblems(good, { identifiers }), [])
  })

  it('names every deviation', () => {
    const bad = cameraExtensionSignedShapeProblems(
      {
        ...good,
        extensionEntitlementKeys: [
          ...good.extensionEntitlementKeys,
          'com.apple.application-identifier',
          'com.apple.developer.team-identifier'
        ],
        extensionSignatureOk: false,
        packageType: 'XPC!',
        appEntitlementKeys: inherit,
        nestedEntitlements: [
          { label: 'videorc-backend', keys: [...inherit, 'com.apple.security.application-groups'] },
          { label: 'ShipIt', keys: inherit }
        ],
        embeddedProfiles: [
          'Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension/Contents/embedded.provisionprofile',
          'Contents/embedded.provisionprofile'
        ]
      },
      { identifiers }
    )
    assert.ok(
      bad.some((line) =>
        /carries com\.apple\.application-identifier; without an embedded profile/.test(line)
      )
    )
    assert.ok(bad.some((line) => /carries com\.apple\.developer\.team-identifier/.test(line)))
    assert.ok(bad.some((line) => /signature does not verify/.test(line)))
    assert.ok(bad.some((line) => /CFBundlePackageType is "XPC!", expected SYSX/.test(line)))
    assert.ok(
      bad.some((line) =>
        /app is signed without com\.apple\.developer\.system-extension\.install/.test(line)
      )
    )
    assert.ok(
      bad.some((line) =>
        /app is signed without com\.apple\.security\.application-groups/.test(line)
      )
    )
    assert.ok(
      bad.some((line) =>
        /videorc-backend carries com\.apple\.security\.application-groups; a binary without a profile dies at exec/.test(
          line
        )
      )
    )
    assert.ok(bad.every((line) => !line.includes('ShipIt carries')))
    assert.ok(
      bad.some((line) =>
        /expected exactly one embedded profile at Contents\/embedded\.provisionprofile, found Contents\/Library/.test(
          line
        )
      )
    )
    assert.ok(
      cameraExtensionSignedShapeProblems({ ...good, embeddedProfiles: [] }, { identifiers }).some(
        (line) => /found none/.test(line)
      )
    )
    assert.ok(cameraExtensionSignedShapeProblems({}, { identifiers }).length > 0)
  })
})
