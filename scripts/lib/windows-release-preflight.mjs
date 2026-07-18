export const WINDOWS_RELEASE_SIGNING_ENV = [
  'VIDEORC_WINDOWS_SIGNING_ENDPOINT',
  'VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME',
  'VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME',
  'VIDEORC_WINDOWS_PUBLISHER_NAME'
]

export const WINDOWS_RELEASE_FORBIDDEN_CREDENTIAL_ENV = [
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_SECRET',
  'AZURE_PASSWORD',
  'AZURE_USERNAME',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK'
]

export function evaluateWindowsReleasePreflight({
  arch,
  changelogEntrySupportsWindows,
  env,
  gitClean,
  packageVersion,
  paths,
  platform,
  tools
}) {
  const checks = [
    check('platform', 'Windows release host', platform === 'win32', `got ${platform}`),
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
      'explicit Windows alpha release id',
      validReleaseId(env.VIDEORC_RELEASE_ID, packageVersion),
      `expected ${packageVersion}-alpha.1; bump packageVersion for every candidate`
    ),
    check(
      'changelog-entry',
      'matching Windows canonical changelog entry',
      Boolean(changelogEntrySupportsWindows),
      `missing Windows platform declaration in changelog/${env.VIDEORC_RELEASE_ID ?? '<releaseId>'}.md`
    ),
    ...WINDOWS_RELEASE_FORBIDDEN_CREDENTIAL_ENV.map((name) =>
      check(
        `env-forbidden-${name}`,
        `${name} absent from unsigned release build`,
        !nonEmpty(env[name]),
        'long-lived signing credential is forbidden'
      )
    )
  ]

  const acceptanceStatus = nonEmpty(env.VIDEORC_WINDOWS_ACCEPTANCE_STATUS) ?? 'pending'
  checks.push(
    check(
      'acceptance-status',
      'acceptance status is pending or pass',
      acceptanceStatus === 'pending' || acceptanceStatus === 'pass',
      `got ${acceptanceStatus}`
    )
  )

  return {
    checks,
    failures: checks.filter((item) => !item.ok),
    ok: checks.every((item) => item.ok)
  }
}

export function formatWindowsReleasePreflightReport(result) {
  const lines = [result.ok ? 'windows-release-preflight: PASS' : 'windows-release-preflight: FAIL']
  for (const item of result.checks) {
    lines.push(`[${item.ok ? 'ok' : 'fail'}] ${item.label}${item.ok ? '' : ` (${item.detail})`}`)
  }
  return lines.join('\n')
}

export function missingWindowsReleaseSigningEnv(env = process.env) {
  return WINDOWS_RELEASE_SIGNING_ENV.filter((name) => {
    const value = nonEmpty(env[name])
    return name === 'VIDEORC_WINDOWS_SIGNING_ENDPOINT' ? !isTrustedSigningEndpoint(value) : !value
  })
}

export function isTrustedSigningEndpoint(value) {
  try {
    const url = new URL(value)
    return Boolean(
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^[a-z0-9-]+\.codesigning\.azure\.net$/i.test(url.hostname)
    )
  } catch {
    return false
  }
}

function validReleaseId(value, packageVersion) {
  const releaseId = nonEmpty(value)
  return Boolean(
    releaseId && typeof packageVersion === 'string' && releaseId === `${packageVersion}-alpha.1`
  )
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
