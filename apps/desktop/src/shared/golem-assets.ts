// Pure helpers for the Golem's avatar images (plan 164 S-A3, D20; plan 169
// D8). Shared by the Electron main process (which serves the files) and unit
// tests: no fs or electron here, just the size cap and the path rules, so the
// boundary is verified in node.

import type { CohostAvatarState } from './backend'

/** A persona image read back as bytes never exceeds this (plan 164 D20). */
export const GOLEM_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const GOLEM_IMAGE_EXTENSIONS = ['png', 'webp', 'jpg'] as const
export type GolemImageExtension = (typeof GOLEM_IMAGE_EXTENSIONS)[number]
/** The managed protocol host the renderer loads persona images from. */
export const GOLEM_ASSET_HOST = 'golem'

/** A persona id names a folder under the managed root: a plain token only. */
export function isGolemPersonaId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** The managed URL for a persona image (`<personaId>/<state>.<ext>`) or a
 * draft picture (`<personaId>/drafts/<requestId>/<state>.png`), or null for
 * anything else (never a reach outside the root). A draft picture may carry
 * `?v=<n>`: a redone pose keeps its path, so the look panel versions the URL
 * (main serves the path and ignores the query). */
export function golemAssetUrl(relativePath: string): string | null {
  const versioned = /^(.+)\?v=(\d{1,12})$/.exec(relativePath)
  const ok = versioned
    ? parseGolemDraftPath(versioned[1]) !== null
    : parseGolemAssetPath(relativePath) !== null || parseGolemDraftPath(relativePath) !== null
  return ok ? `videorc-asset://${GOLEM_ASSET_HOST}/${relativePath}` : null
}

/**
 * A persona image path taken apart, or null for anything else:
 * `<personaId>/<state>.<ext>` (an upload from before plan 169) or
 * `<personaId>/<state>-<tag>.<ext>` (a kept look, plan 169: the tag is 8 hex
 * digits, so each kept look has its own path and no surface shows a cached
 * picture of the one before). `file` is the name inside the persona folder.
 */
export function parseGolemAssetPath(relativePath: string): {
  personaId: string
  state: CohostAvatarState
  extension: GolemImageExtension
  file: string
} | null {
  const match =
    /^([A-Za-z0-9_-]{1,128})\/((idle|talk|laugh|think)(?:-[0-9a-f]{8})?\.(png|webp|jpg))$/.exec(
      relativePath
    )
  if (!match) return null
  return {
    personaId: match[1]!,
    state: match[3] as CohostAvatarState,
    extension: match[4] as GolemImageExtension,
    file: match[2]!
  }
}

/**
 * A draft look's picture (plan 169 D8), `<personaId>/drafts/<requestId>/<state>.png`
 * with a lowercase uuid request id, taken apart; null for anything else. A
 * draft is never a persona image: the persona stores `<personaId>/<state>.<ext>`
 * only, once the draft is kept.
 */
export function parseGolemDraftPath(
  relativePath: unknown
): { personaId: string; requestId: string; state: CohostAvatarState } | null {
  if (typeof relativePath !== 'string') return null
  const match =
    /^([A-Za-z0-9_-]{1,128})\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(idle|talk|laugh|think)\.png$/.exec(
      relativePath
    )
  if (!match) return null
  return {
    personaId: match[1]!,
    requestId: match[2]!,
    state: match[3] as CohostAvatarState
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
