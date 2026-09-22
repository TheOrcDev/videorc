export const REQUIRED_MACOS_RELEASE_GITHUB_SECRETS = [
  {
    group: 'signing',
    name: 'CSC_LINK'
  },
  {
    group: 'signing',
    name: 'CSC_KEY_PASSWORD'
  },
  {
    group: 'notarization',
    name: 'APPLE_ID'
  },
  {
    group: 'notarization',
    name: 'APPLE_APP_SPECIFIC_PASSWORD'
  },
  {
    group: 'notarization',
    name: 'APPLE_TEAM_ID'
  },
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID'
  },
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_BUCKET'
  },
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_REGION'
  },
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY'
  }
]

export const CONDITIONAL_MACOS_RELEASE_GITHUB_SECRETS = [
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_ENDPOINT_URL',
    detail: 'required for Cloudflare R2 or other custom S3-compatible endpoints'
  },
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_FORCE_PATH_STYLE',
    detail: 'usually true for path-style S3-compatible endpoints'
  },
  {
    group: 'private download storage',
    name: 'VIDEORC_DOWNLOAD_S3_SESSION_TOKEN',
    detail: 'required only for temporary credentials'
  },
  // Further release origins (scripts/lib/release-upload-origins.mjs). Only the
  // keys are secrets; bucket, region and endpoint are repository variables.
  {
    group: 'release origin neon',
    name: 'VIDEORC_RELEASE_UPLOAD_NEON_S3_ACCESS_KEY_ID',
    detail: 'required while neon is a release origin (storage:write key)'
  },
  {
    group: 'release origin neon',
    name: 'VIDEORC_RELEASE_UPLOAD_NEON_S3_SECRET_ACCESS_KEY',
    detail: 'required while neon is a release origin (storage:write key)'
  },
  {
    group: 'release origin hetzner',
    name: 'VIDEORC_RELEASE_UPLOAD_HETZNER_S3_ACCESS_KEY_ID',
    detail: 'required while hetzner is a release origin (retired after the Neon soak)'
  },
  {
    group: 'release origin hetzner',
    name: 'VIDEORC_RELEASE_UPLOAD_HETZNER_S3_SECRET_ACCESS_KEY',
    detail: 'required while hetzner is a release origin (retired after the Neon soak)'
  }
]

export function evaluateMacosReleaseGithubSecrets({
  presentSecretNames = [],
  required = REQUIRED_MACOS_RELEASE_GITHUB_SECRETS,
  conditional = CONDITIONAL_MACOS_RELEASE_GITHUB_SECRETS
} = {}) {
  const present = new Set(
    presentSecretNames.filter((name) => typeof name === 'string').map((name) => name.trim())
  )
  const requiredChecks = required.map((secret) => ({
    ...secret,
    ok: present.has(secret.name),
    required: true
  }))
  const conditionalChecks = conditional.map((secret) => ({
    ...secret,
    ok: present.has(secret.name),
    required: false
  }))
  const checks = [...requiredChecks, ...conditionalChecks]

  return {
    checks,
    ok: requiredChecks.every((check) => check.ok)
  }
}

export function formatMacosReleaseGithubSecretsReport(result, { repo } = {}) {
  const lines = [`macos-release-github-secrets: ${result.ok ? 'PASS' : 'FAIL'}`]
  if (repo) {
    lines.push(`repo: ${repo}`)
  }

  for (const check of result.checks) {
    const mark = check.ok ? 'ok' : 'missing'
    const requirement = check.required ? 'required' : 'conditional'
    const detail = check.detail ? ` - ${check.detail}` : ''
    lines.push(`[${mark}] ${requirement}: ${check.name} (${check.group})${detail}`)
  }

  return lines.join('\n')
}
