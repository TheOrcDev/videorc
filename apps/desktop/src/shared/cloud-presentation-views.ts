// Plan 249 S6: one set of picture rules for every surface that shows a
// cloud room's stage: the program page, the desktop's Program preview and
// room view, the guest page and the agents' projection. Pure, and mirrored
// word for word by the web's `lib/cloud/program/presentation-views.ts`;
// both sides hold themselves to `protocol-fixtures/cloud-parity-views.json`.
//
// - A person's camera covers its tile (cropped, never stretched). A shared
//   screen is contained (letterboxed): its edges carry text and window
//   chrome, and a crop would hide them from viewers.
// - A person's portrait camera (a phone held upright, plan 254 S2) is drawn
//   whole, over a blurred, darkened copy of itself that covers the tile: a
//   centred cover of 9:16 in 16:9 keeps a third of its height and cuts the
//   eyes off. Where a portrait picture is still cropped (that fill), the
//   window sits on its upper third, where a selfie's face is.
// - The stage key names the stage the program page applied, so the desktop
//   can tell whether the program draws what it sent or still an older stage. A content key, not a counter: the same stage sent twice is the
//   same picture, and nothing has to be stored to make the two sides agree.
// - Nothing here is evidence of encoded output. A preview drawn from the
//   page's report is a reconstruction; only S26's egress probes prove what
//   viewers received.

export type TileKind = 'person' | 'screen'
export type TileFit = 'cover' | 'contain'
export type Size = { h: number; w: number }
export type Box = { h: number; w: number; x: number; y: number }

/** Person tiles cover; screen tiles contain. */
export function tileFit(kind: TileKind): TileFit {
  return kind === 'screen' ? 'contain' : 'cover'
}

/**
 * Where a `source`-sized picture goes in a `tile`-sized box.
 * `contain`: the drawn box inside the tile (letterboxed, centred).
 * `cover`: the window of the source that fills the tile (centred crop).
 * A zero size gives null: there is nothing to draw.
 */
export function fitBox(source: Size, tile: Size, fit: TileFit): Box | null {
  if (source.w <= 0 || source.h <= 0 || tile.w <= 0 || tile.h <= 0) return null
  if (fit === 'contain') {
    const scale = Math.min(tile.w / source.w, tile.h / source.h)
    const w = source.w * scale
    const h = source.h * scale
    return { h, w, x: (tile.w - w) / 2, y: (tile.h - h) / 2 }
  }
  if (source.w * tile.h > tile.w * source.h) {
    const w = (source.h * tile.w) / tile.h
    return { h: source.h, w, x: (source.w - w) / 2, y: 0 }
  }
  const h = (source.w * tile.h) / tile.w
  return { h, w: source.w, x: 0, y: (source.h - h) / 2 }
}

/** The scale for a picture drawn at its own size into a tile. */
export function fitScale(source: Size, tile: Size, fit: TileFit): number {
  if (source.w <= 0 || source.h <= 0) return 1
  const x = tile.w / source.w
  const y = tile.h / source.h
  return fit === 'contain' ? Math.min(x, y) : Math.max(x, y)
}

/**
 * Plan 254 S2: a picture turns portrait once it is this much taller than
 * wide, and turns back only when it is square or wider. Between the two it
 * stays what it was, so a source near square never flickers between fits.
 */
export const PORTRAIT_ENTER_RATIO = 1.1
/** A portrait cover window is centred on this share of the source's height. */
export const PORTRAIT_COVER_CENTRE = 1 / 3

/**
 * Whether a source of this decoded size is portrait, given what it `was`.
 * A size that is no picture (zero, or a track's 2×2 end) changes nothing.
 */
export function isPortrait(source: Size, was = false): boolean {
  if (source.w <= 2 || source.h <= 2) return was
  if (source.h >= source.w * PORTRAIT_ENTER_RATIO) return true
  if (source.h <= source.w) return false
  return was
}

/**
 * How a person's camera fills its tile. Landscape: `cover`, as ever.
 * Portrait: the whole picture (`contain`) over a `fill` of itself.
 */
export function personFit(portrait: boolean): { fill: boolean; fit: TileFit } {
  return portrait ? { fill: true, fit: 'contain' } : { fill: false, fit: 'cover' }
}

/**
 * The `cover` window of a portrait source: `fitBox`'s, moved up so its
 * centre is on the source's upper third (clamped inside the source). A
 * window as tall as the source is `fitBox`'s own.
 */
export function portraitCoverBox(source: Size, tile: Size): Box | null {
  const box = fitBox(source, tile, 'cover')
  if (!box) return null
  const top = source.h * PORTRAIT_COVER_CENTRE - box.h / 2
  return { ...box, y: Math.min(Math.max(top, 0), source.h - box.h) }
}

/**
 * Everything a tile draws for a person's camera of this size, in order: the
 * `fill` window of the source (stretched over the whole tile, blurred and
 * darkened by the caller), or null for none; then `picture`, the window of
 * the source (`cover`) or the box in the tile (`contain`), as `fitBox`.
 */
export function personPicture(
  source: Size,
  tile: Size,
  portrait: boolean
): { fill: Box | null; fit: TileFit; picture: Box } | null {
  const { fill, fit } = personFit(portrait)
  const picture = fitBox(source, tile, fit)
  if (!picture) return null
  return { fill: fill ? portraitCoverBox(source, tile) : null, fit, picture }
}

/** The stage as the program page reads it from room metadata. */
export type KeyedStage = {
  hostShape?: string | null
  layout: string
  onStage: readonly string[]
  screen?: string | null
  /** Plan 251: the two screens of the two-screens layout. */
  screens?: readonly string[] | null
  spotlight?: string | null
}

/**
 * Plan 251: a stage's two screens as the page normalizes them: two different
 * on-stage identities, the first of them the stage's `screen`. Anything else
 * is no pair, and the stage shows its one `screen`.
 */
export function stageScreenPair(stage: KeyedStage, onStage: readonly string[]): string[] {
  const pair = stage.screens
  if (!pair || pair.length !== 2) return []
  const [first, second] = pair
  if (first === undefined || second === undefined) return []
  if (first === second || first !== stage.screen) return []
  return onStage.includes(first) && onStage.includes(second) ? [first, second] : []
}

/** The canonical form both sides hash: the page's own normalization. */
export function canonicalStage(stage: KeyedStage): string {
  const onStage: string[] = []
  for (const identity of stage.onStage) {
    if (!onStage.includes(identity)) onStage.push(identity)
  }
  const named = (identity: string | null | undefined): string =>
    identity && onStage.includes(identity) ? identity : ''
  const shape = stage.hostShape === 'circle' ? 'circle' : 'rounded'
  const pair = stageScreenPair(stage, onStage)
  return [
    'v1',
    stage.layout,
    shape,
    onStage.join(','),
    named(stage.spotlight),
    named(stage.screen),
    // Plan 251: only a stage with two screens has this part, so every
    // stage an older page or desktop keys keeps the key it had.
    ...(pair.length === 2 ? [pair.join(',')] : [])
  ].join('|')
}

/** FNV-1a 32 over UTF-16 code units, as 8 lowercase hex digits. */
export function stageKey(stage: KeyedStage): string {
  const text = canonicalStage(stage)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const STAGE_KEY_PATTERN = /^[0-9a-f]{8}$/

/** The web drops a page's report after this long (`PROGRAM_STALE_SECONDS`). */
export const PROGRAM_PREVIEW_STALE_MS = 25_000
/** A report time this far ahead of the desktop clock is not trusted. */
const CLOCK_AHEAD_LIMIT_MS = 5_000

/**
 * What the Program preview may say about the stage it draws:
 *
 * - `empty`: nothing is on air or recording;
 * - `waiting`: running, and no page has reported a stage yet;
 * - `applied`: a fresh report names the stage this desktop sent;
 * - `updating`: a fresh report names another stage (an older one, or one
 *   still on its way);
 * - `unconfirmed`: the page cannot say which stage it applied (an older
 *   page, or a report time the desktop cannot read);
 * - `stale`: the last report is too old to describe the program now.
 *
 * `applied` is the program page's own acknowledgement, never proof that
 * the encoded stream or recording carries it.
 */
export type ProgramPreviewState =
  | 'empty'
  | 'waiting'
  | 'applied'
  | 'updating'
  | 'unconfirmed'
  | 'stale'

export type ProgramPreviewStage = {
  state: ProgramPreviewState
  /** How old the report is, when the page dated it. */
  ageMs: number | null
  /** The key the page applied, when it gave one. */
  appliedKey: string | null
  /** Always false: a page's report is not encoded output. */
  encodedOutput: false
}

export function programPreviewStage(input: {
  running: boolean
  sent: KeyedStage | null | undefined
  shown: { at?: string | null; stageKey?: string | null } | null | undefined
  now: number
}): ProgramPreviewStage {
  const result = (
    state: ProgramPreviewState,
    ageMs: number | null = null,
    appliedKey: string | null = null
  ): ProgramPreviewStage => ({ state, ageMs, appliedKey, encodedOutput: false })
  if (!input.running) return result('empty')
  if (!input.shown) return result('waiting')
  const key = input.shown.stageKey
  const at = input.shown.at ? Date.parse(input.shown.at) : Number.NaN
  if (!key || !STAGE_KEY_PATTERN.test(key) || !Number.isFinite(at)) {
    return result('unconfirmed')
  }
  const age = input.now - at
  if (age < -CLOCK_AHEAD_LIMIT_MS) return result('unconfirmed', null, key)
  const ageMs = Math.max(0, age)
  if (ageMs > PROGRAM_PREVIEW_STALE_MS) return result('stale', ageMs, key)
  if (!input.sent) return result('unconfirmed', ageMs, key)
  return result(stageKey(input.sent) === key ? 'applied' : 'updating', ageMs, key)
}

/**
 * Which surface draws what (plan 249 architecture 6). Each one names its
 * source, and none claims to be the encoded program.
 *
 * - `room`: the Show stage, the room's own tracks at room latency; the
 *   conversation the host acts on, never "the program";
 * - `program-preview`: the stage as the program page reports drawing it,
 *   redrawn here with the same geometry; a reconstruction;
 * - `runner-return`: a node show's runner return (managed shows have none);
 * - `guest`: what a guest page shows: people, the selected shared screen,
 *   and only public graphics (D4).
 */
export type ViewSurface = 'room' | 'program-preview' | 'runner-return' | 'guest'

export const VIEW_SOURCE: Record<ViewSurface, string> = {
  room: 'room-tracks',
  'program-preview': 'program-page-report',
  'runner-return': 'runner-return',
  guest: 'guest-projection'
}
