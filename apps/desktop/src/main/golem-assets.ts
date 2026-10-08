import { mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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
  golemBundledPackName,
  isGolemPetFileName,
  isGolemUserPackId,
  type GolemImageImportResult
} from '../shared/golem-assets'

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

// --- Golem pet packs (plan 168 S-A2) ---------------------------------------

/** The two golem roots: where packs are written, and the read-only bundled
 * root shipped as `golem-assets/bundled` (D3). */
export interface GolemPetRoots {
  write: string
  bundled: string
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
