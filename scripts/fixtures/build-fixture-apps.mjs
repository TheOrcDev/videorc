#!/usr/bin/env node
// Builds the two fixture apps the scene window-switch probe captures
// (plan 210 S0): "Fixture Alpha" (red, com.videorc.fixture.alpha) and
// "Fixture Beta" (blue, com.videorc.fixture.beta). One `swiftc` compile of
// scripts/fixtures/fixture-window.swift, wrapped twice as `.app` bundles with
// their own Info.plist, under the output directory. Idempotent: a bundle whose
// binary is newer than the source is left alone.
//
// Launch a bundle by executing `<app>/Contents/MacOS/fixture-window` directly:
// the bundle's Info.plist still applies (bundle id, name, colour), and the
// spawned PID is the fixture's PID, so cleanup never has to scan for it.
//
// CLI: node scripts/fixtures/build-fixture-apps.mjs [--out <dir>] [--force]
// prints the built bundles as JSON.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_SOURCE_PATH = join(here, 'fixture-window.swift')
export const FIXTURE_EXECUTABLE_NAME = 'fixture-window'

/** The two fixtures, keyed the way the probe refers to them. */
export const FIXTURE_APP_SPECS = Object.freeze({
  alpha: Object.freeze({
    key: 'alpha',
    bundleId: 'com.videorc.fixture.alpha',
    name: 'Fixture Alpha',
    color: 'red',
    letter: 'A'
  }),
  beta: Object.freeze({
    key: 'beta',
    bundleId: 'com.videorc.fixture.beta',
    name: 'Fixture Beta',
    color: 'blue',
    letter: 'B'
  })
})

/** Default output directory: stable per user so repeated runs reuse the build. */
export function defaultFixtureOutputDir() {
  return join(tmpdir(), 'videorc-fixture-apps')
}

function xmlEscape(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Info.plist text for one fixture bundle. Pure for the unit test. */
export function fixtureInfoPlist(spec) {
  const entries = [
    ['CFBundleDevelopmentRegion', 'en'],
    ['CFBundleExecutable', FIXTURE_EXECUTABLE_NAME],
    ['CFBundleIdentifier', spec.bundleId],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleName', spec.name],
    ['CFBundleDisplayName', spec.name],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '1.0'],
    ['CFBundleVersion', '1'],
    ['LSMinimumSystemVersion', '13.0'],
    ['VideorcFixtureColor', spec.color],
    ['VideorcFixtureTitle', spec.name],
    ['VideorcFixtureLetter', spec.letter]
  ]
  const body = entries
    .map(([key, value]) => `\t<key>${xmlEscape(key)}</key>\n\t<string>${xmlEscape(value)}</string>`)
    .join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    body +
    '\n\t<key>NSHighResolutionCapable</key>\n\t<true/>\n' +
    '\t<key>LSUIElement</key>\n\t<false/>\n' +
    '</dict>\n</plist>\n'
  )
}

function isFresh(target, source) {
  if (!existsSync(target)) return false
  return statSync(target).mtimeMs >= statSync(source).mtimeMs
}

/**
 * Compiles the fixture once and wraps it as both bundles.
 *
 * @param {object} [options]
 * @param {string} [options.outputDir]
 * @param {string} [options.swiftcPath]
 * @param {boolean} [options.force] rebuild even when the binary is fresh
 * @returns {{outputDir:string, executablePath:string, apps:Record<'alpha'|'beta', {
 *   key:string, bundleId:string, name:string, color:string, letter:string,
 *   appPath:string, executablePath:string, infoPlistPath:string
 * }>}}
 */
export function buildFixtureApps({
  outputDir = defaultFixtureOutputDir(),
  swiftcPath = 'swiftc',
  force = false
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Fixture apps are AppKit apps; build them on macOS.')
  }
  const resolvedOutputDir = resolve(outputDir)
  mkdirSync(resolvedOutputDir, { recursive: true })
  const executablePath = join(resolvedOutputDir, FIXTURE_EXECUTABLE_NAME)
  if (force || !isFresh(executablePath, FIXTURE_SOURCE_PATH)) {
    execFileSync(
      swiftcPath,
      ['-O', '-framework', 'AppKit', '-o', executablePath, FIXTURE_SOURCE_PATH],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: 180_000 }
    )
  }

  const apps = {}
  for (const spec of Object.values(FIXTURE_APP_SPECS)) {
    const appPath = join(resolvedOutputDir, `${spec.name}.app`)
    const contents = join(appPath, 'Contents')
    const macos = join(contents, 'MacOS')
    mkdirSync(macos, { recursive: true })
    const bundledExecutable = join(macos, FIXTURE_EXECUTABLE_NAME)
    if (force || !isFresh(bundledExecutable, executablePath)) {
      copyFileSync(executablePath, bundledExecutable)
    }
    const infoPlistPath = join(contents, 'Info.plist')
    const plist = fixtureInfoPlist(spec)
    if (force || !existsSync(infoPlistPath)) {
      writeFileSync(infoPlistPath, plist)
    }
    const pkgInfoPath = join(contents, 'PkgInfo')
    if (!existsSync(pkgInfoPath)) writeFileSync(pkgInfoPath, 'APPL????')
    apps[spec.key] = {
      ...spec,
      appPath,
      executablePath: bundledExecutable,
      infoPlistPath
    }
  }
  return { outputDir: resolvedOutputDir, executablePath, apps }
}

function parseCliArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--out') {
      options.outputDir = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--out=')) {
      options.outputDir = argument.slice('--out='.length)
    } else if (argument === '--force') {
      options.force = true
    }
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildFixtureApps(parseCliArgs(process.argv.slice(2)))
  console.log(JSON.stringify(built, null, 2))
}
