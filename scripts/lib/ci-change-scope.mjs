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
  JS_TEST: 'js-test'
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
  js: true
})

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

  return { ...HEAVY_CODE_SCOPE }
}

export function scopeToActionOutputs(scope) {
  return {
    kind: scope.kind,
    windows_heavy: String(scope.windowsHeavy === true),
    linux_heavy: String(scope.linuxHeavy === true),
    macos_rust: String(scope.macosRust === true),
    js: String(scope.js === true)
  }
}
