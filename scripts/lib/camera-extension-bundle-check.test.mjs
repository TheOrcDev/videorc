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
  cameraExtensionLayout,
  cameraExtensionLayoutProblems,
  cameraExtensionPaths,
  describeCameraExtensionLayout,
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

// Two fixtures on disk: a release-shaped app without the camera (red) and a
// complete bundle layout (green). Signatures are not forged; the tests that
// need one take it as data.
let fixtureRoot
let redApp
let greenApp

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'videorc-camera-fixture-'))
  redApp = join(fixtureRoot, 'red', 'Videorc.app')
  greenApp = join(fixtureRoot, 'green', 'Videorc.app')
  for (const app of [redApp, greenApp]) {
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'MacOS', 'Videorc'), '#!/bin/sh\nexit 0\n')
  }
  const paths = cameraExtensionPaths(greenApp, identifiers)
  mkdirSync(dirname(paths.executable), { recursive: true })
  writeFileSync(
    paths.infoPlist,
    plistXml(cameraExtensionInfoPlist(identifiers, { version: '0.18.0' }))
  )
  writeFileSync(paths.executable, '#!/bin/sh\nexit 0\n')
  writeFileSync(paths.extensionProfile, 'not a real profile')
  writeFileSync(paths.appProfile, 'not a real profile')
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
  it('a Developer ID build without the camera is red and points at B0', () => {
    const layout = cameraExtensionLayout(redApp, { identifiers, exists: existsSync })
    assert.deepEqual(Object.values(layout.present), [false, false, false, false, false])
    const problems = cameraExtensionLayoutProblems(layout, { identifiers, signature: developerId })
    assert.equal(problems.length, 5)
    assert.match(
      problems[0],
      /the extension bundle is missing \(Contents\/Library\/SystemExtensions\/VideorcCamera\.systemextension\)/
    )
    assert.ok(
      problems.every((line) =>
        line.includes('VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA (plan 214 B0)')
      )
    )
    assert.equal(
      describeCameraExtensionLayout(layout, developerId, identifiers),
      'absent (Developer ID build without the Videorc Camera profiles)'
    )
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

  it('a complete layout is green on a Developer ID build', () => {
    const layout = cameraExtensionLayout(greenApp, { identifiers, exists: existsSync })
    assert.deepEqual(Object.values(layout.present), [true, true, true, true, true])
    assert.deepEqual(
      cameraExtensionLayoutProblems(layout, { identifiers, signature: developerId }),
      []
    )
    assert.equal(describeCameraExtensionLayout(layout, developerId, identifiers), 'embedded')
  })

  it('half an extension or an extension in an unsigned build is a problem', () => {
    const layout = cameraExtensionLayout(greenApp, {
      identifiers,
      exists: (path) =>
        !path.endsWith('embedded.provisionprofile') || path.includes('.systemextension')
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
      assert.equal(plutilChecks(greenApp).length, 3)
      for (const check of plutilChecks(greenApp)) {
        assert.equal(run(check), true, check.label)
      }
      for (const check of plutilChecks(redApp)) {
        assert.equal(run(check), false, check.label)
      }
    }
  )
})
