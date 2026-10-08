// Golem pet packs (plan 168 Phase A, D1 to D4): the page-pet manifest v1
// contract as the renderer preview and main see it. The backend's
// `golem_pet.rs` runs the same rules; `protocol-fixtures/golem-pet-manifests.json`
// is run by both, and every failing case names its rule.
//
// Ported from page-pet (`gvastethecreator/page-pet-skill` `0b6a0ef`, MIT,
// copyright 2026 Cristian): `runtime/manifest.js` (`validateManifest`,
// `validateSprite`, `validateImages`, `sheetNames`) and the import guards of
// `playground/app.js`. Pure: no DOM, no fs, no electron.

/** page-pet's import guard, per file (D4). */
export const GOLEM_PET_FILE_MAX_BYTES = 32 * 1024 * 1024
/** page-pet's import guard, for the whole pack (D4). */
export const GOLEM_PET_PACK_MAX_BYTES = 128 * 1024 * 1024
/** A sheet is at most 8192 px on each side (D4). */
export const GOLEM_PET_SHEET_MAX_SIDE = 8192
/** Cells are square, 128 to 1024 px (D4). */
export const GOLEM_PET_CELL_MIN = 128
export const GOLEM_PET_CELL_MAX = 1024
/** At most 64 frames per pack (D4). */
export const GOLEM_PET_FRAMES_MAX = 64
/** Decoded sheets together stay under the compositor decode budget (D4). */
export const GOLEM_PET_DECODED_MAX_BYTES = 128 * 1024 * 1024
/** The alpha a pixel needs to count as the character (page-pet's builder). */
export const GOLEM_PET_ALPHA_SOLID = 16
/** Frame ids and the listed pack name are at most 64 UTF-16 units (Videorc). */
export const GOLEM_PET_TEXT_MAX = 64

/** The rules the shared fixture covers, in the order they are checked. */
export const GOLEM_PET_MANIFEST_RULES = [
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
export type GolemPetRule =
  | (typeof GOLEM_PET_MANIFEST_RULES)[number]
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

/** A refusal: the rule it broke and one plain sentence for the Golem tab. */
export class GolemPetError extends Error {
  constructor(
    readonly rule: GolemPetRule,
    message: string
  ) {
    super(message)
    this.name = 'GolemPetError'
  }
}

export type GolemPetFrameKind = 'gaze' | 'reaction'

export interface GolemPetFrame {
  id: string
  kind: GolemPetFrameKind
  /** A plain file name in the pack folder. */
  sheet: string
  /** `[x, y, w, h]` in sheet pixels; square. */
  rect: [number, number, number, number]
  /** Gaze frames only: `[x, y]` in [-1, 1]², negative x = viewer's left, negative y = up. */
  gaze?: [number, number]
}

/** A page-pet manifest v1 that passed `validateGolemPetManifest`. */
export interface GolemPetManifest {
  version: 1
  name: string
  neutral: string
  /** Normalized transform origin; page-pet's motion defaults to `[0.5, 0.9]`. */
  pivot?: [number, number]
  frames: GolemPetFrame[]
}

export type GolemPetSource = 'videorc-creator' | 'page-pet-import' | 'still'

/** The Videorc sidecar `golem.json` (D1, D16). */
export interface GolemPetSidecar {
  version: 1
  source: GolemPetSource
  /** Normalized top of the neutral silhouette in its cell; the bubble anchors here. */
  headTop: number
  talk: string[]
  createdAt?: string
  referenceSha256?: string
}

/** Width and height of one decoded (or header-read) sheet. */
export interface GolemPetSheetSize {
  width: number
  height: number
}

/** A decoded sheet: RGBA bytes, row-major (an `ImageData` qualifies). */
export interface GolemPetSheetPixels extends GolemPetSheetSize {
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
    throw new GolemPetError(
      'sheet-name',
      `Frame ${frameId}: sheets must be local PNG or WebP file names, without paths.`
    )
  }
  if (match[1] === 'avif') {
    throw new GolemPetError(
      'sheet-avif',
      `Frame ${frameId}: AVIF sheets are not supported. Use PNG or WebP.`
    )
  }
  return value as string
}

function validateRect(frameId: string, value: unknown): [number, number, number, number] {
  const refuse = (): never => {
    throw new GolemPetError(
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
 * cells, nothing past 8192 px). Throws a `GolemPetError` naming the rule.
 */
export function validateGolemPetManifest(value: unknown): GolemPetManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !Array.isArray(value.frames) ||
    !value.frames.length
  ) {
    throw new GolemPetError(
      'manifest-v1',
      'This is not a page-pet manifest: it needs version 1, a name and frames.'
    )
  }
  const frames = value.frames as unknown[]
  if (frames.length > GOLEM_PET_FRAMES_MAX) {
    throw new GolemPetError('frame-count', `A pack has at most ${GOLEM_PET_FRAMES_MAX} frames.`)
  }
  if (value.puppet) {
    throw new GolemPetError(
      'puppet-retired',
      'Static two-image puppets are not supported. Use a complete-character pack.'
    )
  }
  if (value.layers) {
    throw new GolemPetError(
      'legacy-layers',
      'Two-layer packs (separate head and body) are not supported. Use a complete-character pack.'
    )
  }
  let pivot: [number, number] | undefined
  if (value.pivot !== undefined) {
    const parsed = boundedPair(value.pivot, 0, 1)
    if (!parsed) {
      throw new GolemPetError('pivot-range', 'The pivot must be two numbers between 0 and 1.')
    }
    pivot = parsed
  }

  const ids = new Set<string>()
  const points: [number, number][] = []
  const typed: GolemPetFrame[] = []
  for (const entry of frames) {
    const frame = isRecord(entry) ? entry : {}
    const id = frame.id
    if (typeof id !== 'string' || !id || ids.has(id)) {
      throw new GolemPetError('frame-id', 'Every frame needs its own id.')
    }
    if (frame.expression !== undefined) {
      throw new GolemPetError(
        'frame-expression',
        `Frame ${id}: expressions belong to two-layer packs, which are not supported.`
      )
    }
    ids.add(id)
    const sheet = validateSheet(id, frame.sheet)
    const rect = validateRect(id, frame.rect)
    if (frame.kind !== 'gaze' && frame.kind !== 'reaction') {
      throw new GolemPetError('frame-kind', `Frame ${id}: the kind must be gaze or reaction.`)
    }
    const kind: GolemPetFrameKind = frame.kind
    if (kind === 'gaze') {
      const gaze = boundedPair(frame.gaze, -1, 1)
      if (!gaze) {
        throw new GolemPetError(
          'gaze-range',
          `Frame ${id}: gaze coordinates must be between -1 and 1.`
        )
      }
      // Numeric equality, as page-pet's joined strings compare (-0 == 0).
      if (points.some(([x, y]) => x === gaze[0] && y === gaze[1])) {
        throw new GolemPetError(
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
    throw new GolemPetError('neutral-missing', 'The manifest needs a neutral gaze frame.')
  }

  // D4, after every page-pet rule.
  for (const frame of typed) {
    if (frame.id.length > GOLEM_PET_TEXT_MAX) {
      throw new GolemPetError('frame-id', `Frame ids are at most ${GOLEM_PET_TEXT_MAX} characters.`)
    }
    const [x, y, w, h] = frame.rect
    if (w < GOLEM_PET_CELL_MIN || w > GOLEM_PET_CELL_MAX) {
      throw new GolemPetError(
        'cell-size',
        `Frame ${frame.id}: cells must be ${GOLEM_PET_CELL_MIN} to ${GOLEM_PET_CELL_MAX} pixels.`
      )
    }
    if (x + w > GOLEM_PET_SHEET_MAX_SIDE || y + h > GOLEM_PET_SHEET_MAX_SIDE) {
      throw new GolemPetError(
        'rect-limit',
        `Frame ${frame.id} reaches past ${GOLEM_PET_SHEET_MAX_SIDE} pixels, larger than any sheet.`
      )
    }
  }

  const manifest: GolemPetManifest = { version: 1, name: value.name, neutral, frames: typed }
  if (pivot) manifest.pivot = pivot
  return manifest
}

/** `manifest.json` text to a validated manifest. */
export function parseGolemPetManifest(text: string): GolemPetManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new GolemPetError(
      'manifest-json',
      `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return validateGolemPetManifest(value)
}

/** Every sheet the frames name, each once (page-pet `sheetNames`). */
export function golemPetSheetNames(manifest: GolemPetManifest): string[] {
  return [...new Set(manifest.frames.map((frame) => frame.sheet))].sort()
}

export function golemPetNeutralFrame(manifest: GolemPetManifest): GolemPetFrame | null {
  return (
    manifest.frames.find((frame) => frame.id === manifest.neutral && frame.kind === 'gaze') ?? null
  )
}

/**
 * page-pet's `validateImages` on sheet dimensions (every rect inside its
 * sheet), then the D4 sheet side and decode budget.
 */
export function validateGolemPetSheetSizes(
  manifest: GolemPetManifest,
  sizes: ReadonlyMap<string, GolemPetSheetSize>
): void {
  for (const frame of manifest.frames) {
    const size = sizes.get(frame.sheet)
    const [x, y, w, h] = frame.rect
    if (!size || x + w > size.width || y + h > size.height) {
      throw new GolemPetError('frame-outside-sheet', `Frame ${frame.id} is outside its sheet.`)
    }
  }
  let decoded = 0
  for (const name of golemPetSheetNames(manifest)) {
    const { width, height } = sizes.get(name)!
    if (width > GOLEM_PET_SHEET_MAX_SIDE || height > GOLEM_PET_SHEET_MAX_SIDE) {
      throw new GolemPetError(
        'sheet-size',
        `${name} is ${width} × ${height}; sheets are at most ${GOLEM_PET_SHEET_MAX_SIDE} pixels on each side.`
      )
    }
    decoded += width * height * 4
  }
  if (decoded > GOLEM_PET_DECODED_MAX_BYTES) {
    throw new GolemPetError(
      'decoded-budget',
      'The sheets are too large together: they must decode to under 128 MB.'
    )
  }
}

function cellHasCharacterOnTransparency(
  sheet: GolemPetSheetPixels,
  [x, y, w, h]: GolemPetFrame['rect']
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
export function validateGolemPetImages(
  manifest: GolemPetManifest,
  sheets: ReadonlyMap<string, GolemPetSheetPixels>
): void {
  validateGolemPetSheetSizes(manifest, sheets)
  for (const frame of manifest.frames) {
    if (!cellHasCharacterOnTransparency(sheets.get(frame.sheet)!, frame.rect)) {
      throw new GolemPetError(
        'cell-transparency',
        `Frame ${frame.id} needs a visible character on a transparent background.`
      )
    }
  }
}

/** The normalized top of the neutral silhouette (alpha > 16), rounded to 4
 * places; null when the neutral cell is empty or outside its sheet. */
export function measureGolemPetHeadTop(
  manifest: GolemPetManifest,
  sheets: ReadonlyMap<string, GolemPetSheetPixels>
): number | null {
  const frame = golemPetNeutralFrame(manifest)
  const sheet = frame ? sheets.get(frame.sheet) : undefined
  if (!frame || !sheet) return null
  const [x, y, w, h] = frame.rect
  if (x + w > sheet.width || y + h > sheet.height) return null
  for (let row = 0; row < h; row++) {
    for (let col = x; col < x + w; col++) {
      if (sheet.data[((y + row) * sheet.width + col) * 4 + 3]! > GOLEM_PET_ALPHA_SOLID) {
        return Math.round((row / h) * 10_000) / 10_000
      }
    }
  }
  return null
}

// --- Store wire (plan 168 S-A3) ------------------------------------------------

/** The Golem's avatar kind (D2): Still renders the persona's state images,
 * Alive a pet pack (a uuid of the persona's own, or `bundled:<name>`). */
export type GolemAvatar = { kind: 'still' } | { kind: 'alive'; packId: string }

/** One pack the persona can wear (`cohost.pet.list`, `cohost.pet.import`). */
export interface GolemPetSummary {
  /** A uuid for the persona's own packs, `bundled:<name>` for shipped ones. */
  packId: string
  name: string
  /** The neutral cell's side in sheet pixels. */
  cellSize: number
  gazeCount: number
  /** Reaction ids in manifest order. */
  reactions: string[]
  source: GolemPetSource
  /** The sidecar names talk frames (D12). */
  hasTalk: boolean
}

/** What main's folder import hands back: the stored pack and the files in
 * the chosen folder that were not copied (not a pack file, or a link). */
export interface GolemPetImportResult {
  pack: GolemPetSummary
  skippedFiles: string[]
}
