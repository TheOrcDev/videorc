// Notarization credentials that must come from the environment. APPLE_TEAM_ID
// is intentionally NOT here: the `dist:release` script bakes it inline
// (APPLE_TEAM_ID=C2PA37RB58 electron-builder …), so requiring it in the ambient
// env would falsely fail the documented `pnpm dist:desktop:release` path.
export const REQUIRED_RELEASE_ENV_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']

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
  paths = {},
  signing = {}
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

  // Signing can come from either the keychain "Developer ID Application"
  // identity (the primary path — electron-builder auto-detects it) or an
  // exported CSC_LINK/CSC_KEY_PASSWORD certificate. Require at least one; never
  // echo the certificate value.
  const hasKeychainIdentity = signing.keychainIdentity === true
  const hasCscCertificate =
    typeof env.CSC_LINK === 'string' &&
    env.CSC_LINK.trim().length > 0 &&
    typeof env.CSC_KEY_PASSWORD === 'string' &&
    env.CSC_KEY_PASSWORD.trim().length > 0
  checks.push({
    type: 'signing',
    label: 'Developer ID Application',
    ok: hasKeychainIdentity || hasCscCertificate,
    detail: hasKeychainIdentity
      ? 'keychain identity'
      : hasCscCertificate
        ? 'CSC_LINK certificate'
        : 'no keychain identity and no CSC_LINK certificate'
  })

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
