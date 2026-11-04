// Plan 214 B2 (shape fixed after spike P0a): embedding and signing the Videorc
// Camera extension inside Videorc.app. Used by the electron-builder afterPack
// hook (scripts/electron-builder-after-pack-macos.cjs) and by
// scripts/sign-macos-local-app.mjs. The decisions are pure functions with
// tests; `embedCameraExtension` is the one executor and takes its IO injected.
//
// The contract (docs/releases/macos-signing.md, "Videorc Camera"):
// - There is exactly ONE provisioning profile, for the app:
//   VIDEORC_MACOS_PROFILE_APP, a Developer ID profile for dev.theorcdev.videorc
//   carrying com.apple.developer.system-extension.install. The extension
//   embeds NO profile: its entitlements are exactly the app sandbox and the app
//   group, and it must not claim the application or team identifier.
// - Set: the extension is embedded at Contents/Library/SystemExtensions and
//   signed with its two entitlements before the app; the app gets the profile
//   at Contents/embedded.provisionprofile and the restricted keys.
// - Not set: nothing is embedded, no restricted key is signed anywhere, and one
//   log line says why. Never a silent fallback.
// - The retired VIDEORC_MACOS_PROFILE_CAMERA is an error when still set.
// A value is either a path to a .provisionprofile (the local form, `~/` is
// expanded) or the base64 of one (the GitHub secret form).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  closeSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

import {
  CAMERA_EXTENSION_BUILD_DIR,
  appEntitlementsWithCamera,
  cameraExtensionBundleRelativePath,
  cameraExtensionEntitlementProblems,
  cameraExtensionEntitlements,
  entitlementKeysFromPlistXml,
  loadCameraExtensionIdentifiers,
  parsePlistXml,
  plistXml
} from './camera-extension-identifiers.mjs'

export const PROFILE_ENV_APP = 'VIDEORC_MACOS_PROFILE_APP'
/** Plan 214 B0 asked for a second profile; P0a proved the extension needs none. */
export const RETIRED_PROFILE_ENV_CAMERA = 'VIDEORC_MACOS_PROFILE_CAMERA'

export const BASE_APP_ENTITLEMENTS_PATH = 'apps/desktop/build-resources/entitlements.mac.plist'
export const INHERIT_ENTITLEMENTS_PATH =
  'apps/desktop/build-resources/entitlements.mac.inherit.plist'
/** Written on every macOS pack; electron-builder.yml points `mac.entitlements` here. */
export const GENERATED_APP_ENTITLEMENTS_PATH = `${CAMERA_EXTENSION_BUILD_DIR}/entitlements.mac.app.plist`
export const PROFILE_STAGING_DIR = `${CAMERA_EXTENSION_BUILD_DIR}/profiles`

/** Pure. What the profile variable asks for. */
export function cameraProfileDecision(env = {}) {
  const retired = String(env[RETIRED_PROFILE_ENV_CAMERA] ?? '').trim()
  if (retired) {
    return {
      mode: 'error',
      reason: `${RETIRED_PROFILE_ENV_CAMERA} is set but no longer used: the Videorc Camera extension embeds no profile (plan 214 P0a). Remove it from the environment and ~/.videorc-release.env; only ${PROFILE_ENV_APP} is read.`
    }
  }
  const app = String(env[PROFILE_ENV_APP] ?? '').trim()
  if (!app) {
    return { mode: 'skip', reason: `${PROFILE_ENV_APP} not set` }
  }
  return { mode: 'embed', app }
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
 * Pure. The SHA-1 fingerprints (uppercase hex, the form `security
 * find-identity` prints as the identity hash) of every certificate in a
 * profile's DeveloperCertificates array, from `plutil -extract
 * DeveloperCertificates xml1` output. The certificates themselves never leave
 * this function.
 */
export function developerCertificateSha1sFromPlistXml(xml) {
  const sha1s = []
  for (const match of String(xml ?? '').matchAll(/<data>([\s\S]*?)<\/data>/g)) {
    const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
    if (der.length === 0) continue
    sha1s.push(createHash('sha1').update(der).digest('hex').toUpperCase())
  }
  return sha1s
}

/**
 * Pure. Checks what `security cms -D` read out of the app profile.
 * `summary` is { entitlements, expirationDate, provisionedDevices, name,
 * developerCertificateSha1s }. `signingCertificateSha1` is the hash of the
 * Developer ID Application identity that signs this build: the profile must
 * embed that certificate, or AMFI rejects the app, which is what happens
 * after a certificate renewal with a stale profile.
 */
export function profileSummaryProblems(
  summary,
  { identifiers, now = new Date(), signingCertificateSha1 = null } = {}
) {
  if (!identifiers) {
    throw new Error('identifiers are required')
  }
  const problems = []
  const warnings = []
  const entitlements = summary?.entitlements ?? {}
  const keys = identifiers.entitlements
  const expectedAppId = `${identifiers.teamId}.${identifiers.appBundleId}`

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
  if (entitlements[keys.systemExtensionInstall] !== true) {
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
        `expired on ${expires.toISOString().slice(0, 10)}; regenerate it (docs/releases/macos-signing.md, "Renewal")`
      )
    } else if (expires.getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000) {
      warnings.push(`expires on ${expires.toISOString().slice(0, 10)}; renew it soon`)
    }
  } else {
    problems.push('has no expiration date (not a provisioning profile?)')
  }
  const certificates = Array.isArray(summary?.developerCertificateSha1s)
    ? summary.developerCertificateSha1s.map((sha1) => String(sha1).toUpperCase())
    : []
  if (certificates.length === 0) {
    problems.push('lists no DeveloperCertificates (not a provisioning profile?)')
  } else if (signingCertificateSha1) {
    const wanted = String(signingCertificateSha1).toUpperCase()
    if (!certificates.includes(wanted)) {
      problems.push(
        `does not embed the Developer ID Application certificate signing this build (SHA-1 ${wanted}). The profile was generated for another certificate: after a certificate renewal, regenerate the profile and re-set ${PROFILE_ENV_APP} (docs/releases/macos-signing.md, "Renewal")`
      )
    }
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

const MACH_O_MAGICS = new Set([
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'bebafeca'
])

function readMagic(path) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const read = readSync(fd, buffer, 0, 4, 0)
    return buffer.subarray(0, read).toString('hex')
  } finally {
    closeSync(fd)
  }
}

export function isMachOFile(path, { magic = readMagic } = {}) {
  try {
    return MACH_O_MAGICS.has(magic(path))
  } catch {
    return false
  }
}

/**
 * Pure (IO injected). Every nested code object inside the app that must be
 * signed before the app itself: Mach-O files and the .framework and .app
 * bundles under Contents, except the main executable (signed with the app),
 * the Videorc Camera extension (its own step) and symlinks. The same set
 * @electron/osx-sign walks, so the local signer and the release signer agree.
 */
export function collectNestedCodePaths(
  appPath,
  { readdir = readdirSync, lstat = lstatSync, isMachO = isMachOFile } = {}
) {
  const contents = join(appPath, 'Contents')
  const skip = new Set([join(contents, 'MacOS'), join(contents, 'Library', 'SystemExtensions')])
  const entries = []
  const walk = (dir) => {
    for (const name of readdir(dir)) {
      const path = join(dir, name)
      const stat = lstat(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (skip.has(path)) continue
        walk(path)
        if (name.endsWith('.framework')) entries.push({ path, kind: 'framework' })
        else if (name.endsWith('.app')) entries.push({ path, kind: 'app' })
        continue
      }
      if (stat.isFile() && isMachO(path)) entries.push({ path, kind: 'mach-o' })
    }
  }
  walk(contents)
  return orderNestedCodePaths(entries)
}

/**
 * Pure. Inside out: Mach-O files deepest first (dylibs, crashpad, ShipIt,
 * the bare tools), then frameworks deepest first, then helper apps. Within a
 * depth, alphabetical, so the plan is stable.
 */
export function orderNestedCodePaths(entries) {
  const rank = { 'mach-o': 0, framework: 1, app: 2 }
  const depth = (path) => String(path).split(sep).length
  return [...entries].sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind]
    if (depth(a.path) !== depth(b.path)) return depth(b.path) - depth(a.path)
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

/**
 * Pure. The codesign steps for a locally signed app (sign-macos-local-app.mjs),
 * inside out and never --deep: every nested code object with the inherit
 * plist (today's five keys), then the extension with its own two keys, then
 * the app with its plist. --deep with one plist pushed the restricted key into
 * the helpers; with the split it is simply never used.
 */
export function localSignPlan({
  appPath,
  identity,
  nestedCodePaths,
  appEntitlementsPath,
  inheritEntitlementsPath,
  extensionPath = null,
  extensionEntitlementsPath = null
}) {
  const signArgs = (path, entitlements) => [
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
  for (const entry of nestedCodePaths) {
    const path = typeof entry === 'string' ? entry : entry.path
    steps.push({
      label: `nested ${relative(appPath, path)}`,
      args: signArgs(path, inheritEntitlementsPath)
    })
  }
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
  }
  steps.push({ label: 'app (last, no --deep)', args: signArgs(appPath, appEntitlementsPath) })
  for (const step of steps) {
    if (step.args.includes('--deep')) {
      throw new Error(`--deep must never appear in the sign plan (${step.label})`)
    }
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
 * are reduced to SHA-1 fingerprints and never printed.
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
  const certificates = extract('DeveloperCertificates', 'xml1')
  return {
    entitlements: JSON.parse(entitlementsResult.stdout),
    expirationDate: expiration.status === 0 ? expiration.stdout.trim() : null,
    name: name.status === 0 ? name.stdout.trim() : null,
    provisionedDevices: devices.status === 0,
    developerCertificateSha1s:
      certificates.status === 0 ? developerCertificateSha1sFromPlistXml(certificates.stdout) : []
  }
}

/** The identity hash is the certificate's SHA-1, which is what the profile check needs. */
export function signingCertificateSha1FromIdentity(identity) {
  const value = String(identity ?? '').trim()
  return /^[0-9A-Fa-f]{40}$/.test(value) ? value.toUpperCase() : null
}

/**
 * The executor. Writes the generated app entitlements on every call (base
 * keys, or base plus camera keys when embedding) and returns what happened.
 * `identity` must be the SHA-1 hash from `security find-identity` so the
 * profile can be checked against the signing certificate.
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

  const decision = cameraProfileDecision(env)
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
      'Videorc Camera: the app profile is configured but no Developer ID Application identity was found to sign the extension.'
    )
  }
  const signingCertificateSha1 = signingCertificateSha1FromIdentity(identity)
  if (!signingCertificateSha1) {
    throw new Error(
      'Videorc Camera: pass the signing identity as its SHA-1 hash (security find-identity -v -p codesigning) so the profile can be checked against the certificate.'
    )
  }

  const builtBundle = join(
    repoRoot,
    CAMERA_EXTENSION_BUILD_DIR,
    `${identifiers.extensionBundleId}.systemextension`
  )
  if (!fs.exists(builtBundle)) {
    throw new Error(
      `Videorc Camera: ${builtBundle} is missing. Build it with: pnpm build:camera-extension`
    )
  }
  if (fs.exists(join(builtBundle, 'Contents', 'embedded.provisionprofile'))) {
    throw new Error(
      'Videorc Camera: the built extension carries an embedded.provisionprofile; the extension embeds no profile (plan 214 P0a). Rebuild it with: pnpm build:camera-extension'
    )
  }

  const staging = join(repoRoot, PROFILE_STAGING_DIR)
  fs.mkdir(staging)
  let bytes
  try {
    bytes = decodeProfileValue(decision.app, { exists: fs.exists, readFile: fs.readFile })
  } catch (error) {
    throw new Error(`${PROFILE_ENV_APP}: ${error.message}`)
  }
  const profilePath = join(staging, 'app.provisionprofile')
  const decodedPath = join(staging, 'app.plist')
  fs.writeFile(profilePath, bytes)
  fs.chmod(profilePath, 0o600)
  const summary = readProfileSummary(profilePath, decodedPath, { run })
  fs.chmod(decodedPath, 0o600)
  const { problems, warnings } = profileSummaryProblems(summary, {
    identifiers,
    now,
    signingCertificateSha1
  })
  for (const warning of warnings) {
    log(`Videorc Camera: ${PROFILE_ENV_APP} ${warning}`)
  }
  if (problems.length > 0) {
    throw new Error(
      `${PROFILE_ENV_APP} is not the app profile plan 214 asks for:\n  ${problems.join('\n  ')}`
    )
  }
  log(
    `Videorc Camera: ${PROFILE_ENV_APP} ok (${summary.name ?? 'unnamed profile'}, expires ${summary.expirationDate ?? 'unknown'}, embeds the signing certificate)`
  )

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
  fs.copy(profilePath, join(appPath, 'Contents', 'embedded.provisionprofile'))

  const extensionEntitlementsPath = join(
    repoRoot,
    CAMERA_EXTENSION_BUILD_DIR,
    `${identifiers.extensionBundleId}.entitlements`
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
  const shown = run('codesign', ['-d', '--entitlements', ':-', extensionPath])
  const entitlementProblems = cameraExtensionEntitlementProblems(
    entitlementKeysFromPlistXml(`${shown.stdout}\n${shown.stderr}`),
    identifiers
  )
  if (shown.status !== 0 || entitlementProblems.length > 0) {
    throw new Error(
      `the signed camera extension has the wrong entitlements:\n  ${entitlementProblems.join('\n  ') || shown.stderr.trim()}`
    )
  }

  writeAppEntitlements(appEntitlementsWithCamera(baseEntitlements, identifiers))
  log(
    `Videorc Camera embedded at ${cameraExtensionBundleRelativePath(identifiers)} (${version}), signed with the app sandbox and the app group only; the app entitlements now carry ${identifiers.entitlements.systemExtensionInstall} and the app group.`
  )
  return {
    embedded: true,
    extensionPath,
    extensionEntitlementsPath,
    appEntitlementsPath: generatedPath
  }
}
