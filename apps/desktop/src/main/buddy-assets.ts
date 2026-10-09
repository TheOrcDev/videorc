import { randomUUID } from 'node:crypto'
import { lstatSync, renameSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import {
  BUDDY_IMAGE_MAX_BYTES,
  isBuddyPersonaId,
  parseBuddyAssetPath,
  BUDDY_PET_FILE_MAX_BYTES,
  BUDDY_PET_MAX_FILES,
  BUDDY_PET_PACK_MAX_BYTES,
  BUDDY_PET_SKIPPED_FILES_MAX,
  buddyBundledPackName,
  isBuddyPetFileName,
  isBuddyUserPackId
} from '../shared/buddy-assets'
import type { BuddyPetImportResult, BuddyPetSummary } from '../shared/buddy-pet'
import { isBuddyCreationFileName } from '../shared/buddy-pet-creator'

/**
 * The Buddy's avatar store (plan 164 S-A3, plan 169 D8):
 * `userData/buddy-assets/<personaId>/<state>.<ext>`, the backgrounds pattern.
 * The backend writes the generated look there (a draft first, under
 * `<personaId>/drafts/<requestId>/`); main serves the files through the
 * managed asset protocol, and the persona stores the relative path. The root
 * is handed to the backend as `VIDEORC_MANAGED_BUDDY_ROOTS`. There are no
 * per-state uploads since plan 169 (D10); pictures from before stay.
 */

async function readImageBytes(sourcePath: string): Promise<Buffer> {
  const file = await open(sourcePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > BUDDY_IMAGE_MAX_BYTES) {
      throw new Error('Choose an image smaller than 4 MB.')
    }
    // One byte past the stat size catches a file that grew after stat.
    const buffer = Buffer.alloc(Math.min(info.size, BUDDY_IMAGE_MAX_BYTES) + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/**
 * The bytes of one stored image for the overlay raster (plan 164 S-C2): the
 * path must be a persona image path (`parseBuddyAssetPath`), the file must be a
 * regular file inside the root (symlinks resolved) and within the import
 * cap. Null, never a throw, for anything else.
 */
export async function readBuddyImage(
  root: string,
  relativePath: unknown
): Promise<Uint8Array | null> {
  if (typeof relativePath !== 'string') return null
  const parsed = parseBuddyAssetPath(relativePath)
  if (!parsed) return null
  const filePath = join(root, parsed.personaId, parsed.file)
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(filePath)])
    if (!resolvedFile.startsWith(resolvedRoot + sep)) return null
    const bytes = await readImageBytes(resolvedFile)
    return bytes.length === 0 || bytes.length > BUDDY_IMAGE_MAX_BYTES ? null : new Uint8Array(bytes)
  } catch {
    return null
  }
}

/** "Start over": the persona's folder and everything in it. App-owned copies,
 * so no Trash step; a folder that is not there is fine. */
export async function removeBuddyPersona(root: string, personaId: string): Promise<void> {
  if (!isBuddyPersonaId(personaId)) throw new Error('The persona id is not a plain token.')
  await rm(join(root, personaId), { recursive: true, force: true })
}

/** The persona folders present under the root (for diagnostics and tests). */
export async function listBuddyPersonas(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && isBuddyPersonaId(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

// --- The folder's name before plan 171 ------------------------------------------

/** The userData folder that holds the Buddy's pictures and pet packs. */
export const BUDDY_ASSETS_FOLDER = 'buddy-assets'
/** Its name in the dev builds of plans 164 to 170 (never shipped). */
export const LEGACY_BUDDY_ASSETS_FOLDER = 'golem-assets'

export type LegacyBuddyAssetsMove =
  | { kind: 'nothing' }
  | { kind: 'moved' }
  | { kind: 'both-exist' }
  | { kind: 'failed'; message: string }

/**
 * Plan 171 D3: dev builds from before the Buddy rename kept the pictures and
 * pet packs in `userData/golem-assets/`. Main moves that folder to
 * `buddy-assets/` once, at start, before the asset protocol or the backend
 * reads either, and only when `buddy-assets/` does not exist yet: it never
 * merges or overwrites. A symlink is not followed. A folder that cannot be
 * moved stays where it is, and the caller logs why.
 */
export function moveLegacyBuddyAssets(userData: string): LegacyBuddyAssetsMove {
  const legacy = join(userData, LEGACY_BUDDY_ASSETS_FOLDER)
  const current = join(userData, BUDDY_ASSETS_FOLDER)
  if (!isRealDirectory(legacy)) return { kind: 'nothing' }
  if (pathExists(current)) return { kind: 'both-exist' }
  try {
    renameSync(legacy, current)
    return { kind: 'moved' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// --- Buddy pet packs (plan 168 S-A2, S-A3) -----------------------------------

/** The two buddy roots: where packs are written, and the read-only bundled
 * root shipped as `buddy-assets/bundled` (D3). */
export interface BuddyPetRoots {
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
 * `isBuddyPetFileName`), sized before anything is read. Links and other
 * entries are skipped and reported. Refuses a folder without
 * `manifest.json`, a file over 32 MB, a pack over 128 MB, or too many files
 * (page-pet's import guards, D4).
 */
export async function collectBuddyPetFolder(
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
      if (!entry.isFile() || !isBuddyPetFileName(file)) {
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
  if (files.length > BUDDY_PET_MAX_FILES) {
    throw new Error(`A pack has at most ${BUDDY_PET_MAX_FILES} files.`)
  }
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  if (
    files.some((entry) => entry.size > BUDDY_PET_FILE_MAX_BYTES) ||
    total > BUDDY_PET_PACK_MAX_BYTES
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
export async function importBuddyPetFolder(
  sourceDir: string,
  root: string,
  personaId: string,
  register: (folderToken: string) => Promise<BuddyPetSummary>,
  newPackId: () => string = randomUUID
): Promise<BuddyPetImportResult> {
  if (!isBuddyPersonaId(personaId)) throw new Error('The persona id is not a plain token.')
  const { files, skipped } = await collectBuddyPetFolder(sourceDir)
  const packId = newPackId()
  if (!isBuddyUserPackId(packId)) throw new Error('The pack id is not a uuid.')
  const folder = join(root, personaId, 'pets', packId)
  try {
    await mkdir(join(folder, 'sources'), { recursive: true })
    let copied = 0
    for (const entry of files) {
      const bytes = await readCapped(entry.path, BUDDY_PET_FILE_MAX_BYTES)
      copied += bytes.length
      if (copied > BUDDY_PET_PACK_MAX_BYTES) {
        throw new Error(
          'The pack is too large. Keep each file under 32 MB and the pack under 128 MB.'
        )
      }
      await writeFile(join(folder, ...entry.file.split('/')), bytes)
    }
    if (!files.some((entry) => entry.file.startsWith('sources/'))) {
      await rm(join(folder, 'sources'), { recursive: true, force: true })
    }
    const pack = await register(buddyPackFolderToken(personaId, packId))
    return { pack, skippedFiles: skipped.slice(0, BUDDY_PET_SKIPPED_FILES_MAX) }
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
}

/** The token `cohost.pet.import` takes: the pack folder relative to the
 * write root, `<personaId>/pets/<packId>`. */
export function buddyPackFolderToken(personaId: string, packId: string): string {
  return `${personaId}/pets/${packId}`
}

/**
 * The bytes of one pack file for the renderer preview (plan 168 Phase D):
 * a user pack under the write root or a bundled pack under the bundled root,
 * an allow-listed file name, a regular file inside that root (symlinks
 * resolved), at most 32 MB. Null, never a throw, for anything else.
 */
export async function readBuddyPetFile(
  roots: BuddyPetRoots,
  personaId: unknown,
  packId: unknown,
  file: unknown
): Promise<Uint8Array | null> {
  if (!isBuddyPersonaId(personaId) || !isBuddyPetFileName(file)) return null
  const bundled = buddyBundledPackName(packId)
  let root: string
  let folder: string
  if (bundled) {
    root = roots.bundled
    folder = join(root, bundled)
  } else if (isBuddyUserPackId(packId)) {
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
    const bytes = await readCapped(resolvedFile, BUDDY_PET_FILE_MAX_BYTES)
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
export async function readBuddyCreationFile(
  root: string,
  personaId: unknown,
  buildId: unknown,
  file: unknown
): Promise<Uint8Array | null> {
  if (
    !isBuddyPersonaId(personaId) ||
    !isBuddyUserPackId(buildId) ||
    !isBuddyCreationFileName(file)
  ) {
    return null
  }
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(root),
      realpath(join(root, personaId, 'creations', buildId, ...file.split('/')))
    ])
    if (!resolvedFile.startsWith(resolvedRoot + sep)) return null
    const bytes = await readCapped(resolvedFile, BUDDY_PET_FILE_MAX_BYTES)
    return bytes.length === 0 ? null : new Uint8Array(bytes)
  } catch {
    return null
  }
}
