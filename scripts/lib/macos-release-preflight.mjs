export const REQUIRED_RELEASE_ENV_VARS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
]

export const REQUIRED_RELEASE_TOOLS = [
  { id: 'codesign', label: 'codesign' },
  { id: 'spctl', label: 'spctl' },
  { id: 'notarytool', label: 'xcrun notarytool' },
  { id: 'stapler', label: 'xcrun stapler' }
]

export const REQUIRED_RELEASE_PATHS = [
  {
    id: 'macEntitlements',
    label: 'apps/desktop/build-resources/entitlements.mac.plist'
  },
  {
    id: 'releaseOutputDir',
    label: 'apps/desktop/release'
  }
]

export function evaluateMacosReleasePreflight({
  platform = 'darwin',
  env = {},
  tools = {},
  paths = {}
} = {}) {
  const checks = []

  checks.push({
    type: 'platform',
    label: 'macOS host',
    ok: platform === 'darwin',
    detail: platform === 'darwin' ? 'darwin' : `got ${platform}`
  })

  for (const name of REQUIRED_RELEASE_ENV_VARS) {
    const present = typeof env[name] === 'string' && env[name].trim().length > 0
    checks.push({
      type: 'env',
      label: name,
      ok: present,
      detail: present ? 'present' : 'missing'
    })
  }

  for (const tool of REQUIRED_RELEASE_TOOLS) {
    checks.push({
      type: 'tool',
      label: tool.label,
      ok: tools[tool.id] === true,
      detail: tools[tool.id] === true ? 'available' : 'missing'
    })
  }

  for (const path of REQUIRED_RELEASE_PATHS) {
    checks.push({
      type: 'path',
      label: path.label,
      ok: paths[path.id] === true,
      detail: paths[path.id] === true ? 'ready' : 'missing or not writable'
    })
  }

  return {
    ok: checks.every((check) => check.ok),
    checks
  }
}

export function formatMacosReleasePreflightReport(result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  const lines = [`macos-release-preflight: ${status}`]

  for (const check of result.checks) {
    const mark = check.ok ? 'ok' : 'missing'
    lines.push(`[${mark}] ${check.type}: ${check.label} (${check.detail})`)
  }

  return lines.join('\n')
}
