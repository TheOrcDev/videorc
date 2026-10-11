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

/** What every official avatar has, in the catalog and in the library state. */
export interface BuddyOfficialInfo {
  id: BuddyOfficialId
  slug: BuddyOfficialSlug
  name: string
  /** "Golem", "Orc", "Goblin", "Pirate", "Robot". */
  kind: string
  tagline: string
  personality: string
}

/**
 * Where an official character's alive pack is on this computer (plan 172
 * D4, D12): it ships inside the app, it was downloaded and verified, it
 * downloads the first time the Buddy is used, or it has none.
 */
export const BUDDY_OFFICIAL_ALIVE_STATES = ['bundled', 'downloaded', 'available', 'none'] as const
export type BuddyOfficialAliveState = (typeof BUDDY_OFFICIAL_ALIVE_STATES)[number]

/** An official avatar as `BuddyLibraryState.official` lists it. Its pictures
 * are bundled with the app, addressed by slug. */
export interface BuddyOfficialEntry extends BuddyOfficialInfo {
  alive: BuddyOfficialAliveState
}

/** One file of an official pack, as the catalog pins it. */
export interface BuddyOfficialAliveFile {
  name: string
  bytes: number
  /** 64 lowercase hex digits. */
  sha256: string
}

/**
 * An official character's alive pack (plan 172 D4): `bundled:buddy` ships
 * inside the app; the others (`official:<slug>`) download from
 * `/buddy/official/<slug>/alive/<version>/<name>` on videorc.com the first
 * time they are used and live at `<root>/official/<slug>/<version>/`.
 */
export interface BuddyOfficialAlive {
  version: number
  packId: string
  /** True only for the pack that ships inside the app. */
  bundled: boolean
  cellSize: number
  frames: number
  files: BuddyOfficialAliveFile[]
}

/** A catalog row: the entry plus what the image model was asked for (null
 * for Buddy the Golem, whose art is the owner's original) and its alive
 * pack (null until it ships). */
export interface BuddyOfficialCatalogEntry extends BuddyOfficialInfo {
  description: string | null
  alive: BuddyOfficialAlive | null
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
    description: null,
    alive: {
      version: 1,
      packId: 'bundled:buddy',
      bundled: true,
      cellSize: 640,
      frames: 40,
      files: [
        {
          name: 'manifest.json',
          bytes: 8000,
          sha256: 'fd1e4cb03d537136b792586747a565b44a249e2284bb35cd715ac7da1db8fce4'
        },
        {
          name: 'mascot.webp',
          bytes: 1618096,
          sha256: 'a3d5f512ae23381ae2295da817d2e3118145b1986ea906a8fad59647a0eef71c'
        },
        {
          name: 'buddy.json',
          bytes: 241,
          sha256: 'a832d39fe8b9ad29ed0c575d242664619e3716f70da98b710c83d3edfad8201f'
        }
      ]
    }
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
      'a burly, friendly green orc with small tusks, a braided top-knot, leather shoulder guards and a wide grin',
    alive: {
      version: 1,
      packId: 'official:orc',
      bundled: false,
      cellSize: 640,
      frames: 40,
      files: [
        {
          name: 'manifest.json',
          bytes: 8001,
          sha256: '72f0cdb6908516fb09d1b10b9f416e8d59a2b8b2530f4288361edfdc5fc65693'
        },
        {
          name: 'mascot.webp',
          bytes: 1400912,
          sha256: '71966f94042b2f69b4618a9384dd8e1ffa75302f672ab9a4da202e703ed97410'
        },
        {
          name: 'buddy.json',
          bytes: 241,
          sha256: 'ddc2fbf5748bce6165b666c6bbc6086cfbf94bc06352a97f8ebeaa634f58f62e'
        }
      ]
    }
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
      'a small cheeky yellow-green goblin with huge pointed ears, a patched vest and a coin pouch on his belt',
    alive: {
      version: 1,
      packId: 'official:goblin',
      bundled: false,
      cellSize: 640,
      frames: 40,
      files: [
        {
          name: 'manifest.json',
          bytes: 7998,
          sha256: '9c80f9dfc715322763816a0d60539afc4347905de3a5b36663339ab3df926c83'
        },
        {
          name: 'mascot.webp',
          bytes: 1494608,
          sha256: 'ab30105f92c04ead861a23cab9c88a8c068ea3a1bb2fee24fc67c301c3f051e1'
        },
        {
          name: 'buddy.json',
          bytes: 241,
          sha256: 'a79619ed5e0ba539b1988626450e1b7f8fd2d6c3709c09a1aa189c03dfb40c8f'
        }
      ]
    }
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
      'a jolly round pirate captain with a tricorn hat, an eye patch, a striped shirt and a big bushy beard',
    alive: {
      version: 1,
      packId: 'official:pirate',
      bundled: false,
      cellSize: 640,
      frames: 40,
      files: [
        {
          name: 'manifest.json',
          bytes: 8011,
          sha256: '661e205bb7ecb6f378c547c4337418630eb47fd6829540f212e5f70dcbc3eff4'
        },
        {
          name: 'mascot.webp',
          bytes: 1357372,
          sha256: 'da53d27ad21ac6e293bef9ef6ff0145a257840fa09dd270dd56e55e4d8618fa7'
        },
        {
          name: 'buddy.json',
          bytes: 241,
          sha256: '116e539792c321a67f582d6625d77a1645075c5d5668c104c64f2a8009c6ba71'
        }
      ]
    }
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
      'a rounded retro robot with a screen for a face showing simple glowing eyes, a short antenna and chunky metal hands',
    alive: {
      version: 1,
      packId: 'official:robot',
      bundled: false,
      cellSize: 640,
      frames: 40,
      files: [
        {
          name: 'manifest.json',
          bytes: 7999,
          sha256: 'f89efc2c8b1a546b25381a53280dab08ee6b7c5d03205ea956709ddbefba7433'
        },
        {
          name: 'mascot.webp',
          bytes: 1300458,
          sha256: '7ecff00c66964cc7811764b00cb1652dbc2687dd2857068b414a88e56b3dfdd8'
        },
        {
          name: 'buddy.json',
          bytes: 241,
          sha256: '11359b1294c35134f3e1dde5d13e98c5d76df032205b7b15f59e97fdeb044e61'
        }
      ]
    }
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
  /** The Buddy's alive pack (plan 172 D9): the pack it wears once used here,
   * or null when it has none (Make it Alive). */
  alive: BuddyLibraryEntryAlive | null
}

/** An account Buddy's alive pack as the app shows it. */
export interface BuddyLibraryEntryAlive {
  /** The pack's uuid. */
  packId: string
  cellSize: number
}

/**
 * The library job running now: `alive-upload` sends a Buddy's pack to the
 * account, `alive-download` brings an official or account pack here, and
 * `import` saves a Buddy made on this computer to the library (plan 172).
 */
export const BUDDY_LIBRARY_BUSY_KINDS = [
  'sync',
  'use',
  'delete',
  'update',
  'alive-upload',
  'alive-download',
  'import'
] as const
export type BuddyLibraryBusyKind = (typeof BUDDY_LIBRARY_BUSY_KINDS)[number]

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

// `cohost.library.saveToLibrary` takes no params (plan 172 D10): it imports
// the Buddy made only on this computer, links it, then sends its own pack.

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

/**
 * The version of a downloadable official pack (`official:<slug>`, plan 172
 * D4), or null for an unknown slug, a character without a pack, or the one
 * that ships inside the app. Main resolves the pack's folder with it.
 */
export function officialAlivePackVersion(slug: unknown): number | null {
  const alive = isBuddyOfficialSlug(slug) ? officialBuddy(slug)?.alive : null
  return alive && !alive.bundled ? alive.version : null
}

/**
 * The pack state the catalog alone implies, before the backend says where
 * the pack is: a bundled pack is `bundled`, a downloadable one `available`,
 * none `none`.
 */
export function officialAliveFallback(
  entry: Pick<BuddyOfficialCatalogEntry, 'alive'>
): BuddyOfficialAliveState {
  if (!entry.alive) return 'none'
  return entry.alive.bundled ? 'bundled' : 'available'
}
