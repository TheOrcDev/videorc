// Plan 214 B1: the Videorc Camera identifiers, read from the one source of
// truth (apps/desktop/camera-extension/identifiers.json), the Swift mirror
// drift check, and the Info.plist and entitlements the build and packaging
// scripts write from it. Pure: every function takes its inputs explicitly.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CAMERA_EXTENSION_DIR = 'apps/desktop/camera-extension'
export const CAMERA_EXTENSION_IDENTIFIERS_PATH = `${CAMERA_EXTENSION_DIR}/identifiers.json`
export const CAMERA_EXTENSION_SWIFT_IDENTIFIERS_PATH = `${CAMERA_EXTENSION_DIR}/Sources/VideorcCameraCore/Identifiers.swift`

/** Where the built, ad-hoc signed bundle lands (gitignored under apps/desktop/build). */
export const CAMERA_EXTENSION_BUILD_DIR = 'apps/desktop/build/camera-extension'

const REQUIRED_STRING_KEYS = [
  'cameraName',
  'appBundleId',
  'extensionBundleId',
  'extensionBundleName',
  'teamId',
  'appGroup',
  'machServiceName',
  'deviceUuid',
  'sourceStreamUuid',
  'sinkStreamUuid',
  'deploymentTarget',
  'usageDescription'
]

const UUID_KEYS = ['deviceUuid', 'sourceStreamUuid', 'sinkStreamUuid']
const UUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

export function loadCameraExtensionIdentifiers(repoRoot, { readFile = readFileSync } = {}) {
  const identifiers = JSON.parse(
    readFile(join(repoRoot, CAMERA_EXTENSION_IDENTIFIERS_PATH), 'utf8')
  )
  const problems = validateCameraExtensionIdentifiers(identifiers)
  if (problems.length > 0) {
    throw new Error(`${CAMERA_EXTENSION_IDENTIFIERS_PATH} is invalid:\n${problems.join('\n')}`)
  }
  return identifiers
}

/** Pure. One line per problem; empty when the identifiers file is well formed. */
export function validateCameraExtensionIdentifiers(identifiers) {
  const problems = []
  if (!identifiers || typeof identifiers !== 'object') {
    return ['identifiers must be an object']
  }
  for (const key of REQUIRED_STRING_KEYS) {
    if (typeof identifiers[key] !== 'string' || identifiers[key].trim() === '') {
      problems.push(`${key} must be a non-empty string`)
    }
  }
  for (const key of UUID_KEYS) {
    if (typeof identifiers[key] === 'string' && !UUID_PATTERN.test(identifiers[key])) {
      problems.push(`${key} must be an uppercase UUID`)
    }
  }
  if (
    typeof identifiers.extensionBundleId === 'string' &&
    typeof identifiers.appBundleId === 'string' &&
    !identifiers.extensionBundleId.startsWith(`${identifiers.appBundleId}.`)
  ) {
    problems.push('extensionBundleId must live inside appBundleId')
  }
  if (
    typeof identifiers.appGroup === 'string' &&
    typeof identifiers.teamId === 'string' &&
    !identifiers.appGroup.startsWith(`${identifiers.teamId}.`)
  ) {
    problems.push('appGroup must start with the team id')
  }
  if (
    typeof identifiers.machServiceName === 'string' &&
    typeof identifiers.appGroup === 'string' &&
    !identifiers.machServiceName.startsWith(`${identifiers.appGroup}.`)
  ) {
    problems.push('machServiceName must be prefixed by the app group (Apple, WWDC22)')
  }
  if (
    !Array.isArray(identifiers.producerSigningIds) ||
    identifiers.producerSigningIds.length === 0 ||
    !identifiers.producerSigningIds.includes(identifiers.appBundleId)
  ) {
    problems.push('producerSigningIds must be a non-empty array that includes appBundleId')
  }
  const format = identifiers.format
  if (
    !format ||
    format.width !== 1920 ||
    format.height !== 1080 ||
    format.fps !== 30 ||
    format.fourcc !== 'BGRA' ||
    format.pixelFormat !== '32BGRA'
  ) {
    problems.push('format must be the D11 format: 1920x1080 32BGRA (fourcc BGRA) at 30 fps')
  }
  const properties = identifiers.customProperties ?? {}
  for (const [name, value] of Object.entries({
    clientCount: properties.clientCount,
    producerWord: properties.producerWord
  })) {
    if (typeof value !== 'string' || !/^4cc_[a-z]{4}_glob_0000$/.test(value)) {
      problems.push(`customProperties.${name} must have the 4cc_xxxx_glob_0000 form`)
    }
  }
  const stills = identifiers.stills ?? {}
  for (const key of ['notRunningTitle', 'offTitle', 'offSubtitle']) {
    if (typeof stills[key] !== 'string' || stills[key].trim() === '') {
      problems.push(`stills.${key} must be a non-empty string`)
    }
  }
  if (typeof identifiers.staleAfterSeconds !== 'number' || identifiers.staleAfterSeconds <= 0) {
    problems.push('staleAfterSeconds must be a positive number')
  }
  const entitlements = identifiers.entitlements ?? {}
  if (entitlements.systemExtensionInstall !== 'com.apple.developer.system-extension.install') {
    problems.push('entitlements.systemExtensionInstall must name the restricted key')
  }
  if (entitlements.applicationGroups !== 'com.apple.security.application-groups') {
    problems.push('entitlements.applicationGroups must name the app groups key')
  }
  return problems
}

/** Swift constant name -> path into the identifiers JSON. */
export const SWIFT_CONSTANT_BINDINGS = [
  { swift: 'cameraName', path: ['cameraName'] },
  { swift: 'appBundleID', path: ['appBundleId'] },
  { swift: 'extensionBundleID', path: ['extensionBundleId'] },
  { swift: 'teamID', path: ['teamId'] },
  { swift: 'appGroup', path: ['appGroup'] },
  { swift: 'machServiceName', path: ['machServiceName'] },
  { swift: 'deviceUUID', path: ['deviceUuid'] },
  { swift: 'sourceStreamUUID', path: ['sourceStreamUuid'] },
  { swift: 'sinkStreamUUID', path: ['sinkStreamUuid'] },
  { swift: 'producerSigningIDs', path: ['producerSigningIds'] },
  { swift: 'clientCountProperty', path: ['customProperties', 'clientCount'] },
  { swift: 'producerWordProperty', path: ['customProperties', 'producerWord'] },
  { swift: 'formatWidth', path: ['format', 'width'] },
  { swift: 'formatHeight', path: ['format', 'height'] },
  { swift: 'formatFramesPerSecond', path: ['format', 'fps'] },
  { swift: 'formatFourCC', path: ['format', 'fourcc'] },
  { swift: 'staleAfterSeconds', path: ['staleAfterSeconds'] },
  { swift: 'stillNotRunningTitle', path: ['stills', 'notRunningTitle'] },
  { swift: 'stillOffTitle', path: ['stills', 'offTitle'] },
  { swift: 'stillOffSubtitle', path: ['stills', 'offSubtitle'] }
]

function valueAt(object, path) {
  return path.reduce((current, key) => (current == null ? undefined : current[key]), object)
}

/**
 * Pure. Reads a Swift literal of the shapes Identifiers.swift uses: a string
 * literal, an array of string literals, or a number. Returns undefined for
 * anything else so the caller reports it.
 */
export function parseSwiftLiteral(source) {
  const text = String(source).trim()
  if (text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text)
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseSwiftLiteral(item))
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text)
  }
  return undefined
}

/**
 * Pure. One line per Swift constant that is missing or differs from the JSON.
 * Numbers compare numerically (Swift `1.0` equals JSON `1`).
 */
export function swiftIdentifierDrift(swiftSource, identifiers) {
  const problems = []
  for (const binding of SWIFT_CONSTANT_BINDINGS) {
    const pattern = new RegExp(
      `^\\s*public static let ${binding.swift}(?:\\s*:\\s*[^=]+)?\\s*=\\s*(.+?)\\s*$`,
      'm'
    )
    const match = pattern.exec(swiftSource)
    const expected = valueAt(identifiers, binding.path)
    if (!match) {
      problems.push(`${binding.swift} is missing from Identifiers.swift`)
      continue
    }
    const actual = parseSwiftLiteral(match[1])
    if (actual === undefined) {
      problems.push(`${binding.swift} is not a string, array or number literal: ${match[1]}`)
      continue
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${binding.swift} is ${JSON.stringify(actual)} in Swift but ${JSON.stringify(expected)} in identifiers.json (${binding.path.join('.')})`
      )
    }
  }
  return problems
}

/**
 * `Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension`.
 * The bundle and its executable are named after the bundle identifier, the
 * shape Xcode produces and the one plan 214 P0a activated on macOS 26.
 */
export function cameraExtensionBundleRelativePath(identifiers) {
  return `Contents/Library/SystemExtensions/${identifiers.extensionBundleId}.systemextension`
}

/** `Contents/MacOS/<executable>` inside the extension bundle. */
export function cameraExtensionExecutableName(identifiers) {
  return identifiers.extensionBundleId
}

/** Pure. The extension's Info.plist as a plain object (see plistXml). */
export function cameraExtensionInfoPlist(identifiers, { version, buildVersion = version } = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`A semantic version is required for the extension Info.plist, got ${version}`)
  }
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: identifiers.cameraName,
    CFBundleExecutable: cameraExtensionExecutableName(identifiers),
    CFBundleIdentifier: identifiers.extensionBundleId,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: identifiers.cameraName,
    CFBundlePackageType: 'SYSX',
    CFBundleShortVersionString: version,
    CFBundleSupportedPlatforms: ['MacOSX'],
    CFBundleVersion: buildVersion,
    CMIOExtension: {
      CMIOExtensionMachServiceName: identifiers.machServiceName
    },
    LSMinimumSystemVersion: identifiers.deploymentTarget,
    NSHumanReadableCopyright: 'Copyright © TheOrcDev. Licensed under the AGPL-3.0.',
    NSSystemExtensionUsageDescription: identifiers.usageDescription
  }
}

/**
 * Pure. The extension's own entitlements, exactly two keys: the app sandbox
 * and the app group (plan 214 P0a). The extension embeds NO provisioning
 * profile, so it must not claim `com.apple.application-identifier` or
 * `com.apple.developer.team-identifier`: without a profile those are
 * restricted keys and the binary is killed at exec, silently.
 */
export function cameraExtensionEntitlements(identifiers) {
  return {
    [identifiers.entitlements.appSandbox]: true,
    [identifiers.entitlements.applicationGroups]: [identifiers.appGroup]
  }
}

/** Pure. The exact key set a signed extension must show. */
export function cameraExtensionEntitlementKeys(identifiers) {
  return Object.keys(cameraExtensionEntitlements(identifiers)).sort()
}

/** Pure. The keys the extension must never carry (it has no profile to back them). */
export function cameraExtensionForbiddenEntitlementKeys(identifiers) {
  return [
    identifiers.entitlements.systemExtensionInstall,
    identifiers.entitlements.applicationIdentifier,
    identifiers.entitlements.teamIdentifier
  ]
}

/**
 * Pure. The app's entitlements with the camera keys added: the restricted
 * system-extension key and the app group, plus the application and team
 * identifiers the app profile carries (optional for launch, kept because they
 * match the profile by construction; profileSummaryProblems checks that).
 * Only written when the app profile is configured.
 */
export function appEntitlementsWithCamera(baseEntitlements, identifiers) {
  return {
    ...baseEntitlements,
    [identifiers.entitlements.systemExtensionInstall]: true,
    [identifiers.entitlements.applicationGroups]: [identifiers.appGroup],
    [identifiers.entitlements.applicationIdentifier]:
      `${identifiers.teamId}.${identifiers.appBundleId}`,
    [identifiers.entitlements.teamIdentifier]: identifiers.teamId
  }
}

/**
 * The keys only the main executable may carry. Every other binary (Electron's
 * helpers, frameworks, crashpad, ShipIt, and the bare tools in Resources)
 * cannot hold a profile: with any of these it dies at exec with SIGKILL.
 */
export function restrictedCameraEntitlementKeys(identifiers) {
  return [
    identifiers.entitlements.systemExtensionInstall,
    identifiers.entitlements.applicationGroups,
    identifiers.entitlements.applicationIdentifier,
    identifiers.entitlements.teamIdentifier
  ]
}

/**
 * Pure. The entitlement keys in a plist as `codesign -d --entitlements :-`
 * prints it (XML; an unsigned or entitlement-less binary prints none).
 */
export function entitlementKeysFromPlistXml(xml) {
  const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const keys = []
  for (const match of text.matchAll(/<key>([\s\S]*?)<\/key>/g)) {
    const key = unescapeXml(match[1])
    if (!keys.includes(key)) keys.push(key)
  }
  return keys.sort()
}

/**
 * Pure. One line per problem with a signed extension's entitlement keys:
 * anything missing from the exact two, anything beyond them, and the keys it
 * must never carry named explicitly.
 */
export function cameraExtensionEntitlementProblems(keys, identifiers) {
  const actual = [...new Set(keys)].sort()
  const expected = cameraExtensionEntitlementKeys(identifiers)
  const problems = []
  for (const key of cameraExtensionForbiddenEntitlementKeys(identifiers)) {
    if (actual.includes(key)) {
      problems.push(
        `the extension carries ${key}; without an embedded profile that key gets it killed at exec. Its entitlements are exactly ${expected.join(' and ')}.`
      )
    }
  }
  for (const key of expected) {
    if (!actual.includes(key)) problems.push(`the extension is missing ${key}`)
  }
  for (const key of actual) {
    if (
      !expected.includes(key) &&
      !cameraExtensionForbiddenEntitlementKeys(identifiers).includes(key)
    ) {
      problems.push(`the extension carries an unexpected entitlement ${key}`)
    }
  }
  return problems
}

function escapeXml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function plistNode(value, indent) {
  const pad = '  '.repeat(indent)
  if (value === true) return `${pad}<true/>`
  if (value === false) return `${pad}<false/>`
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`
  }
  if (typeof value === 'string') return `${pad}<string>${escapeXml(value)}</string>`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`
    return [
      `${pad}<array>`,
      ...value.map((item) => plistNode(item, indent + 1)),
      `${pad}</array>`
    ].join('\n')
  }
  if (value && typeof value === 'object') {
    const lines = [`${pad}<dict>`]
    for (const key of Object.keys(value).sort()) {
      lines.push(`${pad}  <key>${escapeXml(key)}</key>`)
      lines.push(plistNode(value[key], indent + 1))
    }
    lines.push(`${pad}</dict>`)
    return lines.join('\n')
  }
  throw new Error(`Unsupported plist value: ${String(value)}`)
}

/** Pure. A sorted-key XML property list for codesign and CFBundle. */
export function plistXml(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistNode(value, 0),
    '</plist>',
    ''
  ].join('\n')
}

/**
 * Pure. Reads the keys and values of a plist produced by `plistXml` or by
 * Apple's tools in XML form: enough for the entitlements and the committed
 * base plist (strings, booleans, integers, string arrays, one nesting level
 * of dicts). Comments are ignored.
 */
export function parsePlistXml(xml) {
  const text = String(xml).replace(/<!--[\s\S]*?-->/g, '')
  const dictStart = text.indexOf('<dict>')
  const dictEnd = text.lastIndexOf('</dict>')
  if (dictStart === -1 || dictEnd === -1) {
    throw new Error('plist has no top-level dict')
  }
  return parseDictBody(text.slice(dictStart + '<dict>'.length, dictEnd))
}

function parseDictBody(body) {
  const result = {}
  const tokens =
    body.match(
      /<key>[\s\S]*?<\/key>|<true\/>|<false\/>|<string>[\s\S]*?<\/string>|<integer>[\s\S]*?<\/integer>|<real>[\s\S]*?<\/real>|<array\/>|<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>/g
    ) ?? []
  let pendingKey = null
  for (const token of tokens) {
    if (token.startsWith('<key>')) {
      pendingKey = unescapeXml(token.slice('<key>'.length, -'</key>'.length))
      continue
    }
    if (pendingKey === null) {
      throw new Error(`plist value without a key: ${token}`)
    }
    result[pendingKey] = parseValueToken(token)
    pendingKey = null
  }
  return result
}

function parseValueToken(token) {
  if (token === '<true/>') return true
  if (token === '<false/>') return false
  if (token === '<array/>') return []
  if (token.startsWith('<string>'))
    return unescapeXml(token.slice('<string>'.length, -'</string>'.length))
  if (token.startsWith('<integer>'))
    return Number(token.slice('<integer>'.length, -'</integer>'.length))
  if (token.startsWith('<real>')) return Number(token.slice('<real>'.length, -'</real>'.length))
  if (token.startsWith('<array>')) {
    const inner = token.slice('<array>'.length, -'</array>'.length)
    return (
      inner.match(/<string>[\s\S]*?<\/string>|<integer>[\s\S]*?<\/integer>|<true\/>|<false\/>/g) ??
      []
    ).map(parseValueToken)
  }
  if (token.startsWith('<dict>')) {
    return parseDictBody(token.slice('<dict>'.length, -'</dict>'.length))
  }
  throw new Error(`Unsupported plist token: ${token}`)
}

function unescapeXml(text) {
  return String(text)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim()
}
