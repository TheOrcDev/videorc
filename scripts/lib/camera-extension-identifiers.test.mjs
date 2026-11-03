import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CAMERA_EXTENSION_SWIFT_IDENTIFIERS_PATH,
  appEntitlementsWithCamera,
  cameraExtensionBundleRelativePath,
  cameraExtensionEntitlementKeys,
  cameraExtensionEntitlementProblems,
  cameraExtensionEntitlements,
  cameraExtensionExecutableName,
  cameraExtensionForbiddenEntitlementKeys,
  cameraExtensionInfoPlist,
  entitlementKeysFromPlistXml,
  loadCameraExtensionIdentifiers,
  parsePlistXml,
  parseSwiftLiteral,
  plistXml,
  restrictedCameraEntitlementKeys,
  swiftIdentifierDrift,
  validateCameraExtensionIdentifiers
} from './camera-extension-identifiers.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const identifiers = loadCameraExtensionIdentifiers(repoRoot)
const swiftSource = readFileSync(join(repoRoot, CAMERA_EXTENSION_SWIFT_IDENTIFIERS_PATH), 'utf8')

describe('identifiers.json', () => {
  it('holds the plan 214 fixed identifiers', () => {
    assert.equal(identifiers.cameraName, 'Videorc Camera')
    assert.equal(identifiers.appBundleId, 'dev.theorcdev.videorc')
    assert.equal(identifiers.extensionBundleId, 'dev.theorcdev.videorc.camera')
    assert.equal(identifiers.teamId, 'C2PA37RB58')
    assert.equal(identifiers.appGroup, 'C2PA37RB58.dev.theorcdev.videorc')
    assert.equal(identifiers.machServiceName, 'C2PA37RB58.dev.theorcdev.videorc.camera')
    assert.equal(identifiers.deviceUuid, '7C2B0687-25A9-44A9-A5FC-3293B79D2853')
    assert.equal(identifiers.sourceStreamUuid, '1CCC837F-7786-4724-BC71-925249A9FE86')
    assert.equal(identifiers.sinkStreamUuid, '5599A319-404B-4915-AB63-9ED972F48F71')
    assert.deepEqual(identifiers.format, {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: '32BGRA',
      fourcc: 'BGRA'
    })
  })

  it('validates its own shape and names each problem', () => {
    assert.deepEqual(validateCameraExtensionIdentifiers(identifiers), [])
    const broken = JSON.parse(JSON.stringify(identifiers))
    broken.machServiceName = 'dev.theorcdev.videorc.camera'
    broken.deviceUuid = 'not-a-uuid'
    broken.format.fps = 60
    broken.customProperties.clientCount = 'vccc'
    const problems = validateCameraExtensionIdentifiers(broken)
    assert.ok(problems.some((line) => line.includes('machServiceName')))
    assert.ok(problems.some((line) => line.includes('deviceUuid')))
    assert.ok(problems.some((line) => line.includes('D11 format')))
    assert.ok(problems.some((line) => line.includes('customProperties.clientCount')))
  })
})

describe('Swift mirror drift check', () => {
  it('reads string, array and number literals', () => {
    assert.equal(parseSwiftLiteral('"Videorc Camera"'), 'Videorc Camera')
    assert.deepEqual(parseSwiftLiteral('["a", "b"]'), ['a', 'b'])
    assert.equal(parseSwiftLiteral('1920'), 1920)
    assert.equal(parseSwiftLiteral('1.0'), 1)
    assert.equal(parseSwiftLiteral('UUID()'), undefined)
  })

  it('finds no drift between Identifiers.swift and identifiers.json', () => {
    assert.deepEqual(swiftIdentifierDrift(swiftSource, identifiers), [])
  })

  it('names a changed, a missing and a non-literal constant', () => {
    const changed = swiftSource.replace('"Videorc Camera"', '"Videorc Cam"')
    const changedProblems = swiftIdentifierDrift(changed, identifiers)
    assert.equal(changedProblems.length, 1)
    assert.match(changedProblems[0], /cameraName is "Videorc Cam" in Swift but "Videorc Camera"/)

    const missing = swiftSource.replace(/^\s*public static let deviceUUID.*$/m, '')
    assert.deepEqual(swiftIdentifierDrift(missing, identifiers), [
      'deviceUUID is missing from Identifiers.swift'
    ])

    const computed = swiftSource.replace(
      /public static let teamID = .*$/m,
      'public static let teamID = String(describing: 1)'
    )
    assert.match(
      swiftIdentifierDrift(computed, identifiers)[0],
      /teamID is not a string, array or number literal/
    )
  })

  it('compares numbers numerically so Swift 1.0 matches JSON 1', () => {
    const asInteger = swiftSource.replace('staleAfterSeconds = 1.0', 'staleAfterSeconds = 1')
    assert.deepEqual(swiftIdentifierDrift(asInteger, identifiers), [])
    const drifted = swiftSource.replace('staleAfterSeconds = 1.0', 'staleAfterSeconds = 2.0')
    assert.equal(swiftIdentifierDrift(drifted, identifiers).length, 1)
  })
})

describe('bundle plists', () => {
  it('places the extension where OSSystemExtensionRequest looks, named by its bundle id (P0a)', () => {
    assert.equal(
      cameraExtensionBundleRelativePath(identifiers),
      'Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension'
    )
    assert.equal(cameraExtensionExecutableName(identifiers), 'dev.theorcdev.videorc.camera')
  })

  it('writes the CMIOExtension keys and the usage description into Info.plist', () => {
    const plist = cameraExtensionInfoPlist(identifiers, {
      version: '0.18.0',
      buildVersion: '0.18.0'
    })
    assert.equal(plist.CFBundleIdentifier, 'dev.theorcdev.videorc.camera')
    assert.equal(plist.CFBundleExecutable, 'dev.theorcdev.videorc.camera')
    assert.equal(plist.CFBundlePackageType, 'SYSX')
    assert.equal(
      plist.CMIOExtension.CMIOExtensionMachServiceName,
      'C2PA37RB58.dev.theorcdev.videorc.camera'
    )
    assert.equal(plist.LSMinimumSystemVersion, '13.0')
    assert.equal(plist.CFBundleShortVersionString, '0.18.0')
    assert.ok(plist.NSSystemExtensionUsageDescription.length > 10)
    assert.throws(
      () => cameraExtensionInfoPlist(identifiers, { version: 'lab' }),
      /semantic version/
    )
  })

  it('gives the extension exactly the sandbox and the app group, never the identifiers (P0a)', () => {
    assert.deepEqual(cameraExtensionEntitlements(identifiers), {
      'com.apple.security.app-sandbox': true,
      'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc']
    })
    assert.deepEqual(cameraExtensionEntitlementKeys(identifiers), [
      'com.apple.security.app-sandbox',
      'com.apple.security.application-groups'
    ])
    assert.deepEqual(cameraExtensionForbiddenEntitlementKeys(identifiers), [
      'com.apple.developer.system-extension.install',
      'com.apple.application-identifier',
      'com.apple.developer.team-identifier'
    ])
  })

  it('reads entitlement keys out of codesign output and judges the extension set', () => {
    const shown = [
      'Executable=/x',
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>com.apple.security.app-sandbox</key><true/>',
      '  <key>com.apple.security.application-groups</key>',
      '  <array><string>C2PA37RB58.dev.theorcdev.videorc</string></array>',
      '</dict></plist>'
    ].join('\n')
    assert.deepEqual(entitlementKeysFromPlistXml(shown), [
      'com.apple.security.app-sandbox',
      'com.apple.security.application-groups'
    ])
    assert.deepEqual(entitlementKeysFromPlistXml('Executable=/x\n'), [])
    assert.deepEqual(
      cameraExtensionEntitlementProblems(entitlementKeysFromPlistXml(shown), identifiers),
      []
    )
    const b0Shape = cameraExtensionEntitlementProblems(
      [
        'com.apple.security.app-sandbox',
        'com.apple.security.application-groups',
        'com.apple.application-identifier',
        'com.apple.developer.team-identifier'
      ],
      identifiers
    )
    assert.equal(b0Shape.length, 2)
    assert.match(
      b0Shape[0],
      /carries com\.apple\.application-identifier; without an embedded profile/
    )
    assert.match(b0Shape[1], /carries com\.apple\.developer\.team-identifier/)
    const restricted = cameraExtensionEntitlementProblems(
      ['com.apple.security.app-sandbox', 'com.apple.developer.system-extension.install'],
      identifiers
    )
    assert.ok(restricted.some((line) => line.includes('system-extension.install')))
    assert.ok(
      restricted.some((line) => line.includes('missing com.apple.security.application-groups'))
    )
    assert.deepEqual(
      cameraExtensionEntitlementProblems(
        [
          'com.apple.security.app-sandbox',
          'com.apple.security.application-groups',
          'com.apple.security.network.client'
        ],
        identifiers
      ),
      ['the extension carries an unexpected entitlement com.apple.security.network.client']
    )
  })

  it('adds the restricted keys to the app entitlements without dropping the base ones', () => {
    const base = {
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.device.camera': true
    }
    const withCamera = appEntitlementsWithCamera(base, identifiers)
    assert.equal(withCamera['com.apple.security.cs.allow-jit'], true)
    assert.equal(withCamera['com.apple.security.device.camera'], true)
    assert.equal(withCamera['com.apple.developer.system-extension.install'], true)
    assert.deepEqual(withCamera['com.apple.security.application-groups'], [
      'C2PA37RB58.dev.theorcdev.videorc'
    ])
    assert.equal(withCamera['com.apple.application-identifier'], 'C2PA37RB58.dev.theorcdev.videorc')
    assert.equal(withCamera['com.apple.developer.team-identifier'], 'C2PA37RB58')
    assert.deepEqual(base, {
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.device.camera': true
    })
  })

  it('names every key a bare binary must never claim', () => {
    assert.deepEqual(restrictedCameraEntitlementKeys(identifiers), [
      'com.apple.developer.system-extension.install',
      'com.apple.security.application-groups',
      'com.apple.application-identifier',
      'com.apple.developer.team-identifier'
    ])
  })

  it('serializes and parses XML plists with escaping', () => {
    const value = {
      'a&b': 'x < y',
      flag: true,
      off: false,
      list: ['one', 'two'],
      count: 3,
      nested: { inner: 'value' }
    }
    const xml = plistXml(value)
    assert.match(xml, /<key>a&amp;b<\/key>\n\s*<string>x &lt; y<\/string>/)
    assert.match(xml, /<integer>3<\/integer>/)
    assert.deepEqual(parsePlistXml(xml), value)
  })

  it('parses the committed base entitlements plist', () => {
    const base = parsePlistXml(
      readFileSync(join(repoRoot, 'apps/desktop/build-resources/entitlements.mac.plist'), 'utf8')
    )
    assert.equal(base['com.apple.security.device.camera'], true)
    assert.equal(base['com.apple.security.device.audio-input'], true)
    assert.equal(base['com.apple.security.cs.allow-jit'], true)
  })
})
