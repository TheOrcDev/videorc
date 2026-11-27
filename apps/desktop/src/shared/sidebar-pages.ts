// The sidebar's pages, their order and their keys, in one place (owner,
// 2026-11-20). The renderer's sidebar, ⌘K, Settings → Shortcuts and the
// shell's key map, main's before-input-event and the macOS View menu all read
// this module, so the order and the key map cannot drift between them.
//
// The keys follow one rule: the digits ⌘1–⌘9, then ⌘0, run down the rows in
// visible order (Q187), skipping hidden Guests and a row that has a fixed key in PAGE_FIXED_KEYS and any digit
// a fixed key already takes, until the digits run out. Swapping the layout is
// a change to SIDEBAR_LAYOUT and PAGE_FIXED_KEYS only. For example, the Assets
// group right after Setup, with ⌘1–⌘9 and ⌘0 over the first ten rows and
// Library on a letter, is: move the `assets` zone up, and make the fixed keys
// `{ library: 'L', settings: ',' }`.

export type SidebarPageId =
  | 'studio'
  | 'sources'
  | 'layouts'
  | 'captions'
  | 'recording'
  | 'live'
  | 'guests'
  | 'avatar'
  | 'ai'
  | 'assets'
  | 'sounds'
  | 'library'
  | 'settings'

export type SidebarZoneId = 'stage' | 'setup' | 'livestream' | 'assets' | 'system'

export interface SidebarZoneLayout {
  id: SidebarZoneId
  /** A labelled group's `SectionLabel`; a zone of one row carries none. */
  label?: string
  pages: readonly SidebarPageId[]
}

/**
 * The sidebar, top to bottom: Studio alone as the chrome slab, the Setup,
 * Livestream and Assets groups, then the `system` block (Library and Settings)
 * at the foot above the account row. Owner 2026-11-20: Assets is its own group
 * (Images, the old Assets page, and Sounds) below Livestream, so the nine rows
 * above it take ⌘1–⌘9; Library moved down beside Settings.
 */
export const SIDEBAR_LAYOUT: readonly SidebarZoneLayout[] = [
  { id: 'stage', pages: ['studio'] },
  { id: 'setup', label: 'Setup', pages: ['sources', 'layouts', 'captions', 'recording'] },
  { id: 'livestream', label: 'Livestream', pages: ['live', 'guests', 'avatar', 'ai'] },
  { id: 'assets', label: 'Assets', pages: ['assets', 'sounds'] },
  { id: 'system', pages: ['library', 'settings'] }
]

/** Each page's name, as the sidebar, ⌘K, the window title and the menu say it. */
export const SIDEBAR_PAGE_LABELS: Readonly<Record<SidebarPageId, string>> = {
  studio: 'Studio',
  sources: 'Sources',
  layouts: 'Scene',
  captions: 'Captions',
  recording: 'Output',
  live: 'Destinations',
  guests: 'Guests',
  avatar: 'Avatar',
  ai: 'Sidekick',
  assets: 'Images',
  sounds: 'Sounds',
  library: 'Library',
  settings: 'Settings'
}

type PageDigit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '0'
// A letter is ⇧⌘ and the letter (Ctrl+Shift elsewhere): plain ⌘-letters
// belong to the windows' own chords (⌘K, ⌘P, ⌘J, ⌘L, ⌘F…).
type PageLetter =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'

/** A page key as main forwards it on `shortcut:navigate`: a digit, `,`, or a ⇧⌘ letter. */
export type PageKey = PageDigit | ',' | PageLetter

/**
 * The keys that are not handed out by the digit run. ⇧⌘G (G for graphics) and
 * ⇧⌘S were free in every window, menu and text field when they were chosen
 * (⇧⌘I is the developer tools in a Windows or Linux dev build; ⇧⌘L is a
 * macOS service), and the shortcut recorder refuses them as global keys.
 */
export const PAGE_FIXED_KEYS: Readonly<Partial<Record<SidebarPageId, PageKey>>> = {
  assets: 'G',
  sounds: 'S',
  library: '0',
  settings: ','
}

const DIGIT_RUN: readonly PageDigit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

export interface PageKeyEntry {
  key: PageKey
  page: SidebarPageId
}

/**
 * The rule behind PAGE_KEYS: fixed keys first, then ⌘1–⌘9 and ⌘0 down the
 * remaining rows in order, minus any digit a fixed key takes. Exported so the
 * other layout the owner weighed stays one small, tested change.
 */
export function assignPageKeys(
  layout: readonly SidebarZoneLayout[],
  fixedKeys: Readonly<Partial<Record<SidebarPageId, PageKey>>>
): PageKeyEntry[] {
  return pageKeys(true, layout, fixedKeys)
}

/** Assign digits only after filtering the visible rows. Fixed keys never move. */
export function pageKeys(
  guestsShown: boolean,
  layout: readonly SidebarZoneLayout[] = SIDEBAR_LAYOUT,
  fixedKeys: Readonly<Partial<Record<SidebarPageId, PageKey>>> = PAGE_FIXED_KEYS
): PageKeyEntry[] {
  const fixed = Object.values(fixedKeys)
  const digits = DIGIT_RUN.filter((digit) => !fixed.includes(digit))
  const entries: PageKeyEntry[] = []
  for (const { pages } of layout) {
    for (const page of pages) {
      if (!guestsShown && page === 'guests') continue
      const key = fixedKeys[page] ?? digits.shift()
      if (key) entries.push({ key, page })
    }
  }
  return entries
}

interface SidebarCloudStatus {
  allowance?: { enabled?: boolean; talkShows?: boolean } | null
  room?: { phase: string } | null
}

/** Talk-show availability, shared by main and renderer. An open room stays controllable. */
export function guestsVisible(status: SidebarCloudStatus | null | undefined): boolean {
  return Boolean(
    (status?.allowance?.enabled && status.allowance.talkShows) ||
    (status?.room && status.room.phase !== 'closed')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Main receives raw backend payloads; renderer CloudStatus is already validated. */
export function guestsVisibleFromPayload(status: unknown): boolean {
  if (!isRecord(status)) return false
  const { allowance, room } = status
  return guestsVisible({
    allowance: isRecord(allowance)
      ? { enabled: allowance.enabled === true, talkShows: allowance.talkShows === true }
      : null,
    room: isRecord(room) && typeof room.phase === 'string' ? { phase: room.phase } : null
  })
}

/** All possible page keys, for the IPC schema; runtime consumers use pageKeys. */
export const PAGE_KEYS: readonly PageKeyEntry[] = /* @__PURE__ */ pageKeys(true)

/** The key of a page, if it has one. */
export function pageKeyFor(page: string, guestsShown = true): PageKey | undefined {
  return pageKeys(guestsShown).find((entry) => entry.page === page)?.key
}

/** A page key as an Electron accelerator: ⌘ and the key, ⇧⌘ and a letter. */
export function pageKeyAccelerator(key: PageKey): string {
  return /^[A-Z]$/.test(key) ? `CmdOrCtrl+Shift+${key}` : `CmdOrCtrl+${key}`
}

/**
 * The page key a key press carries, or null. Main's before-input-event asks
 * this in every window once it knows the command modifier is down, so the
 * main window and the aux windows answer the same chords. ⇧ belongs to the
 * letters alone: ⇧⌘1 or ⇧⌘, open nothing, and neither does a plain ⌘-letter.
 */
export function pageKeyForInput(
  input: {
    key: string
    shift: boolean
    alt: boolean
  },
  guestsShown = true
): PageKey | null {
  if (input.alt) return null
  const key = input.shift
    ? /^[a-z]$/i.test(input.key)
      ? input.key.toUpperCase()
      : null
    : /^[0-9,]$/.test(input.key)
      ? input.key
      : null
  return pageKeys(guestsShown).find((entry) => entry.key === key)?.key ?? null
}
