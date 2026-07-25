const REQUIRED_TOP_LEVEL_SECTIONS = [
  'schemaVersion',
  'generatedAt',
  'app',
  'health',
  'devices',
  'lastAudioMeter',
  'entitlements',
  'recording',
  'diagnostics',
  'logs',
  'sessions',
  'redactionSummary'
]

const REDACTION_SUMMARY_FIELDS = [
  'secretValues',
  'databasePaths',
  'mediaPaths',
  'homePaths',
  'urlCredentials',
  'aiArtifactBodies'
]

const SUPPORTED_SCHEMA_VERSION = 2
const WINDOWS_ACCEPTANCE_REQUIRED_DEVICE_KINDS = ['screen', 'camera', 'microphone']

const AI_ARTIFACT_BODY_KEYS = new Set([
  'body',
  'chapters',
  'content',
  'description',
  'summary',
  'text',
  'title',
  'transcript'
])

export function validateSupportBundle(bundle, options = {}) {
  const failures = []
  const warnings = []

  if (!isPlainObject(bundle)) {
    return {
      ok: false,
      failures: ['Support bundle root must be a JSON object.'],
      warnings
    }
  }

  for (const section of REQUIRED_TOP_LEVEL_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(bundle, section)) {
      failures.push(`Missing required top-level section: ${section}`)
    }
  }

  if (bundle.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    failures.push(`Unsupported support bundle schemaVersion: ${String(bundle.schemaVersion)}`)
  }
  if (!isPlainObject(bundle.app)) {
    failures.push('app section must be an object.')
  } else {
    for (const field of ['version', 'platform', 'runMode']) {
      if (typeof bundle.app[field] !== 'string' || bundle.app[field].trim() === '') {
        failures.push(`app.${field} must be a non-empty string.`)
      }
    }
  }
  if (!isPlainObject(bundle.health)) {
    failures.push('health section must be an object.')
  } else {
    for (const field of ['status', 'version', 'platform']) {
      if (typeof bundle.health[field] !== 'string' || bundle.health[field].trim() === '') {
        failures.push(`health.${field} must be a non-empty string.`)
      }
    }
    if (!isPlainObject(bundle.health.ffmpeg)) {
      failures.push('health.ffmpeg must be an object.')
    } else if (typeof bundle.health.ffmpeg.available !== 'boolean') {
      failures.push('health.ffmpeg.available must be a boolean.')
    }
  }
  if (!isPlainObject(bundle.devices)) {
    failures.push('devices section must be an object.')
  } else if (!Array.isArray(bundle.devices.devices)) {
    failures.push('devices.devices must be an array.')
  }
  if (!isPlainObject(bundle.diagnostics)) {
    failures.push('diagnostics section must be an object.')
  }
  if (!Array.isArray(bundle.logs)) {
    failures.push('logs section must be an array.')
  }
  if (!Array.isArray(bundle.sessions)) {
    failures.push('sessions section must be an array.')
  }
  if (!isPlainObject(bundle.redactionSummary)) {
    failures.push('redactionSummary section must be an object.')
  } else {
    for (const field of REDACTION_SUMMARY_FIELDS) {
      const value = bundle.redactionSummary[field]
      if (!Number.isInteger(value) || value < 0) {
        failures.push(`redactionSummary.${field} must be a non-negative integer.`)
      }
    }
  }

  inspectValue(bundle, [], failures, warnings)
  if (options.windowsAcceptance === true) {
    inspectWindowsAcceptance(bundle, failures, warnings)
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings
  }
}

function inspectWindowsAcceptance(bundle, failures, warnings) {
  if (!isPlainObject(bundle)) {
    return
  }

  if (bundle.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    failures.push(
      `windows acceptance requires support bundle schemaVersion ${SUPPORTED_SCHEMA_VERSION}.`
    )
  }
  requireString(bundle, ['app', 'platform'], 'windows', failures)
  requireString(bundle, ['health', 'platform'], 'windows', failures)
  requireString(bundle, ['app', 'runMode'], 'packaged', failures)

  if (bundle.health?.ffmpeg?.available !== true) {
    failures.push('windows acceptance requires health.ffmpeg.available to be true.')
  }
  if (typeof bundle.health?.ffmpeg?.version !== 'string' || !bundle.health.ffmpeg.version.trim()) {
    failures.push('windows acceptance requires health.ffmpeg.version to be present.')
  }

  const runtimeInfo = bundle.rendererDiagnostics?.runtimeInfo
  if (!isPlainObject(runtimeInfo)) {
    failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.')
  } else {
    requireString(runtimeInfo, ['platform'], 'win32', failures, 'rendererDiagnostics.runtimeInfo')
    requireString(runtimeInfo, ['arch'], 'x64', failures, 'rendererDiagnostics.runtimeInfo')
    if (runtimeInfo.isPackaged !== true) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.isPackaged=true.')
    }
    if (typeof runtimeInfo.osRelease !== 'string' || !runtimeInfo.osRelease.trim()) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.osRelease.')
    } else {
      const build = windowsBuildNumber(runtimeInfo.osRelease)
      if (build === null) {
        failures.push(
          `rendererDiagnostics.runtimeInfo.osRelease must include a Windows build number: ${runtimeInfo.osRelease}`
        )
      } else if (build < 22000) {
        failures.push(`windows acceptance requires Windows 11 build 22000+; found ${build}.`)
      }
    }
    if (!Array.isArray(runtimeInfo.gpuDevices) || runtimeInfo.gpuDevices.length === 0) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.gpuDevices.')
    } else {
      runtimeInfo.gpuDevices.forEach((device, index) => {
        if (!isPlainObject(device)) {
          failures.push(`rendererDiagnostics.runtimeInfo.gpuDevices.${index} must be an object.`)
          return
        }
        if (
          stringOrNumber(device.vendorId) === undefined &&
          stringOrNumber(device.deviceId) === undefined &&
          typeof device.description !== 'string'
        ) {
          failures.push(
            `rendererDiagnostics.runtimeInfo.gpuDevices.${index} must include a vendorId, deviceId, or description.`
          )
        }
      })
    }
    if (typeof runtimeInfo.hardwareAccelerationDisabled !== 'boolean') {
      failures.push(
        'windows acceptance requires rendererDiagnostics.runtimeInfo.hardwareAccelerationDisabled.'
      )
    }
    if (!isPlainObject(runtimeInfo.gpuFallback)) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.gpuFallback.')
    } else {
      const validSources = new Set(['env', 'persisted', 'retry', 'none'])
      if (!validSources.has(runtimeInfo.gpuFallback.source)) {
        failures.push(
          'rendererDiagnostics.runtimeInfo.gpuFallback.source must identify env, persisted, retry, or none.'
        )
      }
      if (typeof runtimeInfo.gpuFallback.retryScheduled !== 'boolean') {
        failures.push(
          'rendererDiagnostics.runtimeInfo.gpuFallback.retryScheduled must be a boolean.'
        )
      }
      if (
        !Number.isInteger(runtimeInfo.gpuFallback.retryAttempts) ||
        runtimeInfo.gpuFallback.retryAttempts < 0
      ) {
        failures.push(
          'rendererDiagnostics.runtimeInfo.gpuFallback.retryAttempts must be a non-negative integer.'
        )
      }
      if (
        runtimeInfo.hardwareAccelerationDisabled === true &&
        (typeof runtimeInfo.gpuFallback.reason !== 'string' ||
          !runtimeInfo.gpuFallback.reason.trim())
      ) {
        failures.push(
          'windows acceptance requires a GPU fallback reason while software rendering is active.'
        )
      }
    }
  }

  const devices = Array.isArray(bundle.devices?.devices) ? bundle.devices.devices : []
  for (const kind of WINDOWS_ACCEPTANCE_REQUIRED_DEVICE_KINDS) {
    if (!devices.some((device) => device?.kind === kind && device?.status === 'available')) {
      failures.push(`windows acceptance requires an available ${kind} device.`)
    }
  }
  if (!hasWindowsCaptureBackendProof(devices)) {
    failures.push(
      'windows acceptance requires Windows capture backend proof in devices (DXGI/gdigrab/dshow/MediaFoundation).'
    )
  }

  const diagnostics = diagnosticSnapshots(bundle)
  if (!diagnostics.some((snapshot) => typeof snapshot.encodeBackend === 'string')) {
    failures.push(
      'windows acceptance requires encodeBackend in diagnostics or session finalDiagnostics.'
    )
  }
  if (
    !diagnostics.some(
      (snapshot) =>
        typeof snapshot.compositorBackend === 'string' ||
        typeof snapshot.compositorFallbackReason === 'string'
    )
  ) {
    warnings.push(
      'windows acceptance bundle does not include compositor backend/fallback diagnostics; device backend proof is still required.'
    )
  }
}

function inspectValue(value, path, failures, warnings) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectValue(item, [...path, String(index)], failures, warnings))
    return
  }
  if (!isPlainObject(value)) {
    inspectScalar(value, path, failures, warnings)
    return
  }

  for (const [key, child] of Object.entries(value)) {
    inspectValue(child, [...path, key], failures, warnings)
  }
}

function inspectScalar(value, path, failures, warnings) {
  if (typeof value !== 'string' || value.trim() === '') {
    return
  }

  const key = path[path.length - 1] ?? ''
  const normalizedKey = normalizeKey(key)
  const location = path.join('.')

  if (isAiArtifactBody(path, normalizedKey) && !isRedacted(value)) {
    failures.push(
      `${location} contains an AI artifact body; support bundles must keep only artifact metadata.`
    )
  }

  if (isSecretKey(normalizedKey) && !isRedactedSecret(value)) {
    failures.push(`${location} contains an unredacted secret-shaped value.`)
  }

  if (normalizedKey === 'databasepath' && value !== '<redacted:database-path>') {
    failures.push(`${location} contains an unredacted database path.`)
  }

  if (isMediaPathKey(normalizedKey) && !isRedactedPath(value)) {
    failures.push(`${location} contains an unredacted media path.`)
  }

  if (normalizedKey.includes('url') && hasUnredactedUrlSecret(value)) {
    failures.push(`${location} contains an unredacted URL credential or RTMP URL.`)
  }

  if (!isRedacted(value) && looksLikeInlineSecret(value)) {
    failures.push(`${location} contains inline secret-shaped text.`)
  }

  if (!isRedacted(value) && looksLikeHomePath(value)) {
    failures.push(`${location} contains an unredacted home-directory path.`)
  }

  if (isRedacted(value) && value.includes('\n')) {
    warnings.push(`${location} redaction marker contains a newline.`)
  }
}

function requireString(root, path, expected, failures, prefix) {
  const value = valueAt(root, path)
  const location = prefix ? `${prefix}.${path.join('.')}` : path.join('.')
  if (value !== expected) {
    failures.push(
      `${location} must be ${JSON.stringify(expected)}; found ${JSON.stringify(value)}.`
    )
  }
}

function valueAt(root, path) {
  let current = root
  for (const part of path) {
    if (!isPlainObject(current)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function diagnosticSnapshots(bundle) {
  const snapshots = []
  if (isPlainObject(bundle.diagnostics)) {
    snapshots.push(bundle.diagnostics)
  }
  if (Array.isArray(bundle.sessions)) {
    for (const session of bundle.sessions) {
      if (isPlainObject(session?.finalDiagnostics)) {
        snapshots.push(session.finalDiagnostics)
      }
    }
  }
  return snapshots
}

function hasWindowsCaptureBackendProof(devices) {
  const availableDevices = devices.filter((device) => device?.status === 'available')
  return (
    availableDevices.some(
      (device) =>
        (device.kind === 'screen' || device.kind === 'window') &&
        windowsBackendText(device).match(/\b(dxgi|gdigrab|desktop duplication)\b/i)
    ) &&
    availableDevices.some(
      (device) =>
        device.kind === 'camera' &&
        windowsBackendText(device).match(/\b(dshow|directshow|mediafoundation)\b/i)
    ) &&
    availableDevices.some(
      (device) => device.kind === 'microphone' && windowsBackendText(device).match(/\bdshow\b/i)
    )
  )
}

function windowsBackendText(device) {
  return [device.id, device.name, device.detail].filter(Boolean).join(' ')
}

function windowsBuildNumber(release) {
  if (typeof release !== 'string' || !release.trim()) {
    return null
  }
  const parts = release.split('.')
  const build = Number(parts[2])
  return Number.isFinite(build) ? build : null
}

function stringOrNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  return undefined
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(key) {
  return String(key).replace(/[_-]/g, '').toLowerCase()
}

function isSecretKey(key) {
  if (key === 'secretstorebackend') {
    return false
  }
  return (
    key.includes('token') ||
    key.includes('secret') ||
    key.includes('streamkey') ||
    key.includes('apikey') ||
    key.includes('authorization') ||
    key.includes('password')
  )
}

function isMediaPathKey(key) {
  return new Set([
    'outputpath',
    'outputfile',
    'mp4path',
    'mp4file',
    'filepath',
    'file',
    'audiopath',
    'markdownpath',
    'recordingpath'
  ]).has(key)
}

function isAiArtifactBody(path, normalizedKey) {
  return path.includes('aiArtifacts') && AI_ARTIFACT_BODY_KEYS.has(normalizedKey)
}

function isRedacted(value) {
  return /^<redacted:[^>]+>$/.test(value)
}

function isRedactedSecret(value) {
  return value === '<redacted:secret>' || value.includes('<redacted:')
}

function isRedactedPath(value) {
  return /^<redacted:path:[^/\\>]+>$/.test(value)
}

function hasUnredactedUrlSecret(value) {
  if (value.includes('<redacted:')) {
    return false
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(value)) {
    return true
  }
  return value.startsWith('rtmp://') || value.startsWith('rtmps://')
}

function looksLikeInlineSecret(value) {
  return (
    /\bsk-[A-Za-z0-9_-]{8,}/.test(value) ||
    /\bghp_[A-Za-z0-9_]{8,}/.test(value) ||
    /\bxox[baprs]-[A-Za-z0-9-]{8,}/.test(value) ||
    /(?:access_token|refresh_token|stream_key|api_key|client_secret)=([^&\s]+)/i.test(value)
  )
}

function looksLikeHomePath(value) {
  return /(^|\s)(\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/.test(value)
}
