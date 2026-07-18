import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { load as parseYaml } from 'js-yaml'

export const WINDOWS_UNSIGNED_STAGING_SCHEMA_VERSION = 1
export const WINDOWS_UNSIGNED_STAGING_ROOT = 'win-unpacked'

const REQUIRED_FILES = [
  'Videorc.exe',
  'resources/app-update.yml',
  'resources/app.asar',
  'resources/ffmpeg/LICENSE.txt',
  'resources/ffmpeg/SOURCE.txt',
  'resources/ffmpeg/bin/ffmpeg.exe',
  'resources/ffmpeg/bin/ffprobe.exe',
  'resources/videorc-backend.exe'
]

export async function createWindowsUnsignedStagingManifest({
  publisherName,
  releaseId,
  rootDir,
  sourceCommit
}) {
  assertReleaseId(releaseId)
  assertSourceCommit(sourceCommit)
  assertPublisherName(publisherName)

  const files = await inventoryFiles(rootDir)
  assertRequiredFiles(files.map((entry) => entry.path))
  await verifyUpdatePublisher(rootDir, publisherName)

  return {
    files,
    publisherName,
    releaseId,
    root: WINDOWS_UNSIGNED_STAGING_ROOT,
    schemaVersion: WINDOWS_UNSIGNED_STAGING_SCHEMA_VERSION,
    sourceCommit
  }
}

export async function verifyWindowsUnsignedStagingManifest({
  expectedReleaseId,
  expectedPublisherName,
  expectedSourceCommit,
  manifest,
  rootDir
}) {
  assertManifestShape(manifest)

  if (manifest.releaseId !== expectedReleaseId) {
    throw new Error(
      `Unsigned staging release ID mismatch: expected ${expectedReleaseId}, got ${manifest.releaseId}.`
    )
  }
  if (manifest.sourceCommit !== expectedSourceCommit) {
    throw new Error(
      `Unsigned staging source commit mismatch: expected ${expectedSourceCommit}, got ${manifest.sourceCommit}.`
    )
  }
  if (manifest.publisherName !== expectedPublisherName) {
    throw new Error(
      `Unsigned staging publisher mismatch: expected ${expectedPublisherName}, got ${manifest.publisherName}.`
    )
  }

  const actualFiles = await inventoryFiles(rootDir)
  assertRequiredFiles(actualFiles.map((entry) => entry.path))
  await verifyUpdatePublisher(rootDir, expectedPublisherName)

  if (actualFiles.length !== manifest.files.length) {
    throw new Error(
      `Unsigned staging file count mismatch: expected ${manifest.files.length}, got ${actualFiles.length}.`
    )
  }

  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index]
    const actual = actualFiles[index]
    if (
      expected.path !== actual.path ||
      expected.size !== actual.size ||
      expected.sha256 !== actual.sha256
    ) {
      throw new Error(`Unsigned staging file mismatch at ${expected.path}.`)
    }
  }

  return { fileCount: actualFiles.length }
}

async function inventoryFiles(rootDir) {
  const absoluteRoot = resolve(rootDir)
  const rootStats = await lstat(absoluteRoot)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Unsigned staging root must be a real directory.')
  }

  const absoluteFiles = []
  await walk(absoluteRoot, absoluteFiles)

  const paths = absoluteFiles
    .map((absolutePath) =>
      normalizeRelativePath(relative(absoluteRoot, absolutePath).split(sep).join('/'))
    )
    .sort(compareAscii)
  assertUniquePaths(paths)

  const files = []
  for (const path of paths) {
    const absolutePath = resolve(absoluteRoot, ...path.split('/'))
    const stats = await lstat(absolutePath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Unsigned staging entry is not a regular file: ${path}.`)
    }
    files.push({
      path,
      sha256: await sha256File(absolutePath),
      size: stats.size
    })
  }
  return files
}

async function walk(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => compareAscii(left.name, right.name))

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Unsigned staging contains a symbolic link: ${absolutePath}.`)
    }
    if (entry.isDirectory()) {
      await walk(absolutePath, files)
    } else if (entry.isFile()) {
      files.push(absolutePath)
    } else {
      throw new Error(`Unsigned staging contains an unsupported entry: ${absolutePath}.`)
    }
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Unsigned staging manifest must be an object.')
  }
  assertExactKeys(manifest, [
    'files',
    'publisherName',
    'releaseId',
    'root',
    'schemaVersion',
    'sourceCommit'
  ])
  if (manifest.schemaVersion !== WINDOWS_UNSIGNED_STAGING_SCHEMA_VERSION) {
    throw new Error('Unsupported unsigned staging manifest schema.')
  }
  if (manifest.root !== WINDOWS_UNSIGNED_STAGING_ROOT) {
    throw new Error('Unsigned staging manifest root is invalid.')
  }
  assertReleaseId(manifest.releaseId)
  assertSourceCommit(manifest.sourceCommit)
  assertPublisherName(manifest.publisherName)
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Unsigned staging manifest must contain files.')
  }

  const paths = []
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Unsigned staging file entry must be an object.')
    }
    assertExactKeys(entry, ['path', 'sha256', 'size'])
    const path = normalizeRelativePath(entry.path)
    if (path !== entry.path) {
      throw new Error(`Unsigned staging path is not canonical: ${entry.path}.`)
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Unsigned staging SHA-256 is invalid for ${entry.path}.`)
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Unsigned staging size is invalid for ${entry.path}.`)
    }
    paths.push(entry.path)
  }

  assertUniquePaths(paths)
  const sorted = [...paths].sort(compareAscii)
  if (paths.some((path, index) => path !== sorted[index])) {
    throw new Error('Unsigned staging file entries must be sorted by canonical path.')
  }
  assertRequiredFiles(paths)
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error('Unsigned staging paths must be non-empty POSIX relative paths.')
  }
  const path = value
  const segments = path.split('/')
  if (
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe unsigned staging path: ${value}.`)
  }
  return path
}

function assertRequiredFiles(paths) {
  const available = new Set(paths)
  const missing = REQUIRED_FILES.filter((path) => !available.has(path))
  if (missing.length > 0) {
    throw new Error(`Unsigned staging is missing required files: ${missing.join(', ')}.`)
  }
}

function assertUniquePaths(paths) {
  const seen = new Set()
  for (const path of paths) {
    const folded = path.toLowerCase()
    if (seen.has(folded)) {
      throw new Error(`Unsigned staging contains a case-insensitive path collision: ${path}.`)
    }
    seen.add(folded)
  }
}

function assertReleaseId(value) {
  if (!/^\d+\.\d+\.\d+-alpha\.1$/.test(value ?? '')) {
    throw new Error('Unsigned staging release ID is invalid.')
  }
}

function assertSourceCommit(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) {
    throw new Error('Unsigned staging source commit must be a full lowercase SHA-1.')
  }
}

function assertPublisherName(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Unsigned staging publisher name must be a non-empty trimmed string.')
  }
}

async function verifyUpdatePublisher(rootDir, expectedPublisherName) {
  assertPublisherName(expectedPublisherName)
  const updateConfig = parseYaml(
    await readFile(join(resolve(rootDir), 'resources', 'app-update.yml'), 'utf8'),
    { json: false }
  )
  if (!updateConfig || typeof updateConfig !== 'object' || Array.isArray(updateConfig)) {
    throw new Error('Unsigned staging app-update.yml must be an object.')
  }
  if (
    !Array.isArray(updateConfig.publisherName) ||
    updateConfig.publisherName.length !== 1 ||
    updateConfig.publisherName[0] !== expectedPublisherName
  ) {
    throw new Error(
      'Unsigned staging app-update.yml publisherName is not the exact release publisher.'
    )
  }
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value).sort(compareAscii)
  const sortedExpected = [...expected].sort(compareAscii)
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`Unsigned staging object keys are invalid: ${actual.join(', ')}.`)
  }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
