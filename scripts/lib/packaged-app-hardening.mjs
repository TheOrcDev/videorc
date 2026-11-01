import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Plan 0002 (retest 152): what a packaged Videorc must prove before it ships.
// The fuses mirror `electronFuses` in apps/desktop/electron-builder.yml (a test
// pins the two together); the build flags come from electron.vite.config.ts.

/** @electron/fuses FuseState values (char codes of '0', '1', 'r'). */
export const FUSE_STATE = Object.freeze({ DISABLE: 48, ENABLE: 49, REMOVED: 114 })

/** FuseV1Options name -> required state. */
export const REQUIRED_FUSES = Object.freeze({
  RunAsNode: 'disabled',
  EnableNodeOptionsEnvironmentVariable: 'disabled',
  EnableNodeCliInspectArguments: 'disabled',
  OnlyLoadAppFromAsar: 'enabled'
})

/** electron-builder `electronFuses` key -> FuseV1Options name. */
export const BUILDER_FUSE_KEYS = Object.freeze({
  runAsNode: 'RunAsNode',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar'
})

export const BUILD_FLAGS_ASAR_PATH = 'out/main/videorc-build-flags.json'

function fuseStateName(value) {
  if (value === FUSE_STATE.DISABLE) return 'disabled'
  if (value === FUSE_STATE.ENABLE) return 'enabled'
  if (value === FUSE_STATE.REMOVED) return 'removed'
  return 'missing'
}

/**
 * Pure. `wire` is getCurrentFuseWire()'s result (option index -> state) and
 * `optionIndex` is FuseV1Options (name -> index). Returns one line per fuse
 * in the wrong state.
 */
export function fuseWireProblems(wire, optionIndex) {
  const problems = []
  for (const [name, required] of Object.entries(REQUIRED_FUSES)) {
    const index = optionIndex[name]
    const actual = fuseStateName(wire?.[index])
    if (actual !== required) {
      problems.push(`${name} is ${actual}, expected ${required}`)
    }
  }
  return problems
}

/** Pure. The fuse wire as `{ name: state }` for the report. */
export function describeFuseWire(wire, optionIndex) {
  return Object.fromEntries(
    Object.entries(optionIndex)
      .filter(([name]) => Number.isNaN(Number(name)))
      .map(([name, index]) => [name, fuseStateName(wire?.[index])])
  )
}

/** Pure. A builder `electronFuses` block that disagrees with REQUIRED_FUSES. */
export function builderFuseConfigProblems(electronFuses) {
  const problems = []
  for (const [key, name] of Object.entries(BUILDER_FUSE_KEYS)) {
    const expected = REQUIRED_FUSES[name] === 'enabled'
    if (electronFuses?.[key] !== expected) {
      problems.push(`electronFuses.${key} must be ${expected}`)
    }
  }
  return problems
}

/** Pure. Build flags read from the artifact; a release must not be a test build. */
export function buildFlagsProblems(flags, { allowTestHooks = false } = {}) {
  if (!flags || typeof flags.packagedTestHooks !== 'boolean') {
    return [`${BUILD_FLAGS_ASAR_PATH} is missing or malformed`]
  }
  if (flags.packagedTestHooks && !allowTestHooks) {
    return [
      'this is a packaged test build (VIDEORC_PACKAGED_TEST_HOOKS=1): it honours the CDP port and native module overrides and must not ship'
    ]
  }
  return []
}

/**
 * Pure. Reads one file out of an asar archive buffer (header pickle, then
 * file bodies at `8 + headerSize + offset`). Returns null when absent.
 */
export function readAsarEntry(buffer, innerPath) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 4) {
    throw new Error('Not an asar archive.')
  }
  const headerSize = buffer.readUInt32LE(4)
  const jsonLength = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
  let node = header
  for (const part of innerPath.split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (!node) return null
  }
  if (node.files || node.unpacked || typeof node.offset !== 'string') {
    return null
  }
  const start = 8 + headerSize + Number(node.offset)
  return buffer.subarray(start, start + node.size)
}

/** The resources directory of a packaged app, from its executable or .app path. */
export function resourcesDirForApp(appPath, platform = process.platform) {
  const path = resolve(String(appPath))
  if (path.endsWith('.app')) {
    return join(path, 'Contents', 'Resources')
  }
  if (platform === 'darwin') {
    return resolve(dirname(path), '..', 'Resources')
  }
  return join(dirname(path), 'resources')
}

export function readPackagedBuildFlags(appPath, platform = process.platform) {
  const asarPath = join(resourcesDirForApp(appPath, platform), 'app.asar')
  const entry = readAsarEntry(readFileSync(asarPath), BUILD_FLAGS_ASAR_PATH)
  return entry ? JSON.parse(entry.toString('utf8')) : null
}
