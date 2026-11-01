import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  LINUX_ALPHA_UPDATE_FEED_NAME,
  parseLinuxUpdateFeed
} from '../../lib/linux-alpha-release.mjs'
import { refuse } from './install-runner.mjs'
import { RELEASE_FEED_URL, downloadVerified, hashingStream } from './install-sources.mjs'

// Plan 179: the build under test on the Linux lab box.
//
// The install target is a DIRECTORY holding an extracted AppImage
// (squashfs-root), not the AppImage file: no FUSE is needed, and the harness
// spawns <appPath>/videorc itself, so it owns that exact PID. Linux builds
// are unsigned (no GPG lane), so trust comes from the published hash alone:
//   release          latest-linux.yml sha512 (the updater feed; not public yet)
//   file:<AppImage>  a sha256 from --sha256, <AppImage>.sha256 or release.json
//   local:<dir>      none: an unpacked build from this machine, recorded as
//                    source local-build, verified local
// An AppImage is never executed before its hash matched and its header is a
// type-2 AppImage; `--appimage-extract` is the only thing it is asked to do.

export const LINUX_FEED_FILE = LINUX_ALPHA_UPDATE_FEED_NAME
export const LINUX_EXECUTABLE = 'videorc'
// Everything a lab run needs from the build, each an executable file.
export const LINUX_REQUIRED_FILES = Object.freeze([
  LINUX_EXECUTABLE,
  'resources/videorc-backend',
  'resources/ffmpeg/bin/ffmpeg'
])
export const RELEASE_MANIFEST_FILE = 'release.json'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
// AppImage type 2: "AI" then 0x02 at byte 8 of the ELF header (e_ident padding).
const APPIMAGE_TYPE2_MAGIC = Buffer.from([0x41, 0x49, 0x02])
const SHA256_HEX = /^[0-9a-f]{64}$/
const APPIMAGE_NAME_VERSION =
  /^Videorc-([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?)-linux-x64\.AppImage$/

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function lastLines(text, count = 4) {
  return String(text).trim().split(/\r?\n/).slice(-count).join(' | ')
}

/** The version in a canonical `Videorc-<version>-linux-x64.AppImage` name, else null. */
export function appImageVersionFromName(name) {
  return APPIMAGE_NAME_VERSION.exec(name)?.[1] ?? null
}

// --- sources -----------------------------------------------------------

export async function fetchLinuxRelease({ fetchImpl, feedUrl = RELEASE_FEED_URL, downloadDir }) {
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
  const feedHref = new URL(LINUX_FEED_FILE, base).href
  const feedResponse = await fetchImpl(feedHref)
  if ([401, 403, 404].includes(feedResponse.status)) {
    refuse(
      'linux-feed-unavailable',
      `${feedHref} answered HTTP ${feedResponse.status}: the Linux Alpha updater feed is not public. Download the AppImage and its .sha256 from videorc.com while signed in, then run pnpm live:install --build file:<AppImage>.`
    )
  }
  if (!feedResponse.ok) {
    throw new Error(`Could not read ${LINUX_FEED_FILE}: HTTP ${feedResponse.status}`)
  }
  let feed
  try {
    // The release tooling's own strict parser: one x64 AppImage, sha512, size.
    feed = parseLinuxUpdateFeed(await feedResponse.text())
  } catch (error) {
    throw new Error(`${LINUX_FEED_FILE} is not a Linux x64 AppImage feed: ${error.message}`)
  }
  const appImagePath = join(downloadDir, basename(feed.path))
  await downloadVerified({
    fetchImpl,
    url: new URL(feed.path, base).href,
    dest: appImagePath,
    sha512: feed.sha512,
    size: feed.files[0].size,
    feedName: LINUX_FEED_FILE,
    what: 'AppImage'
  })
  return {
    appImagePath,
    expectedVersion: feed.version,
    verified: 'sha512',
    record: { source: 'release', version: feed.version, sha: null, feedUrl: base }
  }
}

/** `<hex>  <file>` (sha256sum, and release-linux-alpha.yml's .sha256), else null. */
export function parseSha256File(text) {
  const match = /^([0-9a-fA-F]{64}) [ *]?(\S.*)$/.exec(String(text).split(/\r?\n/)[0].trim())
  return match ? { sha256: match[1].toLowerCase(), name: match[2].trim() } : null
}

// The sha256 for a local AppImage, in order: --sha256, <AppImage>.sha256,
// release.json beside it. No hash means no install.
export async function findAppImageHash(appImagePath, { sha256 = null } = {}) {
  const name = basename(appImagePath)
  const nameVersion = appImageVersionFromName(name)
  if (sha256 !== null && sha256 !== undefined) {
    const hex = String(sha256).trim().toLowerCase()
    if (!SHA256_HEX.test(hex)) refuse('hash-invalid', '--sha256 must be 64 hex characters.')
    return { sha256: hex, hashFrom: '--sha256', expectedVersion: nameVersion }
  }
  const sidecarName = `${name}.sha256`
  const sidecarText = await readOptional(`${appImagePath}.sha256`)
  if (sidecarText !== null) {
    const parsed = parseSha256File(sidecarText)
    if (!parsed || parsed.name !== name) {
      refuse(
        'hash-invalid',
        `${sidecarName} must read "<sha256>  ${name}"${parsed ? `; it names ${parsed.name}` : ''}.`
      )
    }
    return { sha256: parsed.sha256, hashFrom: sidecarName, expectedVersion: nameVersion }
  }
  const manifestText = await readOptional(join(dirname(appImagePath), RELEASE_MANIFEST_FILE))
  if (manifestText !== null) {
    let manifest
    try {
      manifest = JSON.parse(manifestText)
    } catch {
      refuse('hash-invalid', `${RELEASE_MANIFEST_FILE} next to ${name} is not valid JSON.`)
    }
    if (manifest?.filename !== name) {
      refuse(
        'no-hash',
        `${RELEASE_MANIFEST_FILE} next to ${name} describes ${manifest?.filename ?? 'no file'}. Pass --sha256 <hex> or put ${sidecarName} next to it.`
      )
    }
    const hex = String(manifest.sha256 ?? '').toLowerCase()
    if (!SHA256_HEX.test(hex)) refuse('hash-invalid', `${RELEASE_MANIFEST_FILE} has no sha256.`)
    const text = (value) => (typeof value === 'string' && value ? value : null)
    return {
      sha256: hex,
      hashFrom: RELEASE_MANIFEST_FILE,
      expectedVersion: text(manifest.bundleVersion) ?? nameVersion,
      sizeBytes: Number.isSafeInteger(manifest.sizeBytes) ? manifest.sizeBytes : null,
      releaseId: text(manifest.releaseId),
      sourceCommit: /^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? '')
        ? manifest.sourceCommit
        : null
    }
  }
  refuse(
    'no-hash',
    `No sha256 for ${name}. Pass --sha256 <hex>, or put ${sidecarName} or ${RELEASE_MANIFEST_FILE} (both published with every Linux Alpha) next to it. live:install never installs an unverified binary.`
  )
}

// Copies the AppImage into the download dir, hashing on the way: what gets
// extracted is exactly the bytes that matched.
export async function copyVerified({ source, dest, sha256, size = null, hashFrom }) {
  const hasher = hashingStream('sha256', 'hex')
  await pipeline(createReadStream(source), hasher.stream, createWriteStream(dest, { mode: 0o600 }))
  if (size !== null && hasher.bytes() !== size) {
    refuse(
      'size-mismatch',
      `${basename(source)} is ${hasher.bytes()} bytes, ${hashFrom} says ${size}.`
    )
  }
  if (hasher.digest() !== sha256) {
    refuse('sha256-mismatch', `${basename(source)} does not match the sha256 from ${hashFrom}.`)
  }
}

async function requireBuildPath(path, { directory }) {
  const info = await stat(path).catch(() => null)
  if (!info || (directory ? !info.isDirectory() : !info.isFile())) {
    refuse('build-not-found', `There is no ${directory ? 'directory' : 'file'} at ${path}.`)
  }
}

export async function fetchLinuxFile({ path, sha256 = null, downloadDir }) {
  await requireBuildPath(path, { directory: false })
  const hash = await findAppImageHash(path, { sha256 })
  const appImagePath = join(downloadDir, basename(path))
  await copyVerified({
    source: path,
    dest: appImagePath,
    sha256: hash.sha256,
    size: hash.sizeBytes ?? null,
    hashFrom: hash.hashFrom
  })
  return {
    appImagePath,
    expectedVersion: hash.expectedVersion,
    verified: 'sha256',
    hashFrom: hash.hashFrom,
    record: {
      source: 'file',
      version: hash.expectedVersion,
      sha: hash.sourceCommit ?? null,
      file: basename(path),
      sha256: hash.sha256,
      hashFrom: hash.hashFrom,
      ...(hash.releaseId ? { releaseId: hash.releaseId } : {})
    }
  }
}

// --- staging -----------------------------------------------------------

export async function assertAppImageMagic(appImagePath) {
  const header = Buffer.alloc(11)
  const handle = await open(appImagePath, 'r')
  let bytesRead
  try {
    ;({ bytesRead } = await handle.read(header, 0, header.length, 0))
  } finally {
    await handle.close()
  }
  if (
    bytesRead < header.length ||
    !header.subarray(0, 4).equals(ELF_MAGIC) ||
    !header.subarray(8, 11).equals(APPIMAGE_TYPE2_MAGIC)
  ) {
    refuse(
      'not-an-appimage',
      `${basename(appImagePath)} is not a type-2 AppImage (an ELF file with "AI\\x02" at byte 8). Refusing to run it.`
    )
  }
}

// Call only after the hash matched. The AppImage runtime unpacks itself into
// ./squashfs-root, so it runs with cwd = <staging>/extract (same volume as
// the target, so the swap is a rename).
export async function extractAppImage(runner, appImagePath, stagingDir) {
  await assertAppImageMagic(appImagePath)
  await chmod(appImagePath, 0o755)
  const target = join(stagingDir, 'extract')
  await mkdir(target)
  const result = await runner(appImagePath, ['--appimage-extract'], {
    cwd: target,
    timeoutMs: 10 * 60_000
  })
  if (result.code !== 0) {
    throw new Error(
      `${basename(appImagePath)} --appimage-extract failed (exit ${result.code}): ${lastLines(result.stderr)}`
    )
  }
  const root = join(target, 'squashfs-root')
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) {
    refuse(
      'unexpected-archive',
      `${basename(appImagePath)} --appimage-extract left no squashfs-root.`
    )
  }
  return root
}

// local:<dir>: copied, not moved, so the build dir stays usable.
export async function stageLocalBuild(localDir, stagingDir) {
  await requireBuildPath(localDir, { directory: true })
  const target = join(stagingDir, 'extract', 'local')
  await mkdir(dirname(target), { recursive: true })
  await cp(localDir, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true })
  return target
}

// --- verification ------------------------------------------------------

export function parseDesktopVersion(text) {
  return /^X-AppImage-Version=(.+)$/m.exec(String(text))?.[1]?.trim() || null
}

// package.json's version inside resources/app.asar (a linux-unpacked dir has
// no .desktop file). asar: [u32 4][u32 headerSize] then a pickle holding
// [u32][u32 jsonLength][json]; file data starts at 8 + headerSize.
export async function readAsarPackageVersion(asarPath) {
  let handle
  try {
    handle = await open(asarPath, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const sizes = Buffer.alloc(8)
    await handle.read(sizes, 0, 8, 0)
    const headerSize = sizes.readUInt32LE(4)
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024) return null
    const headerBuffer = Buffer.alloc(headerSize)
    await handle.read(headerBuffer, 0, headerSize, 8)
    const jsonLength = headerBuffer.readUInt32LE(4)
    const header = JSON.parse(headerBuffer.subarray(8, 8 + jsonLength).toString('utf8'))
    const entry = header?.files?.['package.json']
    if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > 1024 * 1024) {
      return null
    }
    const data = Buffer.alloc(entry.size)
    await handle.read(data, 0, entry.size, 8 + headerSize + Number(entry.offset))
    const version = JSON.parse(data.toString('utf8'))?.version
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** { version, from }: the top-level *.desktop X-AppImage-Version, else app.asar. */
export async function readLinuxAppVersion(appDir) {
  let names
  try {
    names = await readdir(appDir)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { version: null, from: null }
    throw error
  }
  for (const name of names.filter((entry) => entry.endsWith('.desktop')).sort()) {
    const version = parseDesktopVersion(await readOptional(join(appDir, name)))
    if (version) return { version, from: name }
  }
  const asarVersion = await readAsarPackageVersion(join(appDir, 'resources', 'app.asar'))
  if (asarVersion) return { version: asarVersion, from: 'resources/app.asar' }
  return { version: null, from: null }
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

// Structural: an unsigned Linux build has nothing else to check. The version
// is the .desktop X-AppImage-Version (or app.asar's), falling back to the one
// the feed or hash source named; it must equal that one when both exist.
export async function verifyLinuxApp(appDir, { expectedVersion = null } = {}) {
  const missing = []
  for (const file of LINUX_REQUIRED_FILES) {
    if (!(await isExecutableFile(join(appDir, file)))) missing.push(file)
  }
  if (missing.length > 0) {
    refuse(
      'app-incomplete',
      `The build has no executable ${missing.join(', ')}. Refusing to install it.`
    )
  }
  const read = await readLinuxAppVersion(appDir)
  const version = read.version ?? expectedVersion
  if (expectedVersion !== null && version !== expectedVersion) {
    refuse(
      'version-mismatch',
      `The app reports version ${version} (${read.from}), expected ${expectedVersion}.`
    )
  }
  return { version, versionFrom: read.from ?? (version === null ? null : 'expected') }
}
