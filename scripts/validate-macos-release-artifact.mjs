#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFile } from 'node:fs/promises'

import {
  findChangelogEntry,
  findChangelogEntryForPackageVersion,
  loadChangelogEntries
} from './lib/changelog.mjs'
import {
  artifactKindFromPath,
  buildMacosReleaseArtifactChecks,
  evaluateBinaryContainsEnvSecretCheck,
  formatArtifactPath,
  formatReleaseArtifactValidationReport,
  sanitizeReleaseValidationOutput,
  selectLatestReleaseArtifacts,
  stdoutExpectationFailures
} from './lib/macos-release-artifact-validation.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(repoRoot, 'apps', 'desktop', 'release')

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS release artifact validation must run on macOS.')
  }

  if (!(await validateChangelogGate())) {
    process.exit(1)
  }

  const artifactPaths =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2).map((path) => resolve(path))
      : (await discoverLatestArtifacts()).map((artifact) => artifact.path)

  if (artifactPaths.length === 0) {
    throw new Error('No .app or .dmg release artifacts found under apps/desktop/release.')
  }

  let allPassed = true
  for (const artifactPath of artifactPaths) {
    const passed = validateArtifact(artifactPath)
    allPassed = allPassed && passed
  }

  process.exit(allPassed ? 0 : 1)
}

// Fail-closed changelog gate: the release being validated must have a valid
// user-facing entry under changelog/. Resolves the releaseId from the release
// manifest when present (release:manifest:macos runs before this), otherwise
// falls back to the desktop package version. VIDEORC_RELEASE_SKIP_CHANGELOG=1
// downgrades a missing entry to a loud warning.
async function validateChangelogGate() {
  const skip = ['1', 'true', 'yes', 'on'].includes(
    process.env.VIDEORC_RELEASE_SKIP_CHANGELOG?.trim().toLowerCase() ?? ''
  )

  let entries
  try {
    entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  } catch (error) {
    const message = `changelog entries failed validation: ${error.message}`
    if (!skip) {
      console.error(`macos-release-artifact: FAIL changelog`)
      console.error(`[fail] ${message}`)
      return false
    }
    console.warn(`[warn] ${message} (VIDEORC_RELEASE_SKIP_CHANGELOG set)`)
    return true
  }

  const releaseId = await resolveReleaseId()
  const entry = releaseId.exact
    ? findChangelogEntry(entries, releaseId.value)
    : findChangelogEntryForPackageVersion(entries, releaseId.value)
  if (entry) {
    console.log(`[ok] changelog entry ${entry.version} (${entry.title})`)
    return true
  }

  const message =
    `no changelog entry for ${releaseId.value}: write changelog/<releaseId>.md ` +
    '(see changelog/README.md) or set VIDEORC_RELEASE_SKIP_CHANGELOG=1'
  if (!skip) {
    console.error('macos-release-artifact: FAIL changelog')
    console.error(`[fail] ${message}`)
    return false
  }
  console.warn(`[warn] ${message} (skipping)`)
  return true
}

async function resolveReleaseId() {
  try {
    const manifest = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'))
    if (typeof manifest.releaseId === 'string' && manifest.releaseId.trim()) {
      return { exact: true, value: manifest.releaseId.trim() }
    }
  } catch {
    // No manifest yet — fall back to the desktop package version below.
  }
  const desktopPackage = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')
  )
  return { exact: false, value: desktopPackage.version }
}

async function discoverLatestArtifacts() {
  if (!existsSync(releaseDir)) {
    return []
  }

  const candidates = await collectArtifacts(releaseDir)
  return selectLatestReleaseArtifacts(candidates)
}

async function collectArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      const info = await stat(path)
      candidates.push({ path, kind: 'app', mtimeMs: info.mtimeMs })
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.dmg')) {
      const info = await stat(path)
      candidates.push({ path, kind: 'dmg', mtimeMs: info.mtimeMs })
      continue
    }

    if (entry.isDirectory()) {
      candidates.push(...(await collectArtifacts(path)))
    }
  }

  return candidates
}

function validateArtifact(artifactPath) {
  if (!existsSync(artifactPath)) {
    console.error(`macos-release-artifact: FAIL ${formatArtifactPath(artifactPath, context())}`)
    console.error('[fail] artifact exists')
    return false
  }

  const kind = artifactKindFromPath(artifactPath)
  if (!kind) {
    console.error(`macos-release-artifact: FAIL ${formatArtifactPath(artifactPath, context())}`)
    console.error('[fail] unsupported artifact type; expected .app or .dmg')
    return false
  }

  const checks = buildMacosReleaseArtifactChecks(artifactPath)
  const results = checks.map(runCheck)
  const artifactLabel = formatArtifactPath(artifactPath, context())
  const report = formatReleaseArtifactValidationReport({ artifactLabel, results })
  if (results.every((result) => result.ok)) {
    console.log(report)
    return true
  }

  console.error(report)
  return false
}

function runCheck(check) {
  if (check.type === 'binary-contains-env-secret') {
    const result = evaluateBinaryContainsEnvSecretCheck(check)
    return {
      label: check.label,
      ok: result.ok,
      output: sanitizeReleaseValidationOutput(result.output, context())
    }
  }

  const result = spawnSync(check.command, check.args, {
    encoding: 'utf8'
  })
  const rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n')
  // Some checks assert on what the command PRINTS, not just its exit status —
  // e.g. the capture-entitlement gate requires the device entitlements to appear
  // in `codesign -d --entitlements` output (a signed binary without them exits 0).
  const missing = (check.expectOutputIncludes ?? []).filter((needle) => !rawOutput.includes(needle))
  const stdoutFailures = stdoutExpectationFailures(check, result.stdout)
  const output = sanitizeReleaseValidationOutput(
    [
      rawOutput,
      ...missing.map((needle) => `missing required entitlement: ${needle}`),
      ...stdoutFailures
    ]
      .filter(Boolean)
      .join('\n'),
    context()
  )

  return {
    label: check.label,
    ok: result.status === 0 && missing.length === 0 && stdoutFailures.length === 0,
    output
  }
}

function context() {
  return {
    repoRoot,
    homeDir: homedir()
  }
}

main().catch((error) => {
  console.error(`macos-release-artifact: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
