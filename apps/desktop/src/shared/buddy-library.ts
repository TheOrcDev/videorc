// The Buddy library (plan 170 D1, D10, D12, D13): one account library shared
// by videorc.com and the app, plus Videorc's official avatars. These are the
// desktop RPC shapes (`cohost.library.*`, `crates/videorc-backend/src/cohost_library.rs`)
// and the official catalog, which must equal
// `protocol-fixtures/buddy-official-catalog.json` (a test pins it). Pure: no
// DOM, no fs, no electron. The web's own JSON (`BuddyAvatar` on videorc-web)
// never reaches the renderer; the backend turns it into `BuddyLibraryEntry`.

/** A still pose (the same four states as `CohostAvatarState`). */
export type BuddyPoseState = 'idle' | 'talk' | 'laugh' | 'think'
export const BUDDY_POSE_STATES: readonly BuddyPoseState[] = ['idle', 'talk', 'laugh', 'think']

/** Videorc's official avatars (D10, D11), in catalog order. */
export const BUDDY_OFFICIAL_SLUGS = ['golem', 'orc', 'goblin', 'pirate', 'robot'] as const
export type BuddyOfficialSlug = (typeof BUDDY_OFFICIAL_SLUGS)[number]

export const BUDDY_OFFICIAL_ID_PREFIX = 'official:'
export type BuddyOfficialId = `official:${BuddyOfficialSlug}`
/** The bundled default Buddy as a library id: what an untouched default persona wears. */
export const BUDDY_DEFAULT_OFFICIAL_ID: BuddyOfficialId = 'official:golem'

/** A user avatar's uuid, or `official:<slug>`. */
export type BuddyLibraryId = string

/** At most this many avatars per account (D4, owner-confirmed). */
export const BUDDY_LIBRARY_LIMIT = 30
/** The bounds the web enforces (D1, D5); the renderer and backend use the same. */
export const BUDDY_LIBRARY_NAME_MAX_CHARS = 24
export const BUDDY_LIBRARY_DESCRIPTION_MAX_CHARS = 600
export const BUDDY_LIBRARY_PERSONALITY_MAX_CHARS = 1200
export const BUDDY_LIBRARY_CONTEXT_MAX_CHARS = 4000
/** A persona's `libraryAvatarId` is at most this long (a uuid is 36). */
export const BUDDY_LIBRARY_ID_MAX_CHARS = 64

/** An official avatar as `BuddyLibraryState.official` lists it. Its pictures
 * are bundled with the app, addressed by slug. */
export interface BuddyOfficialEntry {
  id: BuddyOfficialId
  slug: BuddyOfficialSlug
  name: string
  /** "Golem", "Orc", "Goblin", "Pirate", "Robot". */
  kind: string
  tagline: string
  personality: string
}

/** A catalog row: the entry plus what the image model was asked for (null
 * for the Buddy, whose art is the owner's original). */
export interface BuddyOfficialCatalogEntry extends BuddyOfficialEntry {
  description: string | null
}

export const BUDDY_OFFICIAL_CATALOG_VERSION = 1

/** Plan 170 D10, D11: equal to `protocol-fixtures/buddy-official-catalog.json`. */
export const BUDDY_OFFICIAL_CATALOG: readonly BuddyOfficialCatalogEntry[] = [
  {
    slug: 'golem',
    id: 'official:golem',
    name: 'Buddy',
    kind: 'Golem',
    tagline: 'The original. Steady as stone.',
    personality:
      'Calm, warm and a little slow to speak. Greets every follower like an old friend and never rushes anyone.',
    description: null
  },
  {
    slug: 'orc',
    id: 'official:orc',
    name: 'Golmar',
    kind: 'Orc',
    tagline: 'Loud, loyal, all horde.',
    personality:
      'Loud, loyal and proud of the horde. Cheers every follower like a battle won and calls the chat his warband.',
    description:
      'a burly, friendly green orc with small tusks, a braided top-knot, leather shoulder guards and a wide grin'
  },
  {
    slug: 'goblin',
    id: 'official:goblin',
    name: 'Nib',
    kind: 'Goblin',
    tagline: 'Small, sly and in on the joke.',
    personality:
      "Sly, quick and always after a good deal. Loves a joke at the streamer's expense, but never a mean one.",
    description:
      'a small cheeky yellow-green goblin with huge pointed ears, a patched vest and a coin pouch on his belt'
  },
  {
    slug: 'pirate',
    id: 'official:pirate',
    name: 'Captain Barnacle',
    kind: 'Pirate',
    tagline: 'Calls your chat his crew.',
    personality:
      'Booming and theatrical. Calls viewers his crew, new followers new recruits, and every raid a boarding party.',
    description:
      'a jolly round pirate captain with a tricorn hat, an eye patch, a striped shirt and a big bushy beard'
  },
  {
    slug: 'robot',
    id: 'official:robot',
    name: 'Bolt',
    kind: 'Robot',
    tagline: 'Polite, precise, loves a stat.',
    personality:
      'Polite, precise and delighted by every stat. Counts followers out loud and celebrates round numbers.',
    description:
      'a rounded retro robot with a screen for a face showing simple glowing eyes, a short antenna and chunky metal hands'
  }
]

/** One avatar of the account's own library, as the app caches it. */
export interface BuddyLibraryEntry {
  /** The web's uuid. */
  id: string
  /** 1 to 24 characters. */
  name: string
  /** What was asked for (0 to 600; empty when only a picture was given). */
  description: string
  /** 0 to 1200. */
  personality: string
  /** "About you", 0 to 4000; becomes `cohostSettings.notes` when applied. */
  context: string
  /** ISO timestamps from the web. */
  createdAt: string
  updatedAt: string
  /** Local `videorc-asset://buddy/library/<id>/<state>-<tag>.png` URLs of the
   * cached pictures, null until cached (idle on list, the rest on use). */
  poses: Record<BuddyPoseState, string | null>
}

export type BuddyLibraryBusyKind = 'sync' | 'use' | 'delete' | 'update'

/** The library job running now (one at a time). */
export interface BuddyLibraryBusy {
  kind: BuddyLibraryBusyKind
  /** The avatar it acts on; absent for a sync. */
  avatarId?: BuddyLibraryId
}

export interface BuddyLibraryError {
  code: string
  message: string
}

/** `cohost.library.get` and the `cohost.library.changed` event. */
export interface BuddyLibraryState {
  /** The app holds a Videorc session. */
  signedIn: boolean
  /** Always the full catalog; works signed out and offline. */
  official: BuddyOfficialEntry[]
  /** Newest first; null when signed out or never loaded. */
  mine: BuddyLibraryEntry[] | null
  /** What the persona is linked to (`persona.libraryAvatarId`), or
   * `official:golem` for the untouched default; null for a Buddy made only on
   * this computer. */
  activeAvatarId: BuddyLibraryId | null
  /** The account's choice when it differs and sync would not apply it (a
   * local-only Buddy is never overwritten): the UI offers "Use". */
  serverActiveAvatarId: BuddyLibraryId | null
  /** The account's library cap (`BUDDY_LIBRARY_LIMIT` unless the web says otherwise). */
  limit: number
  busy: BuddyLibraryBusy | null
  /** The last sync or action that failed; absent, never null. */
  error?: BuddyLibraryError
}

/** Why a sync runs (D12, D18). */
export const BUDDY_LIBRARY_SYNC_REASONS = ['launch', 'tab', 'focus', 'deep-link', 'manual'] as const
export type BuddyLibrarySyncReason = (typeof BUDDY_LIBRARY_SYNC_REASONS)[number]

/** `cohost.library.sync`. */
export interface CohostLibrarySyncParams {
  reason: BuddyLibrarySyncReason
}

/** `cohost.library.use`: make a library or official avatar the Buddy. */
export interface CohostLibraryUseParams {
  avatarId: BuddyLibraryId
}

/** `cohost.library.update`: one of the account's own avatars (official ones
 * are read-only); at least one field. */
export interface CohostLibraryUpdateParams {
  avatarId: string
  name?: string
  personality?: string
  context?: string
}

/** `cohost.library.delete`: one of the account's own avatars. */
export interface CohostLibraryDeleteParams {
  avatarId: string
}

/** What the library mutations answer at once; the outcome is `cohost.library.changed`. */
export interface CohostLibraryAccepted {
  accepted: true
}

const USER_AVATAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isBuddyOfficialSlug(value: unknown): value is BuddyOfficialSlug {
  return typeof value === 'string' && (BUDDY_OFFICIAL_SLUGS as readonly string[]).includes(value)
}

/** `official:<slug>` for a slug this app knows. */
export function isOfficialBuddyId(value: unknown): value is BuddyOfficialId {
  return officialSlugFromId(value) !== null
}

/** The slug of an official id, or null for anything else (a user avatar, an unknown slug). */
export function officialSlugFromId(value: unknown): BuddyOfficialSlug | null {
  if (typeof value !== 'string' || !value.startsWith(BUDDY_OFFICIAL_ID_PREFIX)) return null
  const slug = value.slice(BUDDY_OFFICIAL_ID_PREFIX.length)
  return isBuddyOfficialSlug(slug) ? slug : null
}

export function officialBuddyId(slug: BuddyOfficialSlug): BuddyOfficialId {
  return `${BUDDY_OFFICIAL_ID_PREFIX}${slug}`
}

/** A user avatar id: the web's lowercase hyphenated uuid. */
export function isBuddyUserAvatarId(value: unknown): value is string {
  return typeof value === 'string' && USER_AVATAR_ID.test(value)
}

/** A library id this app can act on: a user avatar or a known official one. */
export function isBuddyLibraryId(value: unknown): value is BuddyLibraryId {
  return isBuddyUserAvatarId(value) || isOfficialBuddyId(value)
}

/** The catalog row of an official id or slug, or null. */
export function officialBuddy(idOrSlug: unknown): BuddyOfficialCatalogEntry | null {
  const slug = isBuddyOfficialSlug(idOrSlug) ? idOrSlug : officialSlugFromId(idOrSlug)
  return slug ? (BUDDY_OFFICIAL_CATALOG.find((entry) => entry.slug === slug) ?? null) : null
}
