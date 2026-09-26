import { releaseBundledOauthChecks } from './release-bundled-oauth.mjs'

export const LINUX_RELEASE_CANDIDATE_UPLOAD_ENV = [
  ['VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID', 'VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID'],
  ['VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY', 'VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY'],
  ['VIDEORC_RELEASE_UPLOAD_S3_BUCKET', 'VIDEORC_DOWNLOAD_S3_BUCKET'],
  ['VIDEORC_RELEASE_UPLOAD_S3_REGION', 'VIDEORC_DOWNLOAD_S3_REGION'],
  ['VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL', 'VIDEORC_DOWNLOAD_S3_ENDPOINT_URL']
]

// Neon-only candidate upload. Field names match
// scripts/lib/release-upload-origins.mjs (ACCESS_KEY_ID / SECRET_ACCESS_KEY /
// BUCKET / REGION / ENDPOINT_URL).
export const LINUX_RELEASE_NEON_UPLOAD_ENV = [
  'VIDEORC_RELEASE_UPLOAD_NEON_S3_ACCESS_KEY_ID',
  'VIDEORC_RELEASE_UPLOAD_NEON_S3_SECRET_ACCESS_KEY',
  'VIDEORC_RELEASE_UPLOAD_NEON_S3_BUCKET',
  'VIDEORC_RELEASE_UPLOAD_NEON_S3_REGION',
  'VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL'
]

export function evaluateLinuxReleasePreflight({
  arch,
  changelogEntrySupportsLinux,
  env,
  gitClean,
  packageVersion,
  paths,
  platform,
  tools
}) {
  const checks = [
    check('platform', 'Linux release host', platform === 'linux', `got ${platform}`),
    check('architecture', 'x64 release host', arch === 'x64', `got ${arch}`),
    ...Object.entries(tools).map(([name, present]) =>
      check(`tool-${name}`, `${name} available`, Boolean(present), 'missing')
    ),
    ...Object.entries(paths).map(([name, present]) =>
      check(`path-${name}`, `${name} present`, Boolean(present), 'missing')
    ),
    check('git-clean', 'release checkout is clean', Boolean(gitClean), 'working tree is dirty'),
    check(
      'release-id',
      'explicit Linux alpha release id',
      validReleaseId(env.VIDEORC_RELEASE_ID, packageVersion),
      `expected ${packageVersion}-alpha.N`
    ),
    check(
      'changelog-entry',
      'matching Linux canonical changelog entry',
      Boolean(changelogEntrySupportsLinux),
      `missing Linux platform declaration in changelog/${env.VIDEORC_RELEASE_ID ?? '<releaseId>'}.md`
    ),
    // Sign-in is compiled into the backend; a build without these ships dead.
    ...releaseBundledOauthChecks(env),
    check(
      'stage',
      'candidate stage is private',
      isCandidateStage(env.VIDEORC_LINUX_RELEASE_STAGE),
      `got ${nonEmpty(env.VIDEORC_LINUX_RELEASE_STAGE) ?? 'candidate'}`
    )
  ]

  const acceptanceStatus = nonEmpty(env.VIDEORC_LINUX_ACCEPTANCE_STATUS) ?? 'pending'
  checks.push(
    check(
      'acceptance-status',
      'acceptance status is pending',
      acceptanceStatus === 'pending',
      `got ${acceptanceStatus}`
    )
  )

  return {
    checks,
    failures: checks.filter((item) => !item.ok),
    ok: checks.every((item) => item.ok)
  }
}

export function formatLinuxReleasePreflightReport(result) {
  const lines = [result.ok ? 'linux-release-preflight: PASS' : 'linux-release-preflight: FAIL']
  for (const item of result.checks) {
    lines.push(`[${item.ok ? 'ok' : 'fail'}] ${item.label}${item.ok ? '' : ` (${item.detail})`}`)
  }
  return lines.join('\n')
}

export function isNeonReleaseUploadPrimary(env = process.env) {
  return (nonEmpty(env.VIDEORC_DOWNLOAD_STORAGE_PRIMARY) ?? '').toLowerCase() === 'neon'
}

export function linuxReleaseUploadEndpoint(env = process.env) {
  if (isNeonReleaseUploadPrimary(env)) {
    return nonEmpty(env.VIDEORC_RELEASE_UPLOAD_NEON_S3_ENDPOINT_URL)
  }
  return (
    nonEmpty(env.VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL) ??
    nonEmpty(env.VIDEORC_DOWNLOAD_S3_ENDPOINT_URL)
  )
}

export function missingLinuxReleaseUploadEnv(env = process.env) {
  if (isNeonReleaseUploadPrimary(env)) {
    return LINUX_RELEASE_NEON_UPLOAD_ENV.filter((name) => !nonEmpty(env[name]))
  }
  return LINUX_RELEASE_CANDIDATE_UPLOAD_ENV.filter(
    (names) => !names.some((name) => nonEmpty(env[name]))
  ).map((names) => names[0])
}

export function isHttpsReleaseUploadEndpoint(value) {
  try {
    const url = new URL(value)
    return Boolean(url.protocol === 'https:' && !url.username && !url.password)
  } catch {
    return false
  }
}

function validReleaseId(value, packageVersion) {
  const releaseId = nonEmpty(value)
  return Boolean(
    releaseId &&
    typeof packageVersion === 'string' &&
    new RegExp(`^${escapeRegExp(packageVersion)}-alpha\\.\\d+$`).test(releaseId)
  )
}

function isCandidateStage(value) {
  const stage = nonEmpty(value)
  return stage === null || stage === 'candidate'
}

function check(id, label, ok, detail) {
  return { detail, id, label, ok }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
