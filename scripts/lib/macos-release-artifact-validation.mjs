import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cameraExtensionBundleRelativePath,
  cameraExtensionEntitlementKeys,
  cameraExtensionForbiddenEntitlementKeys,
  entitlementKeysFromPlistXml,
  loadCameraExtensionIdentifiers,
  parsePlistXml,
  restrictedCameraEntitlementKeys
} from './camera-extension-identifiers.mjs'

export function artifactKindFromPath(path) {
  if (String(path).endsWith('.app')) {
    return 'app'
  }
  if (String(path).endsWith('.dmg')) {
    return 'dmg'
  }
  return null
}

// Hardened-runtime AV capture requires these on every binary that touches the
// camera/microphone; a TCC grant cannot override a missing entitlement. 0.9.1
// shipped without them (camera dead in the packaged app), so the validator now
// fails closed when any capture binary lacks them.
export const REQUIRED_CAPTURE_ENTITLEMENTS = [
  'com.apple.security.device.camera',
  'com.apple.security.device.audio-input'
]

export const EXPECTED_MACOS_BUNDLE_IDENTIFIER = 'dev.theorcdev.videorc'

// Plan 214 B5, shape fixed by spike P0a: the Videorc Camera extension. A
// release must embed it at Contents/Library/SystemExtensions, signed with
// exactly two entitlements (app sandbox, app group) and NO profile; the app
// must embed the one Developer ID profile and carry the restricted
// system-extension key and the app group; every other binary (Electron's
// helpers, crashpad, ShipIt, the bare tools) keeps exactly the five inherit
// keys, because a binary without a profile dies at exec with any restricted
// key. A release built without the profile fails these checks by design: it
// must never ship.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CAMERA_EXTENSION_IDENTIFIERS = loadCameraExtensionIdentifiers(REPO_ROOT)
export const CAMERA_EXTENSION_RELATIVE_PATH = cameraExtensionBundleRelativePath(
  CAMERA_EXTENSION_IDENTIFIERS
)
/** The keys only the main executable may carry. */
export const RESTRICTED_CAMERA_ENTITLEMENTS = restrictedCameraEntitlementKeys(
  CAMERA_EXTENSION_IDENTIFIERS
)
/** Exactly what the extension's signature must show. */
export const CAMERA_EXTENSION_ENTITLEMENT_KEYS = cameraExtensionEntitlementKeys(
  CAMERA_EXTENSION_IDENTIFIERS
)
export const CAMERA_EXTENSION_FORBIDDEN_ENTITLEMENTS = cameraExtensionForbiddenEntitlementKeys(
  CAMERA_EXTENSION_IDENTIFIERS
)
export const CAMERA_EXTENSION_REQUIRED_ENTITLEMENTS = [
  ...CAMERA_EXTENSION_ENTITLEMENT_KEYS,
  CAMERA_EXTENSION_IDENTIFIERS.appGroup
]
/** The five keys of entitlements.mac.inherit.plist: every nested binary, exactly. */
export const INHERIT_ENTITLEMENT_KEYS = Object.keys(
  parsePlistXml(
    readFileSync(
      join(REPO_ROOT, 'apps', 'desktop', 'build-resources', 'entitlements.mac.inherit.plist'),
      'utf8'
    )
  )
).sort()
export const APP_EMBEDDED_PROFILE_RELATIVE_PATH = 'Contents/embedded.provisionprofile'

/** The bare binaries that must never claim the restricted keys. */
export function bareBinaryCheckTargets(appPath) {
  return [
    ...captureEntitlementCheckTargets(appPath).filter((target) => target.id !== 'app'),
    {
      id: 'native-preview-addon',
      label: 'videorc_native_preview.node',
      path: `${appPath}/Contents/Resources/videorc_native_preview.node`
    }
  ]
}

/**
 * Electron's nested executables. They run as their own processes without a
 * profile, so they keep the inherit keys exactly like the bare tools.
 */
export function nestedExecutableCheckTargets(appPath) {
  const frameworks = `${appPath}/Contents/Frameworks`
  return [
    ...[
      'Videorc Helper',
      'Videorc Helper (GPU)',
      'Videorc Helper (Plugin)',
      'Videorc Helper (Renderer)'
    ].map((name) => ({
      id: `helper-${
        name
          .replace(/^Videorc Helper ?/, '')
          .replace(/[()]/g, '')
          .toLowerCase() || 'main'
      }`,
      label: `${name}.app`,
      path: `${frameworks}/${name}.app`
    })),
    {
      id: 'crashpad-handler',
      label: 'chrome_crashpad_handler',
      path: `${frameworks}/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`
    },
    {
      id: 'shipit',
      label: 'ShipIt',
      path: `${frameworks}/Squirrel.framework/Versions/A/Resources/ShipIt`
    }
  ]
}

export function cameraExtensionCheckTargets(appPath) {
  const identifiers = CAMERA_EXTENSION_IDENTIFIERS
  const extension = `${appPath}/${CAMERA_EXTENSION_RELATIVE_PATH}`
  const extensionInfoPlist = `${extension}/Contents/Info.plist`
  const plutil = (key, expectation) => ({
    command: 'plutil',
    args: ['-extract', key, 'raw', '-expect', 'string', '-n', '-o', '-', extensionInfoPlist],
    ...expectation
  })
  return [
    {
      id: 'camera-extension-bundle-identifier',
      label: 'Videorc Camera extension Info.plist bundle identifier',
      ...plutil('CFBundleIdentifier', { expectStdoutEquals: identifiers.extensionBundleId })
    },
    {
      id: 'camera-extension-package-type',
      label: 'Videorc Camera extension package type (SYSX)',
      ...plutil('CFBundlePackageType', { expectStdoutEquals: 'SYSX' })
    },
    {
      id: 'camera-extension-mach-service',
      label: 'Videorc Camera extension CMIOExtensionMachServiceName',
      ...plutil('CMIOExtension.CMIOExtensionMachServiceName', {
        expectStdoutEquals: identifiers.machServiceName
      })
    },
    {
      id: 'camera-extension-usage-description',
      label: 'Videorc Camera extension usage description',
      ...plutil('NSSystemExtensionUsageDescription', { expectStdoutNonEmpty: true })
    },
    {
      id: 'camera-extension-signature',
      label: 'Videorc Camera extension signature',
      command: 'codesign',
      args: ['--verify', '--strict', '--verbose=2', extension]
    },
    {
      id: 'camera-extension-entitlements',
      label: 'Videorc Camera extension entitlements (exactly sandbox + app group)',
      command: 'codesign',
      args: ['-d', '--entitlements', ':-', extension],
      expectOutputIncludes: CAMERA_EXTENSION_REQUIRED_ENTITLEMENTS,
      expectEntitlementKeys: CAMERA_EXTENSION_ENTITLEMENT_KEYS,
      expectOutputExcludes: CAMERA_EXTENSION_FORBIDDEN_ENTITLEMENTS
    },
    {
      id: 'camera-extension-no-profile',
      label: 'Videorc Camera extension embeds no profile',
      type: 'path-absent',
      path: `${extension}/Contents/embedded.provisionprofile`
    },
    {
      id: 'app-profile',
      label: 'app embedded profile (Videorc Camera)',
      command: 'security',
      args: ['cms', '-D', '-i', `${appPath}/${APP_EMBEDDED_PROFILE_RELATIVE_PATH}`],
      expectOutputIncludes: [
        `${identifiers.teamId}.${identifiers.appBundleId}`,
        identifiers.entitlements.systemExtensionInstall
      ]
    },
    {
      id: 'single-embedded-profile',
      label: 'one embedded profile, in the app only',
      type: 'single-embedded-profile',
      path: appPath
    },
    {
      id: 'restricted-entitlements-app',
      label: 'system extension entitlements (app)',
      command: 'codesign',
      args: ['-d', '--entitlements', ':-', appPath],
      expectOutputIncludes: [
        identifiers.entitlements.systemExtensionInstall,
        identifiers.entitlements.applicationGroups,
        identifiers.appGroup
      ]
    },
    // Executables show exactly the inherit keys. The .node addon is a Mach-O
    // bundle, not an executable: codesign embeds no entitlements into it at
    // all, so it is only checked for the restricted keys (none may appear).
    ...[...bareBinaryCheckTargets(appPath), ...nestedExecutableCheckTargets(appPath)].map(
      (target) =>
        target.id === 'native-preview-addon'
          ? {
              id: `no-restricted-entitlements-${target.id}`,
              label: `no restricted entitlement (${target.label})`,
              command: 'codesign',
              args: ['-d', '--entitlements', ':-', target.path],
              expectOutputExcludes: RESTRICTED_CAMERA_ENTITLEMENTS
            }
          : {
              id: `no-restricted-entitlements-${target.id}`,
              label: `inherit entitlements only (${target.label})`,
              command: 'codesign',
              args: ['-d', '--entitlements', ':-', target.path],
              expectEntitlementKeys: INHERIT_ENTITLEMENT_KEYS,
              expectOutputExcludes: RESTRICTED_CAMERA_ENTITLEMENTS
            }
    )
  ]
}

/** Pure. Lines for every forbidden needle a command printed. */
export function outputExclusionFailures(check, output) {
  const text = String(output ?? '')
  return (check.expectOutputExcludes ?? [])
    .filter((needle) => text.includes(needle))
    .map((needle) => `forbidden entitlement present: ${needle}`)
}

/**
 * Pure. Lines when the entitlement keys a `codesign -d --entitlements :-`
 * printed are not exactly the expected set.
 */
export function entitlementKeyFailures(check, output) {
  if (!Array.isArray(check.expectEntitlementKeys)) {
    return []
  }
  const expected = [...check.expectEntitlementKeys].sort()
  const actual = entitlementKeysFromPlistXml(output)
  const missing = expected.filter((key) => !actual.includes(key))
  const extra = actual.filter((key) => !expected.includes(key))
  return [
    ...missing.map((key) => `missing entitlement: ${key}`),
    ...extra.map((key) => `unexpected entitlement: ${key}`)
  ]
}

/** Pure (IO injected). A file that must not exist. */
export function evaluatePathAbsentCheck(check, { exists = existsSync } = {}) {
  if (check.type !== 'path-absent') {
    throw new Error(`Unsupported release validation check type: ${check.type}`)
  }
  return exists(check.path)
    ? { ok: false, output: `${check.path} exists; it must not` }
    : { ok: true, output: '' }
}

/** Every embedded.provisionprofile inside a bundle, relative to it (symlinks skipped). */
export function findEmbeddedProfiles(
  bundlePath,
  { readdir = readdirSync, lstat = lstatSync } = {}
) {
  const found = []
  const walk = (dir) => {
    for (const name of readdir(dir)) {
      const path = join(dir, name)
      const stat = lstat(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(path)
      else if (name === 'embedded.provisionprofile') found.push(relative(bundlePath, path))
    }
  }
  walk(bundlePath)
  return found.sort()
}

/**
 * Pure (IO injected). Exactly one embedded profile in the whole bundle, the
 * app's own. One in the extension or a helper would be a stale B0 shape.
 */
export function evaluateSingleEmbeddedProfileCheck(
  check,
  { profiles = findEmbeddedProfiles } = {}
) {
  if (check.type !== 'single-embedded-profile') {
    throw new Error(`Unsupported release validation check type: ${check.type}`)
  }
  const found = profiles(check.path)
  const expected = [APP_EMBEDDED_PROFILE_RELATIVE_PATH]
  if (found.length === 1 && found[0] === expected[0]) {
    return { ok: true, output: '' }
  }
  return {
    ok: false,
    output: `expected exactly one embedded profile at ${expected[0]}, found ${found.length === 0 ? 'none' : found.join(', ')}`
  }
}

// One shared entitlements plist signs the app and every bundled tool, so all of
// them must carry the device entitlements (paths mirror
// scripts/sign-macos-local-app.mjs and electron-builder extraResources).
export function captureEntitlementCheckTargets(appPath) {
  return [
    { id: 'app', label: 'app', path: appPath },
    {
      id: 'videorc-backend',
      label: 'videorc-backend',
      path: `${appPath}/Contents/Resources/videorc-backend`
    },
    {
      id: 'native-preview-host-helper',
      label: 'native_preview_host_helper',
      path: `${appPath}/Contents/Resources/native_preview_host_helper`
    },
    // Plan 209 S4: the stdio bridge is signed with the same plist as the
    // helper, so the same check proves it is present, signed and entitled.
    {
      id: 'videorc-mcp',
      label: 'videorc-mcp',
      path: `${appPath}/Contents/Resources/videorc-mcp`
    },
    { id: 'ffmpeg', label: 'ffmpeg', path: `${appPath}/Contents/Resources/ffmpeg/bin/ffmpeg` },
    { id: 'ffprobe', label: 'ffprobe', path: `${appPath}/Contents/Resources/ffmpeg/bin/ffprobe` }
  ]
}

// Native X Live is dead in a release whose backend lacks the baked OAuth 1.0a
// consumer pair (users would see "Credentials needed" instead of Authorize X
// Live), so the validator fails closed on both halves — same mechanism as the
// baked YouTube pair below.
export const BUNDLED_X_OAUTH1_CONSUMER_ENVS = [
  'VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY',
  'VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_SECRET'
]

export function bundledXOauth1ConsumerCheckTargets(appPath) {
  return BUNDLED_X_OAUTH1_CONSUMER_ENVS.map((envName) => ({
    id: `bundled-x-oauth1-${envName.endsWith('KEY') ? 'consumer-key' : 'consumer-secret'}`,
    label: `bundled X OAuth1 ${envName.endsWith('KEY') ? 'consumer key' : 'consumer secret'} (videorc-backend)`,
    type: 'binary-contains-env-secret',
    envName,
    path: `${appPath}/Contents/Resources/videorc-backend`
  }))
}

// YouTube sign-in (Google approved youtube.force-ssl on 2026-09-30) is dead in
// a release whose backend lacks the baked Desktop client pair: Google refuses
// the token exchange without the secret even with PKCE (#182).
export const BUNDLED_YOUTUBE_OAUTH_ENVS = [
  'VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID',
  'VIDEORC_BUNDLED_YOUTUBE_CLIENT_SECRET'
]

export function bundledYoutubeOauthCheckTargets(appPath) {
  return BUNDLED_YOUTUBE_OAUTH_ENVS.map((envName) => ({
    id: `bundled-youtube-oauth-${envName.endsWith('ID') ? 'client-id' : 'client-secret'}`,
    label: `bundled YouTube OAuth ${envName.endsWith('ID') ? 'client ID' : 'client secret'} (videorc-backend)`,
    type: 'binary-contains-env-secret',
    envName,
    path: `${appPath}/Contents/Resources/videorc-backend`
  }))
}

// Kick (plan 063): the client secret is baked into the Rust backend only (the
// token exchange runs there). It must never reach the Electron bundle, where
// app.asar is a plain archive anyone can unzip. An unset release env means
// Kick ships dark and there is nothing to leak.
export const BUNDLED_KICK_CLIENT_SECRET_ENV = 'VIDEORC_BUNDLED_KICK_CLIENT_SECRET'

export function bundledKickSecretLeakCheckTargets(appPath) {
  return [
    {
      id: 'bundled-kick-client-secret-not-in-asar',
      label: 'bundled Kick client secret absent from app.asar',
      type: 'file-excludes-env-secret',
      envName: BUNDLED_KICK_CLIENT_SECRET_ENV,
      path: `${appPath}/Contents/Resources/app.asar`
    }
  ]
}

export function evaluateFileExcludesEnvSecretCheck(
  check,
  { env = process.env, readFile = readFileSync } = {}
) {
  if (check.type !== 'file-excludes-env-secret') {
    throw new Error(`Unsupported release validation check type: ${check.type}`)
  }
  const secret = typeof env[check.envName] === 'string' ? env[check.envName].trim() : ''
  if (!secret) {
    return { ok: true, output: '' }
  }
  let contents
  try {
    contents = readFile(check.path)
  } catch (error) {
    return {
      ok: false,
      output: `could not read ${check.path}: ${error?.message ?? 'unknown error'}`
    }
  }
  return contents.includes(Buffer.from(secret, 'utf8'))
    ? {
        ok: false,
        output: `${check.path} contains the ${check.envName} value in plain text`
      }
    : { ok: true, output: '' }
}

export function evaluateBinaryContainsEnvSecretCheck(
  check,
  { env = process.env, readFile = readFileSync } = {}
) {
  if (check.type !== 'binary-contains-env-secret') {
    throw new Error(`Unsupported release validation check type: ${check.type}`)
  }

  const envName = check.envName
  const secret = typeof env[envName] === 'string' ? env[envName].trim() : ''
  if (!secret) {
    return {
      ok: false,
      output: `missing required environment variable: ${envName}`
    }
  }

  let binary
  try {
    binary = readFile(check.path)
  } catch (error) {
    return {
      ok: false,
      output: `could not read ${check.path}: ${error?.message ?? 'unknown error'}`
    }
  }

  return binary.includes(Buffer.from(secret, 'utf8'))
    ? { ok: true, output: '' }
    : {
        ok: false,
        output: `${check.path} does not contain the ${envName} value from the release environment`
      }
}

export function stdoutExpectationFailures(check, stdout) {
  const value = String(stdout ?? '')
  const failures = []

  if (check.expectStdoutEquals !== undefined && value !== check.expectStdoutEquals) {
    failures.push(
      `expected stdout exactly ${JSON.stringify(check.expectStdoutEquals)}, got ${JSON.stringify(value)}`
    )
  }
  if (check.expectStdoutNonEmpty === true && value.trim().length === 0) {
    failures.push('expected non-empty stdout')
  }

  return failures
}

export function buildMacosReleaseArtifactChecks(path) {
  const kind = artifactKindFromPath(path)
  if (!kind) {
    throw new Error(`Unsupported macOS release artifact: ${path}`)
  }

  if (kind === 'app') {
    const infoPlist = `${path}/Contents/Info.plist`
    return [
      {
        id: 'codesign-verify',
        label: 'codesign verify',
        command: 'codesign',
        args: ['--verify', '--deep', '--strict', '--verbose=2', path]
      },
      {
        id: 'codesign-display',
        label: 'codesign display',
        command: 'codesign',
        args: ['-dv', '--verbose=4', path]
      },
      {
        id: 'spctl-assess',
        label: 'Gatekeeper assess',
        command: 'spctl',
        args: ['--assess', '--type', 'execute', '--verbose', path]
      },
      {
        id: 'stapler-validate',
        label: 'stapler validate',
        command: 'xcrun',
        args: ['stapler', 'validate', path]
      },
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
      },
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
      },
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
      },
      ...captureEntitlementCheckTargets(path).map((target) => ({
        id: `capture-entitlements-${target.id}`,
        label: `capture entitlements (${target.label})`,
        command: 'codesign',
        args: ['-d', '--entitlements', ':-', target.path],
        expectOutputIncludes: REQUIRED_CAPTURE_ENTITLEMENTS
      })),
      {
        id: 'native-preview-addon-signature',
        label: 'native preview addon signature',
        command: 'codesign',
        args: [
          '--verify',
          '--strict',
          '--verbose=2',
          `${path}/Contents/Resources/videorc_native_preview.node`
        ]
      },
      ...cameraExtensionCheckTargets(path),
      ...bundledXOauth1ConsumerCheckTargets(path),
      ...bundledYoutubeOauthCheckTargets(path),
      ...bundledKickSecretLeakCheckTargets(path)
    ]
  }

  return [
    {
      id: 'codesign-verify',
      label: 'codesign verify',
      command: 'codesign',
      args: ['--verify', '--verbose=2', path]
    },
    {
      id: 'codesign-display',
      label: 'codesign display',
      command: 'codesign',
      args: ['-dv', '--verbose=4', path]
    },
    {
      id: 'spctl-assess',
      label: 'Gatekeeper assess',
      command: 'spctl',
      args: [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose',
        path
      ]
    },
    {
      id: 'stapler-validate',
      label: 'stapler validate',
      command: 'xcrun',
      args: ['stapler', 'validate', path]
    }
  ]
}

export function selectLatestReleaseArtifacts(candidates) {
  const latestByKind = new Map()

  for (const candidate of candidates) {
    const kind = candidate.kind ?? artifactKindFromPath(candidate.path)
    if (!kind) {
      continue
    }

    const previous = latestByKind.get(kind)
    if (!previous || Number(candidate.mtimeMs ?? 0) > Number(previous.mtimeMs ?? 0)) {
      latestByKind.set(kind, { ...candidate, kind })
    }
  }

  return ['app', 'dmg'].map((kind) => latestByKind.get(kind)).filter(Boolean)
}

export function formatArtifactPath(path, { repoRoot, homeDir } = {}) {
  const raw = String(path)
  if (repoRoot) {
    const rel = relative(repoRoot, raw)
    if (rel && !rel.startsWith('..')) {
      return rel
    }
  }

  if (homeDir && raw.startsWith(homeDir)) {
    return `<home>/${basename(raw)}`
  }

  return `<external>/${basename(raw)}`
}

export function sanitizeReleaseValidationOutput(text, { repoRoot, homeDir } = {}) {
  let output = String(text ?? '')
  if (repoRoot) {
    output = output.split(repoRoot).join('<repo>')
  }
  if (homeDir) {
    output = output.split(homeDir).join('<home>')
  }
  return output
}

export function formatReleaseArtifactValidationReport({ artifactLabel, results }) {
  const ok = results.every((result) => result.ok)
  const lines = [`macos-release-artifact: ${ok ? 'PASS' : 'FAIL'} ${artifactLabel}`]

  for (const result of results) {
    const mark = result.ok ? 'ok' : 'fail'
    lines.push(`[${mark}] ${result.label}`)
    if (!result.ok && result.output) {
      lines.push(indentExcerpt(result.output))
    }
  }

  return lines.join('\n')
}

function indentExcerpt(text) {
  return String(text)
    .trim()
    .split(/\r?\n/)
    .slice(0, 12)
    .map((line) => `  ${line}`)
    .join('\n')
}
