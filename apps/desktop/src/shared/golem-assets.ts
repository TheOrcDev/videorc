// Pure helpers for the Golem's avatar images (plan 164 S-A3, D20). Shared by
// the Electron main process (which does the copy) and unit tests: no fs or
// electron here, just the format sniff, the size cap and the path rules, so
// the boundary is verified in node.

import type { CohostAvatarState, GolemImageImportResult } from './backend'

/** A stored avatar image never exceeds this (plan 164 D20). */
export const GOLEM_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const GOLEM_IMAGE_MAX_PIXELS = 20_000_000
export const GOLEM_IMAGE_EXTENSIONS = ['png', 'webp', 'jpg'] as const
export type GolemImageExtension = (typeof GOLEM_IMAGE_EXTENSIONS)[number]
export const GOLEM_AVATAR_STATES: readonly CohostAvatarState[] = ['idle', 'talk', 'laugh', 'think']
/** The managed protocol host the renderer loads persona images from. */
export const GOLEM_ASSET_HOST = 'golem'

export type { GolemImageImportResult }

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

export function isGolemAvatarState(value: unknown): value is CohostAvatarState {
  return typeof value === 'string' && (GOLEM_AVATAR_STATES as readonly string[]).includes(value)
}

/** A persona id names a folder under the managed root: a plain token only. */
export function isGolemPersonaId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/**
 * The image format from its magic bytes, checked before any decode. PNG and
 * WebP keep alpha; JPEG has none, so it is accepted for `idle` only (D20).
 * The pixel count is read from the header where the format carries it.
 */
export function golemImageFormat(bytes: Uint8Array, state: CohostAvatarState): GolemImageExtension {
  if (bytes.length === 0) throw new Error('Choose an image file.')
  if (bytes.length > GOLEM_IMAGE_MAX_BYTES) {
    throw new Error('Choose an image smaller than 4 MB.')
  }
  const ascii = (start: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(start, start + length))
  if (bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(16) * view.getUint32(20) > GOLEM_IMAGE_MAX_PIXELS) {
      throw new Error('The image exceeds 20 megapixels.')
    }
    return 'png'
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    if (state !== 'idle') {
      throw new Error('A JPEG has no transparency. Use a PNG or WebP with alpha for this state.')
    }
    return 'jpg'
  }
  throw new Error('Choose a PNG, WebP or JPEG image. The file contents must match the format.')
}

/** The relative path a persona stores for a state image. */
export function golemAssetRelativePath(
  personaId: string,
  state: CohostAvatarState,
  extension: GolemImageExtension
): string {
  return `${personaId}/${state}.${extension}`
}

/** The managed URL for a stored relative path, or null when the path is not
 * one `golemAssetRelativePath` produces (never a reach outside the root). */
export function golemAssetUrl(relativePath: string): string | null {
  return parseGolemAssetPath(relativePath)
    ? `videorc-asset://${GOLEM_ASSET_HOST}/${relativePath}`
    : null
}

/** `<personaId>/<state>.<ext>` taken apart, or null for anything else. */
export function parseGolemAssetPath(
  relativePath: string
): { personaId: string; state: CohostAvatarState; extension: GolemImageExtension } | null {
  const match = /^([A-Za-z0-9_-]{1,128})\/(idle|talk|laugh|think)\.(png|webp|jpg)$/.exec(
    relativePath
  )
  if (!match) return null
  return {
    personaId: match[1]!,
    state: match[2] as CohostAvatarState,
    extension: match[3] as GolemImageExtension
  }
}

// --- Golem pet packs (plan 168 S-A2, D3, D4) --------------------------------
// A pack lives at `<golemRoot>/<personaId>/pets/<packId>/` with a uuid id; the
// read-only bundled root (second entry of `VIDEORC_MANAGED_GOLEM_ROOTS`)
// holds `<name>/` folders addressed as `bundled:<name>`. Only the files below
// are ever copied in or read back.

export { GOLEM_PET_FILE_MAX_BYTES, GOLEM_PET_PACK_MAX_BYTES } from './golem-pet'
/** At most this many files are copied for one pack (sources and redos included). */
export const GOLEM_PET_MAX_FILES = 128
/** An import reports at most this many skipped file names. */
export const GOLEM_PET_SKIPPED_FILES_MAX = 50
/** The prefix of a bundled pack id (`bundled:golem`, D3). */
export const GOLEM_BUNDLED_PACK_PREFIX = 'bundled:'

const GOLEM_PACK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const GOLEM_BUNDLED_PACK_NAME = /^[a-z0-9-]{1,40}$/
const GOLEM_PET_FIXED_FILES = new Set([
  'manifest.json',
  'golem.json',
  'build-report.json',
  'provenance.json'
])
const GOLEM_PET_SHEET_FILE = /^[A-Za-z0-9_-]{1,96}\.(webp|png)$/
const GOLEM_PET_SOURCE_FILE = /^sources\/[A-Za-z0-9_-]{1,96}\.png$/

/** A user pack id: a lowercase uuid (D3). */
export function isGolemUserPackId(value: unknown): value is string {
  return typeof value === 'string' && GOLEM_PACK_UUID.test(value)
}

/** The folder name of a bundled pack id, or null when it is not one. */
export function golemBundledPackName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(GOLEM_BUNDLED_PACK_PREFIX)) return null
  const name = value.slice(GOLEM_BUNDLED_PACK_PREFIX.length)
  return GOLEM_BUNDLED_PACK_NAME.test(name) ? name : null
}

/** A pack id the store knows: a uuid or `bundled:<name>`. */
export function isGolemPackId(value: unknown): value is string {
  return isGolemUserPackId(value) || golemBundledPackName(value) !== null
}

/**
 * Whether `file` (relative to the pack folder, `/`-separated) is one a pack
 * may hold: `manifest.json`, `golem.json`, `build-report.json`,
 * `provenance.json`, a `.webp` or `.png` sheet, or a `sources/<name>.png`.
 */
export function isGolemPetFileName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    (GOLEM_PET_FIXED_FILES.has(file) ||
      GOLEM_PET_SHEET_FILE.test(file) ||
      GOLEM_PET_SOURCE_FILE.test(file))
  )
}

/** `<personaId>/pets/<packId>/<file>` for a user pack. */
export function golemPackRelativePath(personaId: string, packId: string, file: string): string {
  return `${personaId}/pets/${packId}/${file}`
}

/**
 * `<personaId>/pets/<packId>/<file>` taken apart, or null for anything else:
 * a plain persona token, a uuid pack id, and an allow-listed file. No `..`,
 * no absolute path, no other folder can pass.
 */
export function parseGolemPackPath(
  relativePath: unknown
): { personaId: string; packId: string; file: string } | null {
  if (typeof relativePath !== 'string') return null
  const match = /^([A-Za-z0-9_-]{1,128})\/pets\/([0-9a-f-]{36})\/(.+)$/.exec(relativePath)
  if (!match) return null
  const [, personaId, packId, file] = match
  if (!isGolemUserPackId(packId) || !isGolemPetFileName(file)) return null
  return { personaId: personaId!, packId: packId!, file: file! }
}
