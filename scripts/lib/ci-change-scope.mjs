// Fail-closed classifier for CI path filters.
//
// Ordinary code PRs must keep today's full macOS / Linux / Windows gates.
// Only four narrowly allow-listed change sets may skip the heavy jobs:
//
// - docs-record: release records and owner-waiver JSON only
// - version-release: desktop version field + changelog + those records
// - docs: prose only (docs/, plans/, Markdown at the repo root); the cheap
//   JS job still runs because some Node tests read docs and plans
// - js-test: JS/TS test files only (*.test.* / *.spec.* outside crates/);
//   nothing ships or builds from them, so only the JS job runs
//
// Anything else, including a package.json edit that is not exactly the
// version field, a rename that also deletes a non-allow-listed path, an
// empty or unreadable diff, or workflow_dispatch, is treated as code.

export const CI_SCOPE_KINDS = Object.freeze({
  CODE: 'code',
  VERSION_RELEASE: 'version-release',
  DOCS_RECORD: 'docs-record',
  DOCS: 'docs',
  JS_TEST: 'js-test',
  APP_TS: 'app-ts'
})

export const CI_SCOPE_EVENTS_WITH_DIFF = Object.freeze(['pull_request', 'push'])

const DOCS_RECORD_PREFIXES = Object.freeze([
  'docs/releases/',
  'docs/acceptance/windows-alpha/',
  'docs/acceptance/linux-alpha/'
])

const VERSION_RELEASE_FILES = Object.freeze(['apps/desktop/package.json'])
const VERSION_RELEASE_PREFIXES = Object.freeze(['changelog/'])

const DOCS_PREFIXES = Object.freeze(['docs/', 'plans/'])
const ROOT_MARKDOWN_RE = /^[^/]+\.md$/
const JS_TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

const ZERO_SHA_RE = /^0+$/

export const HEAVY_CODE_SCOPE = Object.freeze({
  kind: CI_SCOPE_KINDS.CODE,
  windowsHeavy: true,
  linuxHeavy: true,
  macosRust: true,
  js: true
})

const DOCS_RECORD_SCOPE = Object.freeze({
  kind: CI_SCOPE_KINDS.DOCS_RECORD,
  windowsHeavy: false,
  linuxHeavy: false,
  macosRust: false,
  js: false
})

const DOCS_SCOPE = Object.freeze({
  kind: CI_SCOPE_KINDS.DOCS,
  windowsHeavy: false,
  linuxHeavy: false,
  macosRust: false,
  js: true
})

const JS_TEST_SCOPE = Object.freeze({
  kind: CI_SCOPE_KINDS.JS_TEST,
  windowsHeavy: false,
  linuxHeavy: false,
  macosRust: false,
  // The desktop tests also run on Windows (path separators, spawn semantics).
  windowsJs: true,
  js: true
})

// Plan 242 S15: desktop app files the Rust crates include or read at build or
// test time. A change to any of them can change a Rust result, so it is code.
// scripts/lib/ci-change-scope-rust-reads.test.mjs fails when a Rust file
// starts reading a desktop path this list does not cover.
export const RUST_READS_DESKTOP_PREFIXES = Object.freeze([
  'apps/desktop/src/shared/',
  'apps/desktop/src/renderer/src/assets/'
])
export const RUST_READS_DESKTOP_FILES = Object.freeze([
  'apps/desktop/src/renderer/src/styles.css',
  'apps/desktop/src/main/window-palette.ts',
  // videorc-app-core's desktop::permissions tests read these (plan 260 S1.6s).
  'apps/desktop/src/main/media-access.ts',
  'apps/desktop/src/main/runtime-info.ts',
  // The typed client's deadline table is checked against it (S1.6s part 4).
  'apps/desktop/src/renderer/src/backendClient.ts',
  // desktop::system_access and desktop::camera_extension check their tables
  // against these (S1.6s part 5).
  'apps/desktop/src/renderer/src/lib/system-access.ts',
  'apps/desktop/src/renderer/src/lib/system-access-view.ts',
  'apps/desktop/src/renderer/src/lib/system-permission-orchestration.ts',
  'apps/desktop/src/main/camera-extension.ts',
  // videorc-app-core's nav tests read these (plan 260 S1.6f).
  'apps/desktop/src/renderer/src/lib/settings-tabs.ts',
  'apps/desktop/src/renderer/src/lib/buddy-tabs.ts',
  'apps/desktop/src/renderer/src/lib/avatar-tabs.ts',
  'apps/desktop/src/renderer/src/lib/livestream-tabs.ts',
  // buddy::copy's words are checked against these (S1.6e part 2).
  'apps/desktop/src/renderer/src/components/buddy-avatar-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-consent-dialog.tsx',
  'apps/desktop/src/renderer/src/components/buddy-library-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-look-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-motion-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-persona-section.tsx',
  'apps/desktop/src/renderer/src/components/cohost-settings-section.tsx',
  'apps/desktop/src/renderer/src/components/cohost-status.tsx',
  'apps/desktop/src/renderer/src/components/tabs/avatar-tab.tsx',
  'apps/desktop/src/renderer/src/components/tabs/buddy-tab.tsx',
  'apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-create-gate.ts',
  'apps/desktop/src/renderer/src/lib/buddy-library-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-onboarding-copy.ts',
  'apps/desktop/src/renderer/src/lib/buddy-persona-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-tab-view.ts',
  'apps/desktop/src/renderer/src/lib/cohost-view.ts',
  // chat::highlight's shared words are checked against it (S1.6e part 1).
  'apps/desktop/src/renderer/src/lib/studio-actions/studio-context.ts',
  // desktop::global_shortcuts' tests read these (plan 260 S1.6f).
  'apps/desktop/src/renderer/src/lib/global-shortcuts.ts',
  'apps/desktop/src/renderer/src/components/settings/shortcuts-settings.tsx',
  'apps/desktop/src/renderer/src/lib/go-live-copy.ts'
])

export function isRustReachableDesktopPath(path) {
  return (
    RUST_READS_DESKTOP_FILES.includes(path) ||
    RUST_READS_DESKTOP_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

/** Desktop app source that no Rust code reads. */
export function isAppTsPath(path) {
  return path.startsWith('apps/desktop/src/') && !isRustReachableDesktopPath(path)
}

/**
 * The packaged-app smokes in the Windows installer job exercise the main and
 * preload processes and the window entry pages, so those still run it
 * (plan 242 D7). Other renderer changes skip it.
 */
export function needsWindowsInstaller(path) {
  return (
    path.startsWith('apps/desktop/src/main/') ||
    path.startsWith('apps/desktop/src/preload/') ||
    /^apps\/desktop\/src\/renderer\/[^/]+\.html$/.test(path)
  )
}

function appTsScope(files) {
  return {
    kind: CI_SCOPE_KINDS.APP_TS,
    windowsHeavy: false,
    linuxHeavy: false,
    macosRust: false,
    macosSentinel: true,
    windowsJs: true,
    windowsInstaller: files.some(needsWindowsInstaller),
    js: true
  }
}

const VERSION_RELEASE_SCOPE = Object.freeze({
  kind: CI_SCOPE_KINDS.VERSION_RELEASE,
  windowsHeavy: false,
  linuxHeavy: false,
  macosRust: false,
  js: true
})

export function isBlankGitSha(value) {
  const sha = String(value ?? '').trim()
  return sha.length === 0 || ZERO_SHA_RE.test(sha)
}

export function isSafeChangedPath(value) {
  const path = String(value ?? '')
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('..')
}

export function isDocsRecordPath(path) {
  return DOCS_RECORD_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** Prose only. docs/ includes acceptance records, which nothing builds from. */
export function isDocsPath(path) {
  return DOCS_PREFIXES.some((prefix) => path.startsWith(prefix)) || ROOT_MARKDOWN_RE.test(path)
}

/** A JS/TS test file outside the Rust crates and the workflow directory. */
export function isJsTestPath(path) {
  return (
    JS_TEST_FILE_RE.test(path) && !path.startsWith('crates/') && !path.startsWith('.github/')
  )
}

export function isVersionReleasePath(path) {
  return (
    VERSION_RELEASE_FILES.includes(path) ||
    VERSION_RELEASE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    isDocsRecordPath(path)
  )
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    )
  }
  return value
}

export function isVersionOnlyPackageJson(beforeValue, afterValue) {
  if (
    !beforeValue ||
    !afterValue ||
    typeof beforeValue !== 'object' ||
    typeof afterValue !== 'object'
  ) {
    return false
  }
  if (Array.isArray(beforeValue) || Array.isArray(afterValue)) return false
  const beforeVersion = beforeValue.version
  const afterVersion = afterValue.version
  if (typeof beforeVersion !== 'string' || typeof afterVersion !== 'string') return false
  if (beforeVersion === afterVersion) return false
  const beforeRest = { ...beforeValue }
  const afterRest = { ...afterValue }
  delete beforeRest.version
  delete afterRest.version
  return JSON.stringify(stableJson(beforeRest)) === JSON.stringify(stableJson(afterRest))
}

export function classifyChangeScope({
  eventName,
  files,
  packageJsonBefore,
  packageJsonAfter
} = {}) {
  if (!CI_SCOPE_EVENTS_WITH_DIFF.includes(eventName)) return { ...HEAVY_CODE_SCOPE }
  if (!Array.isArray(files) || files.length === 0) return { ...HEAVY_CODE_SCOPE }
  if (files.some((file) => !isSafeChangedPath(file))) return { ...HEAVY_CODE_SCOPE }

  if (files.every(isDocsRecordPath)) return { ...DOCS_RECORD_SCOPE }

  if (files.every(isVersionReleasePath)) {
    if (
      files.includes('apps/desktop/package.json') &&
      !isVersionOnlyPackageJson(packageJsonBefore, packageJsonAfter)
    ) {
      return { ...HEAVY_CODE_SCOPE }
    }
    return { ...VERSION_RELEASE_SCOPE }
  }

  if (files.every(isDocsPath)) return { ...DOCS_SCOPE }
  // A mix of prose and JS tests needs no more than the JS job either.
  if (files.every((file) => isJsTestPath(file) || isDocsPath(file))) return { ...JS_TEST_SCOPE }

  // Plan 242 S15: a pull request that changes only desktop app source no
  // Rust code reads skips the Rust jobs. Pull requests only: a push to main
  // runs every gate for code (the full suite still guards main).
  if (
    eventName === 'pull_request' &&
    files.some(isAppTsPath) &&
    files.every((file) => isAppTsPath(file) || isJsTestPath(file) || isDocsPath(file))
  ) {
    return appTsScope(files)
  }

  return { ...HEAVY_CODE_SCOPE }
}

// The Windows startup incident diagnostics job (windows.yml `incident`) runs
// on a pull request only when the pull request changes what that job runs
// (plan 242 S5). Pushes to main and manual dispatch always run it.
export const WINDOWS_INCIDENT_TOOLING_PATHS = Object.freeze([
  '.github/workflows/windows.yml',
  'scripts/smoke-windows-stream-performance.mjs',
  'scripts/smoke-windows-mf-probe.mjs',
  'scripts/probe-windows-openh264-comparison.mjs',
  'crates/videorc-backend/src/windows_mf_probe.rs'
])
export const WINDOWS_INCIDENT_TOOLING_PREFIXES = Object.freeze([
  'scripts/lib/windows-incident-',
  'scripts/lib/windows-mf-probe',
  'scripts/lib/windows-openh264-comparison',
  'scripts/lib/windows-stream-performance',
  'scripts/lib/windows-owned-pcm-eof'
])

export function isWindowsIncidentToolingPath(path) {
  return (
    WINDOWS_INCIDENT_TOOLING_PATHS.includes(path) ||
    WINDOWS_INCIDENT_TOOLING_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

export function scopeToActionOutputs(scope) {
  return {
    kind: scope.kind,
    windows_heavy: String(scope.windowsHeavy === true),
    linux_heavy: String(scope.linuxHeavy === true),
    macos_rust: String(scope.macosRust === true),
    js: String(scope.js === true),
    windows_incident_tooling: String(scope.windowsIncidentTooling === true),
    // Plan 242 S14: the app sentinel runs wherever the macOS Rust job runs,
    // unless a scope says otherwise.
    macos_sentinel: String((scope.macosSentinel ?? scope.macosRust) === true),
    windows_js: String((scope.windowsJs ?? scope.windowsHeavy) === true),
    windows_installer: String((scope.windowsInstaller ?? scope.windowsHeavy) === true)
  }
}
