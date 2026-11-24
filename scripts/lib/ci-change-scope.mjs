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

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Plan 242 S15: desktop app paths the Rust crates include or read at build or
// test time. A change to any of them can change a Rust result, so it is code.
//
// These two directories are read as a whole (the shared contract mirrors and
// the assets the backend compiles in), so every file under them counts.
export const RUST_READS_DESKTOP_PREFIXES = Object.freeze([
  'apps/desktop/src/shared/',
  'apps/desktop/src/renderer/src/assets/'
])

// Plan 260: every other path is found at run time, not kept by hand. Every
// string literal in a crate's Rust code (comments skipped) that names an
// apps/desktop path, from include_str!, include_bytes!, read_to_string or a
// fixture path, is a Rust read. A templated path ("…/{name}.ts") counts as
// its whole directory. A scan that finds nothing is broken, and then every
// desktop path counts as Rust (fail closed).
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SKIPPED_DIRS = new Set(['target', 'node_modules'])
const PATH_TEMPLATE_RE = /[{}*%$]/

function isIdentChar(char) {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/** The string literals in Rust source, in order, with comments skipped. */
export function rustStringLiterals(source) {
  const literals = []
  const length = source.length
  let i = 0
  while (i < length) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      // Rust block comments nest.
      let depth = 1
      i += 2
      while (i < length && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++
          i += 2
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    const rawStart =
      char === 'r' &&
      (next === '"' || next === '#') &&
      (!isIdentChar(source[i - 1]) || (source[i - 1] === 'b' && !isIdentChar(source[i - 2])))
    if (rawStart) {
      let j = i + 1
      let hashes = 0
      while (source[j] === '#') {
        hashes++
        j++
      }
      if (source[j] === '"') {
        const close = `"${'#'.repeat(hashes)}`
        const end = source.indexOf(close, j + 1)
        literals.push(source.slice(j + 1, end < 0 ? length : end))
        i = end < 0 ? length : end + close.length
        continue
      }
      // A raw identifier (r#type): not a string.
      i = j
      continue
    }
    if (char === '"') {
      let j = i + 1
      let value = ''
      while (j < length && source[j] !== '"') {
        if (source[j] === '\\') {
          value += source.slice(j, j + 2)
          j += 2
        } else {
          value += source[j]
          j++
        }
      }
      literals.push(value)
      i = j + 1
      continue
    }
    if (char === "'") {
      // A char literal ('"', '\'', '\u{..}'), or a lifetime or label.
      if (next === '\\') {
        const end = source.indexOf("'", i + 3)
        i = end < 0 ? length : end + 1
        continue
      }
      const codePoint = source.codePointAt(i + 1)
      const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1
      i += source[i + 1 + width] === "'" ? 2 + width : 1
      continue
    }
    i++
  }
  return literals
}

/** The apps/desktop paths a Rust source names in its code. */
export function desktopPathsInRust(source) {
  const paths = []
  for (const literal of rustStringLiterals(source)) {
    const at = literal.indexOf('apps/desktop')
    if (at < 0) continue
    let path = literal.slice(at)
    const template = path.search(PATH_TEMPLATE_RE)
    if (template >= 0) path = path.slice(0, path.lastIndexOf('/', template))
    path = path.replace(/\/+$/, '')
    if (path) paths.push(path)
  }
  return paths
}

function rustFiles(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) rustFiles(path, files)
    else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path)
  }
  return files
}

/** Every apps/desktop path the crates under `root` name, sorted, once each. */
export function scanRustReadDesktopPaths(root = REPO_ROOT) {
  const found = new Set()
  try {
    for (const file of rustFiles(join(root, 'crates'), [])) {
      for (const path of desktopPathsInRust(readFileSync(file, 'utf8'))) found.add(path)
    }
  } catch {
    return []
  }
  return [...found].sort()
}

let scanned = null
/** This checkout's Rust-read desktop paths, scanned once per run. */
export function rustReadDesktopPaths() {
  scanned ??= Object.freeze(scanRustReadDesktopPaths())
  return scanned
}

export function isRustReachableDesktopPath(path, reads = rustReadDesktopPaths()) {
  if (reads.length === 0) return true
  return (
    RUST_READS_DESKTOP_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    reads.some((read) => path === read || path.startsWith(`${read}/`))
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
