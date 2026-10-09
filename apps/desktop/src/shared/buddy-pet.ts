// Buddy pet packs (plan 168 Phase A, D1 to D4): the page-pet manifest v1
// contract as the renderer preview and main see it. The backend's
// `buddy_pet.rs` runs the same rules; `protocol-fixtures/buddy-pet-manifests.json`
// is run by both, and every failing case names its rule.
//
// Ported from page-pet (`gvastethecreator/page-pet-skill` `0b6a0ef`, MIT,
// copyright 2026 Cristian): `runtime/manifest.js` (`validateManifest`,
// `validateSprite`, `validateImages`, `sheetNames`) and the import guards of
// `playground/app.js`. Pure: no DOM, no fs, no electron.

/** page-pet's import guard, per file (D4). */
export const BUDDY_PET_FILE_MAX_BYTES = 32 * 1024 * 1024
/** page-pet's import guard, for the whole pack (D4). */
export const BUDDY_PET_PACK_MAX_BYTES = 128 * 1024 * 1024
/** A sheet is at most 8192 px on each side (D4). */
export const BUDDY_PET_SHEET_MAX_SIDE = 8192
/** Cells are square, 128 to 1024 px (D4). */
export const BUDDY_PET_CELL_MIN = 128
export const BUDDY_PET_CELL_MAX = 1024
/** At most 64 frames per pack (D4). */
export const BUDDY_PET_FRAMES_MAX = 64
/** Decoded sheets together stay under the compositor decode budget (D4). */
export const BUDDY_PET_DECODED_MAX_BYTES = 128 * 1024 * 1024
/** The alpha a pixel needs to count as the character (page-pet's builder). */
export const BUDDY_PET_ALPHA_SOLID = 16
/** Frame ids and the listed pack name are at most 64 UTF-16 units (Videorc). */
export const BUDDY_PET_TEXT_MAX = 64

/** The rules the shared fixture covers, in the order they are checked. */
export const BUDDY_PET_MANIFEST_RULES = [
  'manifest-v1',
  'frame-count',
  'puppet-retired',
  'legacy-layers',
  'pivot-range',
  'frame-id',
  'frame-expression',
  'sheet-name',
  'sheet-avif',
  'rect-square',
  'frame-kind',
  'gaze-range',
  'gaze-unique',
  'neutral-missing',
  'cell-size',
  'rect-limit',
  'frame-outside-sheet',
  'sheet-size',
  'decoded-budget'
] as const

/** Every reason a pack is refused; kebab-case names shared with Rust `PetRule`. */
export type BuddyPetRule =
  | (typeof BUDDY_PET_MANIFEST_RULES)[number]
  | 'manifest-json'
  | 'cell-transparency'
  | 'sheet-missing'
  | 'sheet-format'
  | 'sheet-decode'
  | 'file-size'
  | 'pack-size'
  | 'sidecar'
  | 'pack-id'
  | 'pack-not-found'
  | 'pack-outside-root'
  | 'pack-io'

/** A refusal: the rule it broke and one plain sentence for the Buddy tab. */
export class BuddyPetError extends Error {
  constructor(
    readonly rule: BuddyPetRule,
    message: string
  ) {
    super(message)
    this.name = 'BuddyPetError'
  }
}

export type BuddyPetFrameKind = 'gaze' | 'reaction'

export interface BuddyPetFrame {
  id: string
  kind: BuddyPetFrameKind
  /** A plain file name in the pack folder. */
  sheet: string
  /** `[x, y, w, h]` in sheet pixels; square. */
  rect: [number, number, number, number]
  /** Gaze frames only: `[x, y]` in [-1, 1]², negative x = viewer's left, negative y = up. */
  gaze?: [number, number]
}

/** A page-pet manifest v1 that passed `validateBuddyPetManifest`. */
export interface BuddyPetManifest {
  version: 1
  name: string
  neutral: string
  /** Normalized transform origin; page-pet's motion defaults to `[0.5, 0.9]`. */
  pivot?: [number, number]
  frames: BuddyPetFrame[]
}

export type BuddyPetSource = 'videorc-creator' | 'page-pet-import' | 'still'

/** The Videorc sidecar `buddy.json` (D1, D16). */
export interface BuddyPetSidecar {
  version: 1
  source: BuddyPetSource
  /** Normalized top of the neutral silhouette in its cell; the bubble anchors here. */
  headTop: number
  talk: string[]
  createdAt?: string
  referenceSha256?: string
}

/** Width and height of one decoded (or header-read) sheet. */
export interface BuddyPetSheetSize {
  width: number
  height: number
}

/** A decoded sheet: RGBA bytes, row-major (an `ImageData` qualifies). */
export interface BuddyPetSheetPixels extends BuddyPetSheetSize {
  data: Uint8ClampedArray | Uint8Array
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedPair(value: unknown, min: number, max: number): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [a, b] = value as unknown[]
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
  return ok(a) && ok(b) ? [a, b] : null
}

const SHEET_NAME = /^[a-zA-Z0-9_-]+\.(png|webp|avif)$/

function validateSheet(frameId: string, value: unknown): string {
  const match = typeof value === 'string' ? SHEET_NAME.exec(value) : null
  if (!match) {
    throw new BuddyPetError(
      'sheet-name',
      `Frame ${frameId}: sheets must be local PNG or WebP file names, without paths.`
    )
  }
  if (match[1] === 'avif') {
    throw new BuddyPetError(
      'sheet-avif',
      `Frame ${frameId}: AVIF sheets are not supported. Use PNG or WebP.`
    )
  }
  return value as string
}

function validateRect(frameId: string, value: unknown): [number, number, number, number] {
  const refuse = (): never => {
    throw new BuddyPetError(
      'rect-square',
      `Frame ${frameId} needs a square rectangle of whole pixels.`
    )
  }
  if (!Array.isArray(value) || value.length !== 4) return refuse()
  const rect = value as unknown[]
  if (rect.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0)) return refuse()
  const [x, y, w, h] = rect as number[]
  if (!w || w !== h) return refuse()
  return [x!, y!, w, h!]
}

/**
 * Validate a parsed `manifest.json`: page-pet's `validateManifest` rules in
 * its order, then D1 (no `layers`, no AVIF) and D4 (64 frames, 128 to 1024 px
 * cells, nothing past 8192 px). Throws a `BuddyPetError` naming the rule.
 */
export function validateBuddyPetManifest(value: unknown): BuddyPetManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !Array.isArray(value.frames) ||
    !value.frames.length
  ) {
    throw new BuddyPetError(
      'manifest-v1',
      'This is not a page-pet manifest: it needs version 1, a name and frames.'
    )
  }
  const frames = value.frames as unknown[]
  if (frames.length > BUDDY_PET_FRAMES_MAX) {
    throw new BuddyPetError('frame-count', `A pack has at most ${BUDDY_PET_FRAMES_MAX} frames.`)
  }
  if (value.puppet) {
    throw new BuddyPetError(
      'puppet-retired',
      'Static two-image puppets are not supported. Use a complete-character pack.'
    )
  }
  if (value.layers) {
    throw new BuddyPetError(
      'legacy-layers',
      'Two-layer packs (separate head and body) are not supported. Use a complete-character pack.'
    )
  }
  let pivot: [number, number] | undefined
  if (value.pivot !== undefined) {
    const parsed = boundedPair(value.pivot, 0, 1)
    if (!parsed) {
      throw new BuddyPetError('pivot-range', 'The pivot must be two numbers between 0 and 1.')
    }
    pivot = parsed
  }

  const ids = new Set<string>()
  const points: [number, number][] = []
  const typed: BuddyPetFrame[] = []
  for (const entry of frames) {
    const frame = isRecord(entry) ? entry : {}
    const id = frame.id
    if (typeof id !== 'string' || !id || ids.has(id)) {
      throw new BuddyPetError('frame-id', 'Every frame needs its own id.')
    }
    if (frame.expression !== undefined) {
      throw new BuddyPetError(
        'frame-expression',
        `Frame ${id}: expressions belong to two-layer packs, which are not supported.`
      )
    }
    ids.add(id)
    const sheet = validateSheet(id, frame.sheet)
    const rect = validateRect(id, frame.rect)
    if (frame.kind !== 'gaze' && frame.kind !== 'reaction') {
      throw new BuddyPetError('frame-kind', `Frame ${id}: the kind must be gaze or reaction.`)
    }
    const kind: BuddyPetFrameKind = frame.kind
    if (kind === 'gaze') {
      const gaze = boundedPair(frame.gaze, -1, 1)
      if (!gaze) {
        throw new BuddyPetError(
          'gaze-range',
          `Frame ${id}: gaze coordinates must be between -1 and 1.`
        )
      }
      // Numeric equality, as page-pet's joined strings compare (-0 == 0).
      if (points.some(([x, y]) => x === gaze[0] && y === gaze[1])) {
        throw new BuddyPetError(
          'gaze-unique',
          `Frame ${id}: another frame already looks in that direction.`
        )
      }
      points.push(gaze)
      typed.push({ id, kind, sheet, rect, gaze })
    } else {
      typed.push({ id, kind, sheet, rect })
    }
  }
  const neutral = value.neutral
  if (
    typeof neutral !== 'string' ||
    !typed.some((frame) => frame.id === neutral && frame.kind === 'gaze')
  ) {
    throw new BuddyPetError('neutral-missing', 'The manifest needs a neutral gaze frame.')
  }

  // D4, after every page-pet rule.
  for (const frame of typed) {
    if (frame.id.length > BUDDY_PET_TEXT_MAX) {
      throw new BuddyPetError('frame-id', `Frame ids are at most ${BUDDY_PET_TEXT_MAX} characters.`)
    }
    const [x, y, w, h] = frame.rect
    if (w < BUDDY_PET_CELL_MIN || w > BUDDY_PET_CELL_MAX) {
      throw new BuddyPetError(
        'cell-size',
        `Frame ${frame.id}: cells must be ${BUDDY_PET_CELL_MIN} to ${BUDDY_PET_CELL_MAX} pixels.`
      )
    }
    if (x + w > BUDDY_PET_SHEET_MAX_SIDE || y + h > BUDDY_PET_SHEET_MAX_SIDE) {
      throw new BuddyPetError(
        'rect-limit',
        `Frame ${frame.id} reaches past ${BUDDY_PET_SHEET_MAX_SIDE} pixels, larger than any sheet.`
      )
    }
  }

  const manifest: BuddyPetManifest = { version: 1, name: value.name, neutral, frames: typed }
  if (pivot) manifest.pivot = pivot
  return manifest
}

/** `manifest.json` text to a validated manifest. */
export function parseBuddyPetManifest(text: string): BuddyPetManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new BuddyPetError(
      'manifest-json',
      `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return validateBuddyPetManifest(value)
}

/** Every sheet the frames name, each once (page-pet `sheetNames`). */
export function buddyPetSheetNames(manifest: BuddyPetManifest): string[] {
  return [...new Set(manifest.frames.map((frame) => frame.sheet))].sort()
}

export function buddyPetNeutralFrame(manifest: BuddyPetManifest): BuddyPetFrame | null {
  return (
    manifest.frames.find((frame) => frame.id === manifest.neutral && frame.kind === 'gaze') ?? null
  )
}

/**
 * page-pet's `validateImages` on sheet dimensions (every rect inside its
 * sheet), then the D4 sheet side and decode budget.
 */
export function validateBuddyPetSheetSizes(
  manifest: BuddyPetManifest,
  sizes: ReadonlyMap<string, BuddyPetSheetSize>
): void {
  for (const frame of manifest.frames) {
    const size = sizes.get(frame.sheet)
    const [x, y, w, h] = frame.rect
    if (!size || x + w > size.width || y + h > size.height) {
      throw new BuddyPetError('frame-outside-sheet', `Frame ${frame.id} is outside its sheet.`)
    }
  }
  let decoded = 0
  for (const name of buddyPetSheetNames(manifest)) {
    const { width, height } = sizes.get(name)!
    if (width > BUDDY_PET_SHEET_MAX_SIDE || height > BUDDY_PET_SHEET_MAX_SIDE) {
      throw new BuddyPetError(
        'sheet-size',
        `${name} is ${width} × ${height}; sheets are at most ${BUDDY_PET_SHEET_MAX_SIDE} pixels on each side.`
      )
    }
    decoded += width * height * 4
  }
  if (decoded > BUDDY_PET_DECODED_MAX_BYTES) {
    throw new BuddyPetError(
      'decoded-budget',
      'The sheets are too large together: they must decode to under 128 MB.'
    )
  }
}

function cellHasCharacterOnTransparency(
  sheet: BuddyPetSheetPixels,
  [x, y, w, h]: BuddyPetFrame['rect']
): boolean {
  let clear = 0
  let solid = 0
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const alpha = sheet.data[(row * sheet.width + col) * 4 + 3]!
      if (alpha === 0) clear++
      if (alpha > 128) solid++
    }
  }
  const area = w * h
  // The playground's 64 × 64 probe thresholds (328 clear, 32 solid of 4096).
  return clear * 4096 >= 328 * area && solid * 4096 >= 32 * area
}

/**
 * page-pet `validateImages` on decoded sheets, plus the playground's check
 * that every cell shows a character on real transparency.
 */
export function validateBuddyPetImages(
  manifest: BuddyPetManifest,
  sheets: ReadonlyMap<string, BuddyPetSheetPixels>
): void {
  validateBuddyPetSheetSizes(manifest, sheets)
  for (const frame of manifest.frames) {
    if (!cellHasCharacterOnTransparency(sheets.get(frame.sheet)!, frame.rect)) {
      throw new BuddyPetError(
        'cell-transparency',
        `Frame ${frame.id} needs a visible character on a transparent background.`
      )
    }
  }
}

/** The normalized top of the neutral silhouette (alpha > 16), rounded to 4
 * places; null when the neutral cell is empty or outside its sheet. */
export function measureBuddyPetHeadTop(
  manifest: BuddyPetManifest,
  sheets: ReadonlyMap<string, BuddyPetSheetPixels>
): number | null {
  const frame = buddyPetNeutralFrame(manifest)
  const sheet = frame ? sheets.get(frame.sheet) : undefined
  if (!frame || !sheet) return null
  const [x, y, w, h] = frame.rect
  if (x + w > sheet.width || y + h > sheet.height) return null
  for (let row = 0; row < h; row++) {
    for (let col = x; col < x + w; col++) {
      if (sheet.data[((y + row) * sheet.width + col) * 4 + 3]! > BUDDY_PET_ALPHA_SOLID) {
        return Math.round((row / h) * 10_000) / 10_000
      }
    }
  }
  return null
}

// --- Store wire (plan 168 S-A3) ------------------------------------------------

/** The Buddy's avatar kind (D2): Still renders the persona's state images,
 * Alive a pet pack (a uuid of the persona's own, or `bundled:<name>`). */
export type BuddyAvatar = { kind: 'still' } | { kind: 'alive'; packId: string }

/** One pack the persona can wear (`cohost.pet.list`, `cohost.pet.import`). */
export interface BuddyPetSummary {
  /** A uuid for the persona's own packs, `bundled:<name>` for shipped ones. */
  packId: string
  name: string
  /** The neutral cell's side in sheet pixels. */
  cellSize: number
  gazeCount: number
  /** Reaction ids in manifest order. */
  reactions: string[]
  source: BuddyPetSource
  /** The sidecar names talk frames (D12). */
  hasTalk: boolean
}

/** What main's folder import hands back: the stored pack and the files in
 * the chosen folder that were not copied (not a pack file, or a link). */
export interface BuddyPetImportResult {
  pack: BuddyPetSummary
  skippedFiles: string[]
}

// --- Persona motion and reactions (plan 168 S-A4, D10, D13, D14, D15) --------

/** What an event makes the Buddy react to (D14). Moderation flags never are. */
export type BuddyTrigger =
  | 'follow'
  | 'subscription'
  | 'gift'
  | 'tip'
  | 'raid'
  | 'watch-streak'
  | 'redemption'
  | 'destination-failed'

export const BUDDY_TRIGGERS: readonly BuddyTrigger[] = [
  'follow',
  'subscription',
  'gift',
  'tip',
  'raid',
  'watch-streak',
  'redemption',
  'destination-failed'
]

/** D14's default reaction per trigger, as a fallback chain: the first id the
 * pack has wins, then a motion-only hop. Empty means none. */
export const BUDDY_TRIGGER_DEFAULT_REACTIONS: Readonly<Record<BuddyTrigger, readonly string[]>> = {
  follow: ['wave', 'proud'],
  subscription: ['excited'],
  gift: ['excited'],
  tip: ['surprised'],
  raid: ['surprised'],
  'watch-streak': ['proud'],
  redemption: ['wink'],
  'destination-failed': []
}

/** A reaction override that turns a trigger's reaction off. */
export const BUDDY_REACTION_NONE = 'none'
/** The still pack's reaction ids: the persona's state images (D2). */
export const BUDDY_STILL_REACTION_IDS = ['talk', 'laugh', 'think'] as const

const BUDDY_REACTION_ID = /^[a-z0-9-]{1,40}$/

/** A reaction id a persona may name (a reaction override, a greeting's
 * `reaction`): 1 to 40 characters of `[a-z0-9-]`, `none` included. */
export function isBuddyReactionId(value: unknown): value is string {
  return typeof value === 'string' && BUDDY_REACTION_ID.test(value)
}

/** How the Buddy moves on air (D10, D13, D15), per persona. */
export interface BuddyMotionSettings {
  /** 0 to 1; multiplies every transform; 0 keeps frame changes only. */
  intensity: number
  /** 0 = never, else 30 to 1800. */
  sleepAfterSeconds: number
  breathing: boolean
}

export const BUDDY_SLEEP_AFTER_MIN_SECONDS = 30
export const BUDDY_SLEEP_AFTER_MAX_SECONDS = 1800
/** Owner defaults (plan 168 open questions 2 and 3). */
export const BUDDY_MOTION_DEFAULTS: Readonly<BuddyMotionSettings> = {
  intensity: 0.45,
  sleepAfterSeconds: 180,
  breathing: true
}

/** Per-trigger reaction overrides (D14): a reaction id or `none`. */
export type BuddyReactionTable = Partial<Record<BuddyTrigger, string>>
