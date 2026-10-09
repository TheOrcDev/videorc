import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import type { CohostAvatarState } from '../shared/backend'
import {
  GOLEM_IMAGE_EXTENSIONS,
  GOLEM_IMAGE_MAX_BYTES,
  GOLEM_IMAGE_MAX_PIXELS,
  golemAssetRelativePath,
  golemAssetUrl,
  golemImageFormat,
  isGolemPersonaId,
  parseGolemAssetPath,
  GOLEM_PET_FILE_MAX_BYTES,
  GOLEM_PET_MAX_FILES,
  GOLEM_PET_PACK_MAX_BYTES,
  GOLEM_PET_SKIPPED_FILES_MAX,
  golemBundledPackName,
  isGolemPetFileName,
  isGolemUserPackId,
  type GolemImageImportResult
} from '../shared/golem-assets'
import type { GolemPetImportResult, GolemPetSummary } from '../shared/golem-pet'
import { isGolemCreationFileName } from '../shared/golem-pet-creator'

/**
 * The Golem's avatar store (plan 164 S-A3): `userData/golem-assets/<personaId>/<state>.<ext>`,
 * the backgrounds pattern. Main copies each upload here after a sniff, serves
 * it through the managed asset protocol, and the persona stores the relative
 * path. The root is handed to the backend as `VIDEORC_MANAGED_GOLEM_ROOTS` so
 * generated images (S-A6) land in the same folder.
 */

async function readImageBytes(sourcePath: string): Promise<Buffer> {
  const file = await open(sourcePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > GOLEM_IMAGE_MAX_BYTES) {
      throw new Error('Choose an image smaller than 4 MB.')
    }
    // One byte past the stat size catches a file that grew after stat.
    const buffer = Buffer.alloc(Math.min(info.size, GOLEM_IMAGE_MAX_BYTES) + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/** A state keeps one file: a new extension replaces the old one's file. */
async function removeOtherExtensions(
  folder: string,
  state: CohostAvatarState,
  keep: string
): Promise<void> {
  await Promise.all(
    GOLEM_IMAGE_EXTENSIONS.map((extension) => extension).map(async (extension) => {
      const name = `${state}.${extension}`
      if (name === keep) return
      await rm(join(folder, name), { force: true })
    })
  )
}

/**
 * Copy one image into the persona's folder as `<state>.<ext>`: sniffed
 * (PNG/WebP, JPEG for idle only), at most 4 MB, and it must decode to a size
 * under 20 megapixels. `decode` is injected (Electron's nativeImage in the
 * app, a fake in tests).
 */
export async function importGolemImage(
  sourcePath: string,
  root: string,
  personaId: string,
  state: CohostAvatarState,
  decode: (bytes: Buffer) => { width: number; height: number }
): Promise<GolemImageImportResult> {
  if (!isGolemPersonaId(personaId)) throw new Error('The persona id is not a plain token.')
  const bytes = await readImageBytes(sourcePath)
  if (bytes.length > GOLEM_IMAGE_MAX_BYTES) throw new Error('Choose an image smaller than 4 MB.')
  const extension = golemImageFormat(bytes, state)
  const { width, height } = decode(bytes)
  if (!width || !height || width * height > GOLEM_IMAGE_MAX_PIXELS) {
    throw new Error('The image is corrupt or exceeds 20 megapixels.')
  }
  const folder = join(root, personaId)
  await mkdir(folder, { recursive: true })
  const fileName = `${state}.${extension}`
  await writeFile(join(folder, fileName), bytes)
  await removeOtherExtensions(folder, state, fileName)
  const path = golemAssetRelativePath(personaId, state, extension)
  const url = golemAssetUrl(path)
  if (!url) throw new Error('The stored image path is not a managed asset path.')
  return { personaId, state, path, url, width, height }
}

/**
 * The bytes of one stored image for the overlay raster (plan 164 S-C2): the
 * path must be one `golemAssetRelativePath` produces, the file must be a
 * regular file inside the root (symlinks resolved) and within the import
 * cap. Null, never a throw, for anything else.
 */
export async function readGolemImage(
  root: string,
  relativePath: unknown
): Promise<Uint8Array | null> {
  if (typeof relativePath !== 'string') return null
  const parsed = parseGolemAssetPath(relativePath)
  if (!parsed) return null
  const filePath = join(root, parsed.personaId, `${parsed.state}.${parsed.extension}`)
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(filePath)])
    if (!resolvedFile.startsWith(resolvedRoot + sep)) return null
    const bytes = await readImageBytes(resolvedFile)
    return bytes.length === 0 || bytes.length > GOLEM_IMAGE_MAX_BYTES ? null : new Uint8Array(bytes)
  } catch {
    return null
  }
}

/** "Start over": the persona's folder and everything in it. App-owned copies,
 * so no Trash step; a folder that is not there is fine. */
export async function removeGolemPersona(root: string, personaId: string): Promise<void> {
  if (!isGolemPersonaId(personaId)) throw new Error('The persona id is not a plain token.')
  await rm(join(root, personaId), { recursive: true, force: true })
}

/** The persona folders present under the root (for diagnostics and tests). */
export async function listGolemPersonas(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && isGolemPersonaId(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

// --- Golem pet packs (plan 168 S-A2, S-A3) -----------------------------------

/** The two golem roots: where packs are written, and the read-only bundled
 * root shipped as `golem-assets/bundled` (D3). */
export interface GolemPetRoots {
  write: string
  bundled: string
}

interface PackSourceFile {
  /** Relative to the pack folder, `/`-separated (`sources/pilot.png`). */
  file: string
  path: string
  size: number
}

/**
 * The files of a picked folder that belong in a pack (the allow-list of
 * `isGolemPetFileName`), sized before anything is read. Links and other
 * entries are skipped and reported. Refuses a folder without
 * `manifest.json`, a file over 32 MB, a pack over 128 MB, or too many files
 * (page-pet's import guards, D4).
 */
export async function collectGolemPetFolder(
  sourceDir: string
): Promise<{ files: PackSourceFile[]; skipped: string[] }> {
  const files: PackSourceFile[] = []
  const skipped: string[] = []
  const visit = async (folder: string, prefix: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${prefix}${entry.name}`
      if (entry.isDirectory() && !prefix && entry.name === 'sources') {
        await visit(join(folder, entry.name), 'sources/')
        continue
      }
      // Dirent reports a link as a link: never followed, never copied.
      if (!entry.isFile() || !isGolemPetFileName(file)) {
        skipped.push(file)
        continue
      }
      const info = await lstat(join(folder, entry.name))
      files.push({ file, path: join(folder, entry.name), size: info.size })
    }
  }
  await visit(sourceDir, '')
  if (!files.some((entry) => entry.file === 'manifest.json')) {
    throw new Error('Choose a page-pet folder: it has no manifest.json.')
  }
  if (files.length > GOLEM_PET_MAX_FILES) {
    throw new Error(`A pack has at most ${GOLEM_PET_MAX_FILES} files.`)
  }
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  if (
    files.some((entry) => entry.size > GOLEM_PET_FILE_MAX_BYTES) ||
    total > GOLEM_PET_PACK_MAX_BYTES
  ) {
    throw new Error('The pack is too large. Keep each file under 32 MB and the pack under 128 MB.')
  }
  return { files, skipped }
}

/** One file's bytes, at most `cap`: a file that grew after it was sized is
 * refused, never truncated. */
async function readCapped(path: string, cap: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > cap) {
      throw new Error(
        'The pack is too large. Keep each file under 32 MB and the pack under 128 MB.'
      )
    }
    const buffer = Buffer.alloc(info.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > info.size) {
      throw new Error('A pack file changed while it was copied. Try again.')
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/**
 * Import a page-pet folder (plan 168 S-A3): copy its pack files to
 * `<root>/<personaId>/pets/<uuid>/`, then hand the folder to the backend
 * (`register`, which runs `cohost.pet.import`) to validate, decode and write
 * the sidecar. On any refusal the copy is removed and the reason rethrown.
 */
export async function importGolemPetFolder(
  sourceDir: string,
  root: string,
  personaId: string,
  register: (folderToken: string) => Promise<GolemPetSummary>,
  newPackId: () => string = randomUUID
): Promise<GolemPetImportResult> {
  if (!isGolemPersonaId(personaId)) throw new Error('The persona id is not a plain token.')
  const { files, skipped } = await collectGolemPetFolder(sourceDir)
  const packId = newPackId()
  if (!isGolemUserPackId(packId)) throw new Error('The pack id is not a uuid.')
  const folder = join(root, personaId, 'pets', packId)
  try {
    await mkdir(join(folder, 'sources'), { recursive: true })
    let copied = 0
    for (const entry of files) {
      const bytes = await readCapped(entry.path, GOLEM_PET_FILE_MAX_BYTES)
      copied += bytes.length
      if (copied > GOLEM_PET_PACK_MAX_BYTES) {
        throw new Error(
          'The pack is too large. Keep each file under 32 MB and the pack under 128 MB.'
        )
      }
      await writeFile(join(folder, ...entry.file.split('/')), bytes)
    }
    if (!files.some((entry) => entry.file.startsWith('sources/'))) {
      await rm(join(folder, 'sources'), { recursive: true, force: true })
    }
    const pack = await register(golemPackFolderToken(personaId, packId))
    return { pack, skippedFiles: skipped.slice(0, GOLEM_PET_SKIPPED_FILES_MAX) }
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
}

/** The token `cohost.pet.import` takes: the pack folder relative to the
 * write root, `<personaId>/pets/<packId>`. */
export function golemPackFolderToken(personaId: string, packId: string): string {
  return `${personaId}/pets/${packId}`
}

/**
 * The bytes of one pack file for the renderer preview (plan 168 Phase D):
 * a user pack under the write root or a bundled pack under the bundled root,
 * an allow-listed file name, a regular file inside that root (symlinks
 * resolved), at most 32 MB. Null, never a throw, for anything else.
 */
export async function readGolemPetFile(
  roots: GolemPetRoots,
  personaId: unknown,
  packId: unknown,
  file: unknown
): Promise<Uint8Array | null> {
  if (!isGolemPersonaId(personaId) || !isGolemPetFileName(file)) return null
  const bundled = golemBundledPackName(packId)
  let root: string
  let folder: string
  if (bundled) {
    root = roots.bundled
    folder = join(root, bundled)
  } else if (isGolemUserPackId(packId)) {
    root = roots.write
    folder = join(root, personaId, 'pets', packId)
  } else {
    return null
  }
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(root),
      realpath(join(folder, ...file.split('/')))
    ])
    if (!resolvedFile.startsWith(resolvedRoot + sep)) return null
    const bytes = await readCapped(resolvedFile, GOLEM_PET_FILE_MAX_BYTES)
    return bytes.length === 0 ? null : new Uint8Array(bytes)
  } catch {
    return null
  }
}

/**
 * The bytes of one file of a pet creation (plan 168 S-F5) for the creator
 * wizard: `<root>/<personaId>/creations/<buildId>/<file>` under the write
 * root, where `file` is a stored source (`sources/<sheet>-v<n>.png`) or the
 * build's `pack/mascot.webp` and `pack/manifest.json`. A regular file inside
 * the root (symlinks resolved), at most 32 MB. Null, never a throw, for
 * anything else.
 */
export async function readGolemCreationFile(
  root: string,
  personaId: unknown,
  buildId: unknown,
  file: unknown
): Promise<Uint8Array | null> {
  if (
    !isGolemPersonaId(personaId) ||
    !isGolemUserPackId(buildId) ||
    !isGolemCreationFileName(file)
  ) {
    return null
  }
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(root),
      realpath(join(root, personaId, 'creations', buildId, ...file.split('/')))
    ])
    if (!resolvedFile.startsWith(resolvedRoot + sep)) return null
    const bytes = await readCapped(resolvedFile, GOLEM_PET_FILE_MAX_BYTES)
    return bytes.length === 0 ? null : new Uint8Array(bytes)
  } catch {
    return null
  }
}
