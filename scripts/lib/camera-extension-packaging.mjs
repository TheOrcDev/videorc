// Plan 214 B2: embedding and signing the Videorc Camera extension inside
// Videorc.app. Used by the electron-builder afterPack hook
// (scripts/electron-builder-after-pack-macos.cjs) and by
// scripts/sign-macos-local-app.mjs. The decisions are pure functions with
// tests; `embedCameraExtension` is the one executor and takes its IO injected.
//
// The contract (docs/releases/macos-signing.md, "Videorc Camera"):
// - Both VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA set: the
//   extension is embedded at Contents/Library/SystemExtensions with its own
//   embedded.provisionprofile and entitlements and signed before the app; the
//   app gets its profile and the restricted keys in its entitlements.
// - Neither set: nothing is embedded, no restricted key is signed anywhere,
//   and one log line says why. Never a silent fallback.
// - One set without the other: an error.
// A value is either a path to a .provisionprofile (the local form, `~/` is
// expanded) or the base64 of one (the GitHub secret form).
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  CAMERA_EXTENSION_BUILD_DIR,
  appEntitlementsWithCamera,
  cameraExtensionBundleRelativePath,
  cameraExtensionEntitlements,
  loadCameraExtensionIdentifiers,
  parsePlistXml,
  plistXml
} from './camera-extension-identifiers.mjs'

export const PROFILE_ENV_APP = 'VIDEORC_MACOS_PROFILE_APP'
export const PROFILE_ENV_CAMERA = 'VIDEORC_MACOS_PROFILE_CAMERA'
export const CAMERA_PROFILE_ENVS = [PROFILE_ENV_APP, PROFILE_ENV_CAMERA]

export const BASE_APP_ENTITLEMENTS_PATH = 'apps/desktop/build-resources/entitlements.mac.plist'
export const INHERIT_ENTITLEMENTS_PATH =
  'apps/desktop/build-resources/entitlements.mac.inherit.plist'
/** Written on every macOS pack; electron-builder.yml points `mac.entitlements` here. */
export const GENERATED_APP_ENTITLEMENTS_PATH = `${CAMERA_EXTENSION_BUILD_DIR}/entitlements.mac.app.plist`
export const PROFILE_STAGING_DIR = `${CAMERA_EXTENSION_BUILD_DIR}/profiles`

/** Pure. What the two profile variables ask for. */
export function cameraProfilesDecision(env = {}) {
  const app = String(env[PROFILE_ENV_APP] ?? '').trim()
  const camera = String(env[PROFILE_ENV_CAMERA] ?? '').trim()
  if (!app && !camera) {
    return { mode: 'skip', reason: `${PROFILE_ENV_APP} and ${PROFILE_ENV_CAMERA} not set` }
  }
  if (!app || !camera) {
    const missing = app ? PROFILE_ENV_CAMERA : PROFILE_ENV_APP
    const present = app ? PROFILE_ENV_APP : PROFILE_ENV_CAMERA
    return {
      mode: 'error',
      reason: `${missing} is not set but ${present} is. Set both (the app profile and the camera profile, plan 214 B0) or neither.`
    }
  }
  return { mode: 'embed', app, camera }
}

/** Pure. The one line a no-profile build logs. */
export function cameraSkippedLogLine(reason) {
  return `Videorc Camera skipped: ${reason}. The extension is not embedded and no restricted entitlement is signed.`
}

/**
 * Pure (IO injected). A profile value is a path to a .provisionprofile or the
 * base64 of one. Returns the profile bytes.
 */
export function decodeProfileValue(
  value,
  { exists = existsSync, readFile = readFileSync, homeDir = homedir() } = {}
) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) {
    throw new Error('profile value is empty')
  }
  const candidate = trimmed.startsWith('~/') ? join(homeDir, trimmed.slice(2)) : trimmed
  if ((isAbsolute(candidate) || trimmed.startsWith('~/')) && exists(candidate)) {
    return readFile(candidate)
  }
  if (/[/\\]/.test(trimmed) && !/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    throw new Error(`profile path does not exist: ${candidate}`)
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    throw new Error('profile value is neither an existing .provisionprofile path nor base64')
  }
  const bytes = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64')
  if (bytes.length < 64 || bytes[0] !== 0x30) {
    throw new Error(
      'profile value does not decode to a CMS provisioning profile (expected a DER SEQUENCE)'
    )
  }
  return bytes
}

/**
 * Pure. Checks what `security cms -D` read out of a profile against the role.
 * `summary` is { entitlements, expirationDate, provisionedDevices, name }.
 */
export function profileSummaryProblems(summary, { role, identifiers, now = new Date() }) {
  if (role !== 'app' && role !== 'camera') {
    throw new Error(`Unknown profile role: ${role}`)
  }
  const problems = []
  const warnings = []
  const entitlements = summary?.entitlements ?? {}
  const keys = identifiers.entitlements
  const expectedAppId = `${identifiers.teamId}.${role === 'app' ? identifiers.appBundleId : identifiers.extensionBundleId}`

  const team = entitlements[keys.teamIdentifier]
  if (team !== identifiers.teamId) {
    problems.push(
      `team identifier is ${JSON.stringify(team ?? null)}, expected ${identifiers.teamId}`
    )
  }
  const appId = entitlements[keys.applicationIdentifier]
  if (appId !== expectedAppId) {
    problems.push(
      `application identifier is ${JSON.stringify(appId ?? null)}, expected ${expectedAppId}`
    )
  }
  const groups = entitlements[keys.applicationGroups]
  if (!Array.isArray(groups) || !groups.includes(identifiers.appGroup)) {
    problems.push(
      `app groups ${JSON.stringify(groups ?? null)} do not include ${identifiers.appGroup}`
    )
  }
  if (role === 'app' && entitlements[keys.systemExtensionInstall] !== true) {
    problems.push(
      `does not grant ${keys.systemExtensionInstall} (enable System Extension on the App ID in the Apple portal and regenerate the Developer ID profile)`
    )
  }
  if (summary?.expirationDate) {
    const expires = new Date(summary.expirationDate)
    if (Number.isNaN(expires.getTime())) {
      problems.push(`expiration date is unreadable: ${summary.expirationDate}`)
    } else if (expires.getTime() <= now.getTime()) {
      problems.push(
        `expired on ${expires.toISOString().slice(0, 10)}; regenerate it in the Apple portal`
      )
    } else if (expires.getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000) {
      warnings.push(`expires on ${expires.toISOString().slice(0, 10)}; renew it soon`)
    }
  } else {
    problems.push('has no expiration date (not a provisioning profile?)')
  }
  if (summary?.provisionedDevices) {
    warnings.push(
      'lists provisioned devices: this is a Development profile, not a Developer ID profile. It cannot ship and activates only with SIP off.'
    )
  }
  return { problems, warnings }
}

/** Pure. The hash of the identity to sign with, from `security find-identity -v -p codesigning`. */
export function pickSigningIdentity(findIdentityOutput, { preferred } = {}) {
  const identities = []
  for (const line of String(findIdentityOutput ?? '').split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line)
    if (match) {
      identities.push({ hash: match[1], name: match[2] })
    }
  }
  const wanted = String(preferred ?? '').trim()
  if (wanted) {
    const exact = identities.find(
      (identity) => identity.name === wanted || identity.hash === wanted
    )
    if (exact) return exact
    const partial = identities.find((identity) => identity.name.includes(wanted))
    if (partial) return partial
    return null
  }
  return (
    identities.find((identity) => identity.name.startsWith('Developer ID Application:')) ?? null
  )
}

/** Pure. codesign arguments for the extension bundle (its own entitlements, hardened, timestamped). */
export function extensionSignArgs({ bundlePath, entitlementsPath, identity, keychain }) {
  return [
    '--force',
    '--options',
    'runtime',
    '--timestamp',
    '--entitlements',
    entitlementsPath,
    '--sign',
    identity,
    ...(keychain ? ['--keychain', keychain] : []),
    bundlePath
  ]
}

/**
 * Pure. The codesign steps for a locally signed app (sign-macos-local-app.mjs).
 * Without the extension: the tools, then the app with --deep (one plist, as
 * before the camera). With it: tools and the deep pass carry the inherit
 * plist, the extension gets its own, and a final shallow pass gives the app
 * its plist and re-seals the nested extension.
 */
export function localSignPlan({
  appPath,
  identity,
  toolPaths,
  appEntitlementsPath,
  inheritEntitlementsPath,
  extensionPath = null,
  extensionEntitlementsPath = null
}) {
  const toolArgs = (path, entitlements) => [
    '--force',
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    '--sign',
    identity,
    path
  ]
  const steps = []
  const toolEntitlements = extensionPath ? inheritEntitlementsPath : appEntitlementsPath
  for (const toolPath of toolPaths) {
    steps.push({ label: `tool ${toolPath}`, args: toolArgs(toolPath, toolEntitlements) })
  }
  steps.push({
    label: 'app (deep)',
    args: ['--force', '--deep', ...toolArgs(appPath, toolEntitlements).slice(1)]
  })
  if (extensionPath) {
    if (!extensionEntitlementsPath) {
      throw new Error('extensionEntitlementsPath is required when the extension is embedded')
    }
    steps.push({
      label: 'camera extension',
      args: extensionSignArgs({
        bundlePath: extensionPath,
        entitlementsPath: extensionEntitlementsPath,
        identity
      })
    })
    steps.push({
      label: 'app (shallow, app entitlements)',
      args: toolArgs(appPath, appEntitlementsPath)
    })
  }
  return steps
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const defaultFs = {
  exists: existsSync,
  readFile: readFileSync,
  writeFile: writeFileSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  copy: (from, to) => cpSync(from, to, { recursive: true }),
  chmod: chmodSync
}

/**
 * Reads a profile with `security cms -D` and `plutil` into a plain summary.
 * The decoded plist is written beside the profile; the certificates it holds
 * are never printed.
 */
export function readProfileSummary(profilePath, decodedPath, { run = defaultRun } = {}) {
  const decode = run('security', ['cms', '-D', '-i', profilePath, '-o', decodedPath])
  if (decode.status !== 0) {
    throw new Error(
      `security cms could not decode ${profilePath}: ${decode.stderr.trim() || 'unknown error'}`
    )
  }
  const extract = (key, format) => run('plutil', ['-extract', key, format, '-o', '-', decodedPath])
  const entitlementsResult = extract('Entitlements', 'json')
  if (entitlementsResult.status !== 0) {
    throw new Error(`profile ${profilePath} has no Entitlements dictionary`)
  }
  const expiration = extract('ExpirationDate', 'raw')
  const name = extract('Name', 'raw')
  const devices = extract('ProvisionedDevices', 'json')
  return {
    entitlements: JSON.parse(entitlementsResult.stdout),
    expirationDate: expiration.status === 0 ? expiration.stdout.trim() : null,
    name: name.status === 0 ? name.stdout.trim() : null,
    provisionedDevices: devices.status === 0
  }
}

/**
 * The executor. Writes the generated app entitlements on every call (base
 * keys, or base plus camera keys when embedding) and returns what happened.
 */
export async function embedCameraExtension({
  appPath,
  repoRoot,
  env = process.env,
  version,
  buildVersion = version,
  identity = null,
  keychain = null,
  unsignedReason = null,
  log = console.log,
  run = defaultRun,
  fs = defaultFs,
  now = new Date()
}) {
  const identifiers = loadCameraExtensionIdentifiers(repoRoot, { readFile: fs.readFile })
  const baseEntitlements = parsePlistXml(
    fs.readFile(join(repoRoot, BASE_APP_ENTITLEMENTS_PATH), 'utf8')
  )
  const generatedPath = join(repoRoot, GENERATED_APP_ENTITLEMENTS_PATH)
  const writeAppEntitlements = (entitlements) => {
    fs.mkdir(join(repoRoot, CAMERA_EXTENSION_BUILD_DIR))
    fs.writeFile(generatedPath, plistXml(entitlements))
  }

  const decision = cameraProfilesDecision(env)
  if (decision.mode === 'error') {
    throw new Error(decision.reason)
  }
  if (decision.mode === 'skip') {
    writeAppEntitlements(baseEntitlements)
    log(cameraSkippedLogLine(decision.reason))
    return { embedded: false, reason: decision.reason, appEntitlementsPath: generatedPath }
  }
  if (unsignedReason) {
    writeAppEntitlements(baseEntitlements)
    log(cameraSkippedLogLine(unsignedReason))
    return { embedded: false, reason: unsignedReason, appEntitlementsPath: generatedPath }
  }
  if (!identity) {
    throw new Error(
      'Videorc Camera: both profiles are configured but no Developer ID Application identity was found to sign the extension.'
    )
  }

  const builtBundle = join(
    repoRoot,
    CAMERA_EXTENSION_BUILD_DIR,
    `${identifiers.extensionBundleName}.systemextension`
  )
  if (!fs.exists(builtBundle)) {
    throw new Error(
      `Videorc Camera: ${builtBundle} is missing. Build it with: pnpm build:camera-extension`
    )
  }

  const staging = join(repoRoot, PROFILE_STAGING_DIR)
  fs.mkdir(staging)
  const profiles = {}
  for (const [role, value] of [
    ['app', decision.app],
    ['camera', decision.camera]
  ]) {
    const envName = role === 'app' ? PROFILE_ENV_APP : PROFILE_ENV_CAMERA
    let bytes
    try {
      bytes = decodeProfileValue(value, { exists: fs.exists, readFile: fs.readFile })
    } catch (error) {
      throw new Error(`${envName}: ${error.message}`)
    }
    const profilePath = join(staging, `${role}.provisionprofile`)
    const decodedPath = join(staging, `${role}.plist`)
    fs.writeFile(profilePath, bytes)
    fs.chmod(profilePath, 0o600)
    const summary = readProfileSummary(profilePath, decodedPath, { run })
    fs.chmod(decodedPath, 0o600)
    const { problems, warnings } = profileSummaryProblems(summary, { role, identifiers, now })
    for (const warning of warnings) {
      log(`Videorc Camera: ${envName} ${warning}`)
    }
    if (problems.length > 0) {
      throw new Error(
        `${envName} is not the ${role} profile plan 214 B0 asks for:\n  ${problems.join('\n  ')}`
      )
    }
    profiles[role] = profilePath
    log(
      `Videorc Camera: ${envName} ok (${summary.name ?? 'unnamed profile'}, expires ${summary.expirationDate ?? 'unknown'})`
    )
  }

  const extensionPath = join(appPath, cameraExtensionBundleRelativePath(identifiers))
  fs.rm(extensionPath)
  fs.mkdir(join(appPath, 'Contents', 'Library', 'SystemExtensions'))
  fs.copy(builtBundle, extensionPath)
  // Match the app's versions so an update replaces the extension (the replace
  // delegate fires when CFBundleVersion or CFBundleShortVersionString differ).
  for (const [key, value] of [
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', buildVersion]
  ]) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`Videorc Camera: a ${key} value is required to stamp the extension`)
    }
    const replaced = run('plutil', [
      '-replace',
      key,
      '-string',
      value,
      join(extensionPath, 'Contents', 'Info.plist')
    ])
    if (replaced.status !== 0) {
      throw new Error(`plutil could not set ${key} on the extension: ${replaced.stderr.trim()}`)
    }
  }
  fs.copy(profiles.camera, join(extensionPath, 'Contents', 'embedded.provisionprofile'))
  fs.copy(profiles.app, join(appPath, 'Contents', 'embedded.provisionprofile'))

  const extensionEntitlementsPath = join(
    repoRoot,
    CAMERA_EXTENSION_BUILD_DIR,
    `${identifiers.extensionBundleName}.entitlements`
  )
  fs.writeFile(extensionEntitlementsPath, plistXml(cameraExtensionEntitlements(identifiers)))
  const signed = run(
    'codesign',
    extensionSignArgs({
      bundlePath: extensionPath,
      entitlementsPath: extensionEntitlementsPath,
      identity,
      keychain
    })
  )
  if (signed.status !== 0) {
    throw new Error(
      `codesign failed on the camera extension: ${signed.stderr.trim() || signed.stdout.trim()}`
    )
  }
  const verified = run('codesign', ['--verify', '--strict', '--verbose=2', extensionPath])
  if (verified.status !== 0) {
    throw new Error(`the signed camera extension does not verify: ${verified.stderr.trim()}`)
  }

  writeAppEntitlements(appEntitlementsWithCamera(baseEntitlements, identifiers))
  log(
    `Videorc Camera embedded at ${cameraExtensionBundleRelativePath(identifiers)} (${version}), signed with its profile; the app entitlements now carry ${identifiers.entitlements.systemExtensionInstall} and the app group.`
  )
  return {
    embedded: true,
    extensionPath,
    extensionEntitlementsPath,
    appEntitlementsPath: generatedPath
  }
}
