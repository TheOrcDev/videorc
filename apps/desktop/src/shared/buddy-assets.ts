// Pure helpers for the Buddy's avatar images (plan 164 S-A3, D20; plan 169
// D8). Shared by the Electron main process (which serves the files) and unit
// tests: no fs or electron here, just the size cap and the path rules, so the
// boundary is verified in node.

import type { CohostAvatarState } from './backend'
import { isBuddyOfficialSlug, officialAlivePackVersion } from './buddy-library'

/** A persona image read back as bytes never exceeds this (plan 164 D20). */
export const BUDDY_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const BUDDY_IMAGE_EXTENSIONS = ['png', 'webp', 'jpg'] as const
export type BuddyImageExtension = (typeof BUDDY_IMAGE_EXTENSIONS)[number]
/** The managed protocol host the renderer loads persona images from. */
export const BUDDY_ASSET_HOST = 'buddy'

/** A persona id names a folder under the managed root: a plain token only. */
export function isBuddyPersonaId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** The managed URL for a persona image (`<personaId>/<state>.<ext>`) or a
 * draft picture (`<personaId>/drafts/<requestId>/<state>.png`), or null for
 * anything else (never a reach outside the root). A draft picture may carry
 * `?v=<n>`: a redone pose keeps its path, so the look panel versions the URL
 * (main serves the path and ignores the query). */
export function buddyAssetUrl(relativePath: string): string | null {
  const versioned = /^(.+)\?v=(\d{1,12})$/.exec(relativePath)
  const ok = versioned
    ? parseBuddyDraftPath(versioned[1]) !== null
    : parseBuddyAssetPath(relativePath) !== null || parseBuddyDraftPath(relativePath) !== null
  return ok ? `videorc-asset://${BUDDY_ASSET_HOST}/${relativePath}` : null
}

/**
 * A persona image path taken apart, or null for anything else:
 * `<personaId>/<state>.<ext>` (an upload from before plan 169) or
 * `<personaId>/<state>-<tag>.<ext>` (a kept look, plan 169: the tag is 8 hex
 * digits, so each kept look has its own path and no surface shows a cached
 * picture of the one before). `file` is the name inside the persona folder.
 */
export function parseBuddyAssetPath(relativePath: string): {
  personaId: string
  state: CohostAvatarState
  extension: BuddyImageExtension
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
    extension: match[4] as BuddyImageExtension,
    file: match[2]!
  }
}

/**
 * A draft look's picture (plan 169 D8), `<personaId>/drafts/<requestId>/<state>.png`
 * with a lowercase uuid request id, taken apart; null for anything else. A
 * draft is never a persona image: the persona stores `<personaId>/<state>.<ext>`
 * only, once the draft is kept.
 */
export function parseBuddyDraftPath(
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

// --- Buddy library cache (plan 170 D12) ------------------------------------
// The account library's pictures are cached under the write root as
// `library/<avatarId>/<state>-<tag>.png` (the tag is the 8 hex digits of the
// web URL's `?v=`, so a changed picture gets a new path). Three segments with
// a uuid in the middle: never a persona image, a draft or a pack path.

/** The cache folder under the buddy write root. */
export const BUDDY_LIBRARY_CACHE_DIR = 'library'

/** `library/<avatarId>/<state>-<tag>.png` for a user avatar's cached picture. */
export function buddyLibraryPosePath(
  avatarId: string,
  state: CohostAvatarState,
  tag: string
): string {
  return `${BUDDY_LIBRARY_CACHE_DIR}/${avatarId}/${state}-${tag}.png`
}

/**
 * A cached library picture path taken apart, or null for anything else: a
 * lowercase uuid avatar id, a state and an 8 hex digit tag. `file` is the name
 * inside the avatar's cache folder.
 */
export function parseBuddyLibraryPosePath(
  relativePath: unknown
): { avatarId: string; state: CohostAvatarState; tag: string; file: string } | null {
  if (typeof relativePath !== 'string') return null
  const match =
    /^library\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/((idle|talk|laugh|think)-([0-9a-f]{8})\.png)$/.exec(
      relativePath
    )
  if (!match) return null
  return {
    avatarId: match[1]!,
    state: match[3] as CohostAvatarState,
    tag: match[4]!,
    file: match[2]!
  }
}

/** The managed URL `BuddyLibraryEntry.poses` carries for a cached picture. */
export function buddyLibraryPoseUrl(
  avatarId: string,
  state: CohostAvatarState,
  tag: string
): string {
  return `videorc-asset://${BUDDY_ASSET_HOST}/${buddyLibraryPosePath(avatarId, state, tag)}`
}

/** A `BuddyLibraryEntry.poses` URL taken apart, or null for anything else. */
export function parseBuddyLibraryPoseUrl(
  url: unknown
): ReturnType<typeof parseBuddyLibraryPosePath> {
  const prefix = `videorc-asset://${BUDDY_ASSET_HOST}/`
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null
  return parseBuddyLibraryPosePath(url.slice(prefix.length))
}

// --- Buddy pet packs (plan 168 S-A2, D3, D4) --------------------------------
// A pack lives at `<buddyRoot>/<personaId>/pets/<packId>/` with a uuid id; the
// read-only bundled root (second entry of `VIDEORC_MANAGED_BUDDY_ROOTS`)
// holds `<name>/` folders addressed as `bundled:<name>`. Only the files below
// are ever copied in or read back.

export { BUDDY_PET_FILE_MAX_BYTES, BUDDY_PET_PACK_MAX_BYTES } from './buddy-pet'
/** At most this many files are copied for one pack (sources and redos included). */
export const BUDDY_PET_MAX_FILES = 128
/** An import reports at most this many skipped file names. */
export const BUDDY_PET_SKIPPED_FILES_MAX = 50
/** The prefix of a bundled pack id (`bundled:buddy`, D3). */
export const BUDDY_BUNDLED_PACK_PREFIX = 'bundled:'
/** The prefix of a downloaded official pack id (`official:orc`, plan 172 D4). */
export const BUDDY_OFFICIAL_PACK_PREFIX = 'official:'
/** The folder of downloaded official packs under the write root. */
export const BUDDY_OFFICIAL_PACK_DIR = 'official'

const BUDDY_PACK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BUDDY_BUNDLED_PACK_NAME = /^[a-z0-9-]{1,40}$/
const BUDDY_PET_FIXED_FILES = new Set([
  'manifest.json',
  'buddy.json',
  'build-report.json',
  'provenance.json'
])
const BUDDY_PET_SHEET_FILE = /^[A-Za-z0-9_-]{1,96}\.(webp|png)$/
const BUDDY_PET_SOURCE_FILE = /^sources\/[A-Za-z0-9_-]{1,96}\.png$/

/** A user pack id: a lowercase uuid (D3). */
export function isBuddyUserPackId(value: unknown): value is string {
  return typeof value === 'string' && BUDDY_PACK_UUID.test(value)
}

/** The folder name of a bundled pack id, or null when it is not one. */
export function buddyBundledPackName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(BUDDY_BUNDLED_PACK_PREFIX)) return null
  const name = value.slice(BUDDY_BUNDLED_PACK_PREFIX.length)
  return BUDDY_BUNDLED_PACK_NAME.test(name) ? name : null
}

/**
 * The slug of an official pack id (`official:<slug>`, plan 172 D4), or null.
 * Any `[a-z0-9-]{1,40}` name passes, as for bundled packs: a slug a newer
 * build ships may be saved on the persona; only known slugs resolve.
 */
export function buddyOfficialPackSlug(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(BUDDY_OFFICIAL_PACK_PREFIX)) return null
  const slug = value.slice(BUDDY_OFFICIAL_PACK_PREFIX.length)
  return BUDDY_BUNDLED_PACK_NAME.test(slug) ? slug : null
}

/**
 * Where a downloaded official pack lives under the write root,
 * `official/<slug>/<version>`, for a slug whose catalog row has a pack that
 * downloads; null otherwise (unknown, none, or bundled).
 */
export function buddyOfficialPackFolder(packId: unknown): string | null {
  const slug = buddyOfficialPackSlug(packId)
  if (!slug || !isBuddyOfficialSlug(slug)) return null
  const version = officialAlivePackVersion(slug)
  return version === null ? null : `${BUDDY_OFFICIAL_PACK_DIR}/${slug}/${version}`
}

/** A pack id the store knows: a uuid, `bundled:<name>` or `official:<slug>`. */
export function isBuddyPackId(value: unknown): value is string {
  return (
    isBuddyUserPackId(value) ||
    buddyBundledPackName(value) !== null ||
    buddyOfficialPackSlug(value) !== null
  )
}

/**
 * Whether `file` (relative to the pack folder, `/`-separated) is one a pack
 * may hold: `manifest.json`, `buddy.json`, `build-report.json`,
 * `provenance.json`, a `.webp` or `.png` sheet, or a `sources/<name>.png`.
 */
export function isBuddyPetFileName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    (BUDDY_PET_FIXED_FILES.has(file) ||
      BUDDY_PET_SHEET_FILE.test(file) ||
      BUDDY_PET_SOURCE_FILE.test(file))
  )
}

/** `<personaId>/pets/<packId>/<file>` for a user pack. */
export function buddyPackRelativePath(personaId: string, packId: string, file: string): string {
  return `${personaId}/pets/${packId}/${file}`
}

/**
 * `<personaId>/pets/<packId>/<file>` taken apart, or null for anything else:
 * a plain persona token, a uuid pack id, and an allow-listed file. No `..`,
 * no absolute path, no other folder can pass.
 */
export function parseBuddyPackPath(
  relativePath: unknown
): { personaId: string; packId: string; file: string } | null {
  if (typeof relativePath !== 'string') return null
  const match = /^([A-Za-z0-9_-]{1,128})\/pets\/([0-9a-f-]{36})\/(.+)$/.exec(relativePath)
  if (!match) return null
  const [, personaId, packId, file] = match
  if (!isBuddyUserPackId(packId) || !isBuddyPetFileName(file)) return null
  return { personaId: personaId!, packId: packId!, file: file! }
}
