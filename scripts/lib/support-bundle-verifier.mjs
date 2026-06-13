const REQUIRED_TOP_LEVEL_SECTIONS = [
  'schemaVersion',
  'generatedAt',
  'app',
  'health',
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

export function validateSupportBundle(bundle) {
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

  if (bundle.schemaVersion !== 1) {
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

  return {
    ok: failures.length === 0,
    failures,
    warnings
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
    failures.push(`${location} contains an AI artifact body; support bundles must keep only artifact metadata.`)
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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(key) {
  return String(key)
    .replace(/[_-]/g, '')
    .toLowerCase()
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
