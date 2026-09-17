import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'

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
    { id: 'ffmpeg', label: 'ffmpeg', path: `${appPath}/Contents/Resources/ffmpeg/bin/ffmpeg` },
    { id: 'ffprobe', label: 'ffprobe', path: `${appPath}/Contents/Resources/ffmpeg/bin/ffprobe` }
  ]
}

// Native X Live is dead in a release whose backend lacks the baked OAuth 1.0a
// consumer pair (users would see "Credentials needed" instead of Authorize X
// Live), so the validator fails closed on both halves — same mechanism the
// baked YouTube secret used before Google approval paused that flow.
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
      ...bundledXOauth1ConsumerCheckTargets(path)
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
