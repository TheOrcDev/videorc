import { execFile } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export const CAPTURE_DECAY_APP_BUNDLE_PROFILE = 'capture-decay-app-bundle-v1'

// Read-only image mounts may present different read/write bits. Preserve the
// set-ID, sticky, and execute bits that affect launch and security semantics.
const SIGNIFICANT_MODE_MASK = 0o7111n
const execFileAsync = promisify(execFile)

export class CaptureDecayAppBundleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CaptureDecayAppBundleError'
    this.code = code
  }
}

export function captureDecayAppBundlePaths(executablePath, label = 'app executable') {
  const executable = resolve(requiredText(executablePath, label))
  const macosDirectory = dirname(executable)
  const contentsDirectory = dirname(macosDirectory)
  const bundlePath = dirname(contentsDirectory)
  if (
    basename(macosDirectory) !== 'MacOS' ||
    basename(contentsDirectory) !== 'Contents' ||
    !basename(bundlePath).endsWith('.app')
  ) {
    throw bundleError(
      'app-bundle-executable-path',
      `${label} must be exactly inside a .app/Contents/MacOS directory.`
    )
  }
  const executableRelativePath = portableRelativePath(bundlePath, executable, label)
  return { bundlePath, executablePath: executable, executableRelativePath }
}

export async function captureDecayAppBundleManifest(bundlePath) {
  const root = resolve(requiredText(bundlePath, 'app bundle path'))
  const rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || !basename(root).endsWith('.app')) {
    throw bundleError('app-bundle-root', 'App bundle root must be a real .app directory.')
  }

  const entries = []
  await collectDirectoryEntries(root, root, '', entries)
  entries.sort((left, right) => compareUtf8(left.path, right.path))
  return {
    schemaVersion: 1,
    profile: CAPTURE_DECAY_APP_BUNDLE_PROFILE,
    bundleFilename: basename(root),
    mode: significantMode(rootStat.mode),
    entries
  }
}

export async function captureDecayAppBundleIdentityFromExecutable(executablePath) {
  const paths = captureDecayAppBundlePaths(executablePath)
  const manifest = await captureDecayAppBundleManifest(paths.bundlePath)
  const executable = manifest.entries.find((entry) => entry.path === paths.executableRelativePath)
  if (executable?.type !== 'file' || (Number.parseInt(executable.mode, 8) & 0o111) === 0) {
    throw bundleError(
      'app-bundle-executable',
      'Bound app executable must be an executable regular file in the bundle manifest.'
    )
  }
  const regularFiles = manifest.entries.filter((entry) => entry.type === 'file')
  return {
    profile: CAPTURE_DECAY_APP_BUNDLE_PROFILE,
    bundleFilename: manifest.bundleFilename,
    executableRelativePath: paths.executableRelativePath,
    manifestSha256: sha256Json(manifest),
    entryCount: manifest.entries.length,
    regularFileCount: regularFiles.length,
    totalRegularFileSizeBytes: regularFiles.reduce((total, entry) => total + entry.sizeBytes, 0)
  }
}

export function normalizeCaptureDecayAppBundleIdentity(identity, label = 'app bundle') {
  if (identity?.profile !== CAPTURE_DECAY_APP_BUNDLE_PROFILE) {
    throw bundleError(
      'app-bundle-profile',
      `${label} must use ${CAPTURE_DECAY_APP_BUNDLE_PROFILE}.`
    )
  }
  const bundleFilename = requiredText(identity?.bundleFilename, `${label} filename`)
  if (bundleFilename !== basename(bundleFilename) || !bundleFilename.endsWith('.app')) {
    throw bundleError(
      'app-bundle-filename',
      `${label} filename must be one basename ending in .app.`
    )
  }
  const executableRelativePath = requiredText(
    identity?.executableRelativePath,
    `${label} executable relative path`
  )
  const executableFilename = executableRelativePath.slice('Contents/MacOS/'.length)
  if (
    !/^Contents\/MacOS\/[^/]+$/.test(executableRelativePath) ||
    executableFilename === '.' ||
    executableFilename === '..'
  ) {
    throw bundleError(
      'app-bundle-executable-path',
      `${label} executable path must be exactly Contents/MacOS/<executable>.`
    )
  }
  const entryCount = positiveSafeInteger(identity?.entryCount, `${label} entry count`)
  const regularFileCount = positiveSafeInteger(
    identity?.regularFileCount,
    `${label} regular-file count`
  )
  if (regularFileCount > entryCount) {
    throw bundleError(
      'app-bundle-count',
      `${label} regular-file count cannot exceed its total entry count.`
    )
  }
  return {
    profile: CAPTURE_DECAY_APP_BUNDLE_PROFILE,
    bundleFilename,
    executableRelativePath,
    manifestSha256: requireSha256(identity?.manifestSha256, `${label} manifest SHA-256`),
    entryCount,
    regularFileCount,
    totalRegularFileSizeBytes: positiveSafeInteger(
      identity?.totalRegularFileSizeBytes,
      `${label} regular-file byte size`
    )
  }
}

export function assertCaptureDecayAppBundleIdentityEqual(expected, actual, label = 'app bundle') {
  const normalizedExpected = normalizeCaptureDecayAppBundleIdentity(expected, `expected ${label}`)
  const normalizedActual = normalizeCaptureDecayAppBundleIdentity(actual, label)
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw bundleError(
      'app-bundle-identity-mismatch',
      `${label} does not match the exact deterministic app-bundle manifest.`
    )
  }
  return normalizedActual
}

export async function verifyCaptureDecayDmgAppBundle(
  { dmgPath, expectedIdentity },
  { runHdiutil = defaultRunHdiutil } = {}
) {
  const imagePath = resolve(requiredText(dmgPath, 'candidate DMG path'))
  const imageStat = await lstat(imagePath)
  if (!imageStat.isFile() || imageStat.size <= 0) {
    throw bundleError('dmg-artifact', 'Candidate DMG must be a non-empty regular file.')
  }
  const expected = normalizeCaptureDecayAppBundleIdentity(expectedIdentity, 'candidate app bundle')
  const ownerDirectory = await mkdtemp(join(tmpdir(), 'videorc-capture-decay-dmg-'))
  const mountpoint = join(ownerDirectory, 'mount')
  await mkdir(mountpoint, { mode: 0o700 })
  let attachAttempted = false
  let detachError = null
  let operationError = null
  let result = null
  try {
    attachAttempted = true
    await runHdiutil([
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountpoint,
      imagePath
    ])
    const mountedEntries = await readdir(mountpoint, { withFileTypes: true })
    const appEntries = mountedEntries.filter((entry) => entry.name.endsWith('.app'))
    if (appEntries.length !== 1 || appEntries[0].name !== expected.bundleFilename) {
      throw bundleError(
        'dmg-app-bundle-count',
        `Candidate DMG must contain exactly one top-level ${expected.bundleFilename} app bundle.`
      )
    }
    const mountedExecutable = join(
      mountpoint,
      expected.bundleFilename,
      ...expected.executableRelativePath.split('/')
    )
    const mountedIdentity = await captureDecayAppBundleIdentityFromExecutable(mountedExecutable)
    result = assertCaptureDecayAppBundleIdentityEqual(
      expected,
      mountedIdentity,
      'candidate DMG app bundle'
    )
  } catch (error) {
    operationError = error
  } finally {
    if (attachAttempted) {
      try {
        await detachDmg(runHdiutil, mountpoint)
      } catch (error) {
        detachError = error
      }
    }
    if (detachError === null) {
      await rm(ownerDirectory, { force: true, recursive: true })
    }
  }
  if (operationError !== null) {
    if (detachError !== null) operationError.detachError = detachError
    throw operationError
  }
  if (detachError !== null) throw detachError
  return result
}

async function collectDirectoryEntries(root, directory, relativeDirectory, entries) {
  const names = await readdir(directory)
  names.sort(compareUtf8)
  for (const name of names) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
    assertSafeManifestPath(relativePath)
    const path = resolve(directory, name)
    if (!isContained(root, path)) {
      throw bundleError('app-bundle-path', `App bundle entry escapes its root: ${relativePath}`)
    }
    const entryStat = await lstat(path, { bigint: true })
    if (entryStat.isDirectory()) {
      entries.push({
        path: relativePath,
        type: 'directory',
        mode: significantMode(entryStat.mode)
      })
      await collectDirectoryEntries(root, path, relativePath, entries)
      continue
    }
    if (entryStat.isFile()) {
      entries.push(await regularFileEntry(path, relativePath))
      continue
    }
    if (entryStat.isSymbolicLink()) {
      const target = await readlink(path)
      assertSafeSymlink(root, path, relativePath, target)
      entries.push({
        path: relativePath,
        type: 'symlink',
        mode: significantMode(entryStat.mode),
        target
      })
      continue
    }
    throw bundleError(
      'app-bundle-special-entry',
      `App bundle contains a socket, device, FIFO, or other special entry: ${relativePath}`
    )
  }
}

async function regularFileEntry(path, relativePath) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) {
      throw bundleError(
        'app-bundle-file-race',
        `App bundle regular file changed type while hashing: ${relativePath}`
      )
    }
    const hash = createHash('sha256')
    const stream = createReadStream('', { autoClose: false, fd: handle.fd })
    for await (const chunk of stream) hash.update(chunk)
    const after = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(before, after)) {
      throw bundleError(
        'app-bundle-mutated',
        `App bundle regular file changed while hashing: ${relativePath}`
      )
    }
    return {
      path: relativePath,
      type: 'file',
      mode: significantMode(before.mode),
      sizeBytes: Number(before.size),
      sha256: hash.digest('hex')
    }
  } finally {
    await handle.close()
  }
}

function assertSafeSymlink(root, path, relativePath, target) {
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    target.includes('\0') ||
    isAbsolute(target)
  ) {
    throw bundleError(
      'app-bundle-unsafe-symlink',
      `App bundle symlink must use a non-empty relative target: ${relativePath}`
    )
  }
  if (!isContained(root, resolve(dirname(path), target))) {
    throw bundleError(
      'app-bundle-unsafe-symlink',
      `App bundle symlink target escapes its root: ${relativePath} -> ${target}`
    )
  }
}

function assertSafeManifestPath(path) {
  const components = path.split('/')
  if (
    path.length === 0 ||
    path.includes('\0') ||
    components.some(
      (component) => component.length === 0 || component === '.' || component === '..'
    )
  ) {
    throw bundleError('app-bundle-path', `App bundle entry path is unsafe: ${JSON.stringify(path)}`)
  }
}

function portableRelativePath(root, path, label) {
  const value = relative(root, path)
  if (value.length === 0 || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw bundleError('app-bundle-path', `${label} escapes its app bundle.`)
  }
  return value.split(sep).join('/')
}

function isContained(root, path) {
  const value = relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function significantMode(mode) {
  return (mode & SIGNIFICANT_MODE_MASK).toString(8).padStart(4, '0')
}

function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

async function defaultRunHdiutil(args) {
  try {
    await execFileAsync('/usr/bin/hdiutil', args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 120_000
    })
  } catch (error) {
    throw bundleError(
      'dmg-hdiutil',
      `hdiutil ${args[0] ?? 'operation'} failed: ${error?.message ?? String(error)}`
    )
  }
}

async function detachDmg(runHdiutil, mountpoint) {
  try {
    await runHdiutil(['detach', mountpoint])
  } catch (normalError) {
    try {
      await runHdiutil(['detach', '-force', mountpoint])
    } catch (forceError) {
      const error = bundleError(
        'dmg-detach',
        `Failed to detach owned candidate DMG mountpoint: ${mountpoint}`
      )
      error.cause = new AggregateError([normalError, forceError])
      throw error
    }
  }
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw bundleError('app-bundle-input', `${label} is required.`)
  }
  return value.trim()
}

function requireSha256(value, label) {
  const normalized = requiredText(value, label)
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw bundleError('app-bundle-sha256', `${label} must be 64 lowercase hexadecimal characters.`)
  }
  return normalized
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw bundleError('app-bundle-count', `${label} must be a positive safe integer.`)
  }
  return value
}

function bundleError(code, message) {
  return new CaptureDecayAppBundleError(code, message)
}
