/**
 * Plan 249 S12. A native saved or preset scene as cloud presentation.
 * Mirrored in the program client (web `lib/cloud/program/cloud-scene.ts`) and
 * pinned on both sides by `protocol-fixtures/cloud-parity-scenes.json`.
 *
 * The native layout engine stays the authority: the desktop asks the backend
 * to resolve a scene (`cloud.scene.resolve`, Rust `scene_from_capture_config`)
 * and translates the answer into the roles below. Nothing here recomputes a
 * preset. Pure: no DOM, no clock reads, no backend types.
 *
 * Roles. `host-camera` is the host's camera; `screen` is the stage's selected
 * screen (the host's by default, a guest's when the stage shares one), so a
 * scene's screen box shows whoever's screen is up. Guests are explicit: each
 * on-stage guest takes the next `guests.slots` rect, and any guest without a
 * slot fills `guests.region` in equal 16:9 cells. A scene never removes a
 * guest (D7). With no guest on stage the host scene fills the canvas exactly;
 * with guests it is drawn scaled into `guests.host`.
 *
 * Extends S3's consumer capability as an optional `scene` field; it is not a
 * second negotiation. Applied revisions are per egress lane and are page
 * render observations, never encoded-output proof.
 *
 * Plan 249 S14: a scene may carry its native background (`cloud-background.ts`).
 * Older pages ignore the field; a page that draws it says so in
 * `SceneCapability.background`.
 */

export const SCENE_TOPIC = 'videorc.presentation.scene.v1'
export const SCENE_MAX_BYTES = 16 * 1024
export const SCENE_LEASE_MS = 30_000
/** The native transition (`compositor.rs` SCENE_TRANSITION_MS in use-studio). */
export const SCENE_MOTION_MS = 320
export const SCENE_MOTION_MAX_MS = 2000
/** A source with no predecessor grows in from this scale (Rust `synthetic_enter_from`). */
export const SCENE_ENTER_SCALE = 0.92
export const SCENE_MAX_GUEST_SLOTS = 6
export const SCENE_EXTENSION_VERSION = 1
export const CLOUD_SCENES_PRODUCTION_QUALIFIED = false

export type SceneOutput = 'stream' | 'recording'
export type SceneOrientation = 'h' | 'v'
/** Canvas fractions. Boxes may start off the canvas (native freeform). */
export type SceneRect = { x: number; y: number; w: number; h: number }
/** Fractions of the source picture, before any mirror. */
export type SceneCrop = { l: number; t: number; r: number; b: number }
export type SceneFit = 'contain' | 'cover'
export type SceneMask =
  | { shape: 'rectangle' }
  /** `radius`: fraction of the box's shorter side, at most 0.5. */
  | { shape: 'rounded'; radius: number }
  | { shape: 'circle' }
export type SceneRole = 'host-camera' | 'screen'
export type SceneItem = {
  role: SceneRole
  rect: SceneRect
  crop: SceneCrop
  fit: SceneFit
  mirror: boolean
  mask: SceneMask
  /** Draw order, low first; native source order. */
  z: number
}
export type SceneGuests = {
  /** Where the host scene is drawn while any guest is on stage. */
  host: SceneRect
  /** Where guests without an explicit slot are drawn. */
  region: SceneRect
  /** Explicit guest roles, in stage order. */
  slots: SceneRect[]
}
export type CloudScene = {
  /** Opaque content key; never the user's scene name. */
  id: string
  items: SceneItem[]
  guests: SceneGuests
  /** S14: drawn behind every item; absent = the page's plain ground. */
  background?: SceneBackground
}
export type SceneTransition = {
  kind: 'cut' | 'motion'
  durationMs: number
  /** Wall-clock ms the transition starts; a late join continues the phase. */
  applyAt: number
}
export type SceneApplied = { publisherSid: string; revision: number }
export type SceneCapability = {
  version: 1
  output: SceneOutput
  orientation: SceneOrientation
  applied?: SceneApplied
  /** S14: the page draws scene backgrounds, and what it drew last. */
  background?: BackgroundCapability
}
export type SceneSnapshot = {
  version: 1
  show: string
  publisherSid: string
  revision: number
  output: SceneOutput
  orientation: SceneOrientation
  expiresAt: number
  /** Null: no scene; the page draws the room's own layouts. */
  scene: CloudScene | null
  transition: SceneTransition
}
/** The saved-scene extension (`SavedScene.cloud`). Native fields are untouched. */
export type CloudSceneExtension = {
  version: typeof SCENE_EXTENSION_VERSION
  guests: SceneGuests
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const sid = (v: unknown): v is string => typeof v === 'string' && /^PA_[A-Za-z0-9]{1,64}$/.test(v)
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Plan 249 S14: the scene background (see `cloud-background.ts` for the
 * asset transport, clock and native rules). Here so that this module keeps
 * no relative imports: Node's type stripping loads it as is.
 */
/** Longest side of a sent picture; zoom crops up to 2x, so above the canvas. */
export const BACKGROUND_ASSET_MAX_SIDE = 2560
export const BACKGROUND_DIM_MAX = 0.8
/** The ten live backgrounds (`looks::ALL_LIVE_BACKGROUNDS`, wire ids). */
export const LIVE_BACKGROUND_IDS = [
  'silk',
  'side-rays',
  'plasma-wave',
  'liquid-chrome',
  'line-waves',
  'beams',
  'color-bends',
  'dither',
  'ferrofluid',
  'ghost-fibers'
] as const

export type LiveBackgroundWireId = (typeof LIVE_BACKGROUND_IDS)[number]
export type BackgroundMime = 'image/webp' | 'image/jpeg' | 'image/png'
export type BackgroundCrop = { l: number; t: number; r: number; b: number }
export type PictureBackground = {
  kind: 'picture'
  /** SHA-256 of the encoded bytes, 64 lowercase hex. */
  hash: string
  mime: BackgroundMime
  width: number
  height: number
  fit: 'contain' | 'cover'
  crop: BackgroundCrop
}
export type LiveBackground = {
  kind: 'live'
  id: LiveBackgroundWireId
  look: string
  /** Shader Dim, 0..0.8. */
  dim: number
  /**
   * The shared phase clock: phase = anchorPhase + rate * seconds since
   * anchorAt (wall ms). `rate` already includes the motion factor (Calm =
   * half). One anchor for every lane, so H/V and stream/recording agree.
   */
  clock: { anchorAt: number; anchorPhase: number; rate: number }
}
export type SceneBackground = PictureBackground | LiveBackground

/** How a page drew the background it was given. */
export type BackgroundRendering = 'picture' | 'shader' | 'half' | 'still' | 'none'
export type BackgroundStillReason =
  | 'no-webgl2'
  | 'shader-compile-failed'
  | 'context-lost'
  | 'gpu-budget'
  | 'unknown-look'
  | 'asset-missing'
  | 'asset-invalid'
export const BACKGROUND_STILL_REASONS: readonly BackgroundStillReason[] = [
  'no-webgl2',
  'shader-compile-failed',
  'context-lost',
  'gpu-budget',
  'unknown-look',
  'asset-missing',
  'asset-invalid'
]
export type BackgroundDrawn = {
  /** `backgroundKey` of what was drawn ('none' for no background). */
  key: string
  rendering: BackgroundRendering
  reason?: BackgroundStillReason
}
/** `SceneCapability.background`: the page draws scene backgrounds. */
export type BackgroundCapability = {
  version: 1
  /** The page carries the live shader runner (it may still fail: see `drawn`). */
  live: 0 | 1
  drawn?: BackgroundDrawn
}

const dimension = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= BACKGROUND_ASSET_MAX_SIDE

export const isBackgroundHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
export const isBackgroundMime = (v: unknown): v is BackgroundMime =>
  v === 'image/webp' || v === 'image/jpeg' || v === 'image/png'
export const isLiveBackgroundId = (v: unknown): v is LiveBackgroundWireId =>
  typeof v === 'string' && (LIVE_BACKGROUND_IDS as readonly string[]).includes(v)

function backgroundCrop(value: unknown): BackgroundCrop | null {
  if (!object(value)) return null
  const { l, t, r, b } = value
  if (![l, t, r, b].every((n) => finite(n) && n >= 0 && n <= 0.95)) return null
  if (Number(l) + Number(r) >= 0.96 || Number(t) + Number(b) >= 0.96) return null
  return { l: l as number, t: t as number, r: r as number, b: b as number }
}

/** A scene's background, or null when it is not one this contract knows. */
export function parseSceneBackground(value: unknown): SceneBackground | null {
  if (!object(value)) return null
  if (value.kind === 'picture') {
    const c = backgroundCrop(value.crop)
    if (
      !isBackgroundHash(value.hash) ||
      !isBackgroundMime(value.mime) ||
      !dimension(value.width) ||
      !dimension(value.height) ||
      (value.fit !== 'contain' && value.fit !== 'cover') ||
      !c
    )
      return null
    return {
      kind: 'picture',
      hash: value.hash,
      mime: value.mime,
      width: value.width,
      height: value.height,
      fit: value.fit,
      crop: c
    }
  }
  if (value.kind === 'live') {
    const clock = value.clock
    if (
      !isLiveBackgroundId(value.id) ||
      typeof value.look !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(value.look) ||
      !finite(value.dim) ||
      value.dim < 0 ||
      value.dim > BACKGROUND_DIM_MAX ||
      !object(clock) ||
      !Number.isSafeInteger(clock.anchorAt) ||
      Number(clock.anchorAt) <= 0 ||
      !finite(clock.anchorPhase) ||
      Math.abs(clock.anchorPhase) > 1e7 ||
      !finite(clock.rate) ||
      clock.rate < 0 ||
      clock.rate > 100
    )
      return null
    return {
      kind: 'live',
      id: value.id,
      look: value.look,
      dim: value.dim,
      clock: {
        anchorAt: clock.anchorAt as number,
        anchorPhase: clock.anchorPhase,
        rate: clock.rate
      }
    }
  }
  return null
}

export function parseBackgroundCapability(value: unknown): BackgroundCapability | null {
  if (!object(value) || value.version !== 1 || (value.live !== 0 && value.live !== 1)) return null
  let drawn: BackgroundDrawn | undefined
  if (value.drawn !== undefined) {
    const d = value.drawn
    if (
      !object(d) ||
      typeof d.key !== 'string' ||
      !/^(none|[0-9a-f]{8})$/.test(d.key) ||
      !['picture', 'shader', 'half', 'still', 'none'].includes(d.rendering as string) ||
      (d.reason !== undefined &&
        !BACKGROUND_STILL_REASONS.includes(d.reason as BackgroundStillReason))
    )
      return null
    drawn = {
      key: d.key,
      rendering: d.rendering as BackgroundRendering,
      ...(d.reason !== undefined ? { reason: d.reason as BackgroundStillReason } : {})
    }
  }
  return { version: 1, live: value.live, ...(drawn ? { drawn } : {}) }
}

/** Mirrors Rust `scene_geometry` bounds (plan 215 E3): position -3..4, size up to 4. */
export function sceneRect(value: unknown): value is SceneRect {
  if (!object(value)) return false
  const { x, y, w, h } = value
  return (
    finite(x) &&
    finite(y) &&
    finite(w) &&
    finite(h) &&
    x >= -3 &&
    x <= 4 &&
    y >= -3 &&
    y <= 4 &&
    w > 0 &&
    w <= 4 &&
    h > 0 &&
    h <= 4
  )
}
/** A region on the canvas: inside it, with some size. */
export function sceneRegion(value: unknown): value is SceneRect {
  return (
    sceneRect(value) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.w >= 0.05 &&
    value.h >= 0.05 &&
    value.x + value.w <= 1.00001 &&
    value.y + value.h <= 1.00001
  )
}
function sceneCrop(value: unknown): value is SceneCrop {
  if (!object(value)) return false
  const { l, t, r, b } = value
  return (
    [l, t, r, b].every((n) => finite(n) && n >= 0 && n < 0.95) &&
    Number(l) + Number(r) < 0.95 &&
    Number(t) + Number(b) < 0.95
  )
}
function sceneMask(value: unknown): SceneMask | null {
  if (!object(value)) return null
  if (value.shape === 'rectangle') return { shape: 'rectangle' }
  if (value.shape === 'circle') return { shape: 'circle' }
  if (value.shape === 'rounded' && finite(value.radius) && value.radius >= 0 && value.radius <= 0.5)
    return { shape: 'rounded', radius: value.radius }
  return null
}
export function parseSceneGuests(value: unknown): SceneGuests | null {
  if (
    !object(value) ||
    !sceneRegion(value.host) ||
    !sceneRegion(value.region) ||
    !Array.isArray(value.slots) ||
    value.slots.length > SCENE_MAX_GUEST_SLOTS ||
    !value.slots.every(sceneRegion)
  )
    return null
  const copy = ({ x, y, w, h }: SceneRect): SceneRect => ({ x, y, w, h })
  return {
    host: copy(value.host),
    region: copy(value.region),
    slots: (value.slots as SceneRect[]).map(copy)
  }
}
export function parseCloudScene(value: unknown): CloudScene | null {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}$/.test(value.id) ||
    !Array.isArray(value.items) ||
    value.items.length > 2
  )
    return null
  const guests = parseSceneGuests(value.guests)
  if (!guests) return null
  let background: SceneBackground | undefined
  if (value.background !== undefined) {
    const parsed = parseSceneBackground(value.background)
    if (!parsed) return null
    background = parsed
  }
  const items: SceneItem[] = []
  for (const item of value.items) {
    if (
      !object(item) ||
      (item.role !== 'host-camera' && item.role !== 'screen') ||
      items.some((other) => other.role === item.role) ||
      !sceneRect(item.rect) ||
      !sceneCrop(item.crop) ||
      (item.fit !== 'contain' && item.fit !== 'cover') ||
      typeof item.mirror !== 'boolean' ||
      !Number.isSafeInteger(item.z) ||
      Number(item.z) < 0 ||
      Number(item.z) > 16
    )
      return null
    const mask = sceneMask(item.mask)
    if (!mask) return null
    const { x, y, w, h } = item.rect
    const { l, t, r, b } = item.crop
    items.push({
      role: item.role,
      rect: { x, y, w, h },
      crop: { l, t, r, b },
      fit: item.fit,
      mirror: item.mirror,
      mask,
      z: item.z as number
    })
  }
  return { id: value.id, items, guests, ...(background ? { background } : {}) }
}
export function parseSceneCapability(value: unknown): SceneCapability | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    (value.output !== 'stream' && value.output !== 'recording') ||
    (value.orientation !== 'h' && value.orientation !== 'v')
  )
    return null
  let applied: SceneApplied | undefined
  if (value.applied !== undefined) {
    if (
      !object(value.applied) ||
      !sid(value.applied.publisherSid) ||
      !positive(value.applied.revision)
    )
      return null
    applied = { publisherSid: value.applied.publisherSid, revision: value.applied.revision }
  }
  let background: BackgroundCapability | undefined
  if (value.background !== undefined) {
    const parsed = parseBackgroundCapability(value.background)
    if (!parsed) return null
    background = parsed
  }
  return {
    version: 1,
    output: value.output,
    orientation: value.orientation,
    ...(applied ? { applied } : {}),
    ...(background ? { background } : {})
  }
}
export function parseSceneSnapshot(
  value: unknown,
  page: {
    show: string
    publisherSid: string
    output: SceneOutput
    orientation: SceneOrientation
    now: number
  }
): SceneSnapshot | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.show !== page.show ||
    !sid(value.publisherSid) ||
    value.publisherSid !== page.publisherSid ||
    !positive(value.revision) ||
    value.output !== page.output ||
    value.orientation !== page.orientation ||
    !positive(value.expiresAt) ||
    value.expiresAt <= page.now ||
    value.expiresAt > page.now + SCENE_LEASE_MS ||
    !object(value.transition) ||
    (value.transition.kind !== 'cut' && value.transition.kind !== 'motion') ||
    !Number.isSafeInteger(value.transition.durationMs) ||
    Number(value.transition.durationMs) < 0 ||
    Number(value.transition.durationMs) > SCENE_MOTION_MAX_MS ||
    (value.transition.kind === 'cut' && value.transition.durationMs !== 0) ||
    !positive(value.transition.applyAt)
  )
    return null
  let scene: CloudScene | null = null
  if (value.scene !== null) {
    scene = parseCloudScene(value.scene)
    if (!scene) return null
  }
  return {
    version: 1,
    show: page.show,
    publisherSid: page.publisherSid,
    revision: value.revision,
    output: page.output,
    orientation: page.orientation,
    expiresAt: value.expiresAt,
    scene,
    transition: {
      kind: value.transition.kind,
      durationMs: value.transition.durationMs as number,
      applyAt: value.transition.applyAt
    }
  }
}
/** Saved-scene extension. Unknown future versions are kept by the caller, never used. */
export function parseCloudSceneExtension(value: unknown): CloudSceneExtension | null {
  if (!object(value) || value.version !== SCENE_EXTENSION_VERSION) return null
  const guests = parseSceneGuests(value.guests)
  return guests ? { version: SCENE_EXTENSION_VERSION, guests } : null
}

/** FNV-1a 32, 8 hex: the same key the S6 stage uses. */
export function sceneKey(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
/** The content of a scene, without its id: equal content is one picture. */
export function sceneContentKey(
  scene: Pick<CloudScene, 'items' | 'guests' | 'background'> | null
): string {
  if (!scene) return 'none'
  // A scene without a background keeps its S12 key.
  return sceneKey(
    JSON.stringify(
      scene.background ? [scene.items, scene.guests, scene.background] : [scene.items, scene.guests]
    )
  )
}

/**
 * The stable guest layout for a scene saved before scenes had guest roles
 * (D7): landscape keeps the host scene large on the left with guests in a
 * column on the right, as the room's own screen-people layout; portrait keeps
 * it on top with guests in a band below.
 */
export function defaultSceneGuests(orientation: SceneOrientation): SceneGuests {
  return orientation === 'h'
    ? {
        host: { x: 0, y: 0.125, w: 0.75, h: 0.75 },
        region: { x: 0.75, y: 0, w: 0.25, h: 1 },
        slots: []
      }
    : { host: { x: 0.15, y: 0, w: 0.7, h: 0.7 }, region: { x: 0, y: 0.7, w: 1, h: 0.3 }, slots: [] }
}

export type ScenePixelRect = { x: number; y: number; w: number; h: number }
export type SceneCanvas = { width: number; height: number }

/** Like Rust `scene_source_rect_pixels`: rounded, at least one pixel a side. */
export function scenePixels(rect: SceneRect, canvas: SceneCanvas): ScenePixelRect {
  return {
    x: Math.round(rect.x * canvas.width),
    y: Math.round(rect.y * canvas.height),
    w: Math.max(1, Math.round(rect.w * canvas.width)),
    h: Math.max(1, Math.round(rect.h * canvas.height))
  }
}
/** `inner` (fractions of `outer`) placed into `outer` (fractions of the canvas). */
export function sceneWithin(outer: SceneRect, inner: SceneRect): SceneRect {
  return {
    x: outer.x + inner.x * outer.w,
    y: outer.y + inner.y * outer.h,
    w: inner.w * outer.w,
    h: inner.h * outer.h
  }
}

/**
 * Equal 16:9 cells for `count` guests in `region`, centred: the column count
 * that gives the largest tile wins, the fewer columns on a tie.
 */
export function sceneGuestCells(
  region: ScenePixelRect,
  count: number,
  gutter: number
): ScenePixelRect[] {
  if (count <= 0) return []
  let best = { cols: 1, w: 0, h: 0 }
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const cellW = (region.w - gutter * (cols + 1)) / cols
    const cellH = (region.h - gutter * (rows + 1)) / rows
    if (cellW <= 0 || cellH <= 0) continue
    const w = Math.min(cellW, (cellH * 16) / 9)
    if (w > best.w + 0.5) best = { cols, w, h: (w * 9) / 16 }
  }
  const even = (n: number): number => Math.max(2, Math.floor(n) & ~1)
  const w = even(best.w)
  const h = even(best.h)
  const cols = best.cols
  const rows = Math.ceil(count / cols)
  const blockH = rows * h + (rows - 1) * gutter
  const top = region.y + Math.floor((region.h - blockH) / 2)
  const cells: ScenePixelRect[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols)
    const inRow = row === rows - 1 ? count - row * cols : cols
    const rowW = inRow * w + (inRow - 1) * gutter
    const left = region.x + Math.floor((region.w - rowW) / 2)
    cells.push({ x: left + (i % cols) * (w + gutter), y: top + row * (h + gutter), w, h })
  }
  return cells
}

export type SceneTileMask =
  | { shape: 'rectangle' }
  | { shape: 'rounded'; radiusPx: number }
  | { shape: 'circle' }
export type SceneTile = {
  identity: string
  kind: 'person' | 'screen'
  /** `host-camera`, `screen`, or `guest:<n>` in stage order. */
  role: string
  /** The frame, in canvas pixels. */
  rect: ScenePixelRect
  crop: SceneCrop
  fit: SceneFit
  mirror: boolean
  mask: SceneTileMask
  z: number
}
export type SceneRoster = {
  host: string
  /** On-stage guests to draw, in stage order (at most six). */
  guests: readonly string[]
  /** Whose screen is up and fresh; null: none. */
  screen: string | null
  /** The host is on stage. */
  hostOnStage: boolean
}

const NO_CROP: SceneCrop = { l: 0, t: 0, r: 0, b: 0 }
function tileMask(mask: SceneMask, rect: ScenePixelRect): SceneTileMask {
  if (mask.shape === 'rounded')
    return { shape: 'rounded', radiusPx: Math.round(Math.min(rect.w, rect.h) * mask.radius) }
  return mask
}

/**
 * The tiles a scene draws on one canvas, low z first. The host's camera
 * appears only while the host is on stage; the screen box only while a
 * screen is up. Guests are never dropped: slots first, then the region.
 * Guest tiles cover, rounded like the room's stage (20 px at 1080 lines).
 */
export function planSceneTiles(
  scene: Pick<CloudScene, 'items' | 'guests'>,
  canvas: SceneCanvas,
  roster: SceneRoster
): SceneTile[] {
  const guests = roster.guests.slice(0, SCENE_MAX_GUEST_SLOTS)
  const area: SceneRect = guests.length > 0 ? scene.guests.host : { x: 0, y: 0, w: 1, h: 1 }
  const tiles: SceneTile[] = []
  for (const item of scene.items) {
    if (item.role === 'host-camera' && !roster.hostOnStage) continue
    if (item.role === 'screen' && roster.screen === null) continue
    const rect = scenePixels(sceneWithin(area, item.rect), canvas)
    tiles.push({
      identity: item.role === 'screen' ? (roster.screen as string) : roster.host,
      kind: item.role === 'screen' ? 'screen' : 'person',
      role: item.role,
      rect,
      crop: { ...item.crop },
      fit: item.fit,
      mirror: item.mirror,
      mask: tileMask(item.mask, rect),
      z: item.z
    })
  }
  const short = Math.min(canvas.width, canvas.height)
  const gutter = Math.max(4, Math.round((short * 24) / 1080) & ~1)
  const radius = Math.round((short * 20) / 1080)
  const explicit = Math.min(guests.length, scene.guests.slots.length)
  const cells = sceneGuestCells(
    scenePixels(scene.guests.region, canvas),
    guests.length - explicit,
    gutter
  )
  guests.forEach((identity, index) => {
    const slot = index < explicit ? scene.guests.slots[index] : undefined
    const rect = slot ? scenePixels(slot, canvas) : cells[index - explicit]
    if (!rect) return
    tiles.push({
      identity,
      kind: 'person',
      role: `guest:${index}`,
      rect,
      crop: { ...NO_CROP },
      fit: 'cover',
      mirror: false,
      mask: { shape: 'rounded', radiusPx: radius },
      z: 32 + index
    })
  })
  return tiles.sort((a, b) => a.z - b.z)
}

/**
 * Where a picture of `source` pixels lands in its frame after its crop and
 * fit, and the box the whole uncropped source occupies so that the crop
 * lands there. `clip` is what shows: the frame for cover, the picture for
 * contain. Same arithmetic as `scene-picture-geometry.ts` / Rust `source_fit`.
 */
export function scenePicture(
  frame: ScenePixelRect,
  source: { w: number; h: number },
  crop: SceneCrop,
  fit: SceneFit
): { clip: ScenePixelRect; full: ScenePixelRect } {
  const keepW = Math.max(0.05, 1 - crop.l - crop.r)
  const keepH = Math.max(0.05, 1 - crop.t - crop.b)
  const pictureW = Math.max(1, source.w * keepW)
  const pictureH = Math.max(1, source.h * keepH)
  const scale =
    fit === 'cover'
      ? Math.max(frame.w / pictureW, frame.h / pictureH)
      : Math.min(frame.w / pictureW, frame.h / pictureH)
  const w = pictureW * scale
  const h = pictureH * scale
  const picture = { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h }
  const fullW = w / keepW
  const fullH = h / keepH
  const full = {
    x: Math.round(picture.x - crop.l * fullW),
    y: Math.round(picture.y - crop.t * fullH),
    w: Math.round(fullW),
    h: Math.round(fullH)
  }
  const x0 = Math.max(frame.x, picture.x)
  const y0 = Math.max(frame.y, picture.y)
  const x1 = Math.min(frame.x + frame.w, picture.x + w)
  const y1 = Math.min(frame.y + frame.h, picture.y + h)
  const clip = {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.max(1, Math.round(x1 - x0)),
    h: Math.max(1, Math.round(y1 - y0))
  }
  return { clip, full }
}

/** Rust `ease_in_out_cubic`: soft start, soft landing, no overshoot. */
export function sceneEase(t: number): number {
  const p = Math.min(1, Math.max(0, t))
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
}
/** Transition progress 0..1 at wall time `now`; a cut is always 1. */
export function sceneProgress(transition: SceneTransition, now: number): number {
  if (transition.kind === 'cut' || transition.durationMs <= 0) return 1
  return Math.min(1, Math.max(0, (now - transition.applyAt) / transition.durationMs))
}
/** Rust `synthetic_enter_from`: a box with no predecessor grows from 92%. */
export function sceneEnterFrom(to: ScenePixelRect): ScenePixelRect {
  const w = to.w * SCENE_ENTER_SCALE
  const h = to.h * SCENE_ENTER_SCALE
  return { x: to.x + (to.w - w) / 2, y: to.y + (to.h - h) / 2, w, h }
}
/**
 * Rust `scene_with_transition` for one box: eased position, size and crop.
 * The motion family is `identity|kind` (camera glides to camera, a screen to
 * the screen); a box with no predecessor grows in, a box that left is gone.
 */
export function sceneMotion(
  from: { rect: ScenePixelRect; crop: SceneCrop } | null,
  to: { rect: ScenePixelRect; crop: SceneCrop },
  linearProgress: number
): { rect: ScenePixelRect; crop: SceneCrop } {
  const p = sceneEase(linearProgress)
  if (p >= 1) return { rect: { ...to.rect }, crop: { ...to.crop } }
  const start = from ?? { rect: sceneEnterFrom(to.rect), crop: to.crop }
  const lerp = (a: number, b: number): number => a + (b - a) * p
  return {
    rect: {
      x: lerp(start.rect.x, to.rect.x),
      y: lerp(start.rect.y, to.rect.y),
      w: lerp(start.rect.w, to.rect.w),
      h: lerp(start.rect.h, to.rect.h)
    },
    crop: {
      l: lerp(start.crop.l, to.crop.l),
      t: lerp(start.crop.t, to.crop.t),
      r: lerp(start.crop.r, to.crop.r),
      b: lerp(start.crop.b, to.crop.b)
    }
  }
}

/**
 * Latest revision wins; clear (a null scene) outranks everything older. The
 * page calls `rendered` once the scene's frame is drawn; only then is the
 * revision applied. Owner change, lease expiry and clear drop the scene.
 */
export class SceneReceiver {
  #owner: string | null = null
  #wanted = 0
  #current: SceneSnapshot | null = null
  #applied: SceneApplied | undefined
  readonly #deps: { show(snapshot: SceneSnapshot | null): void; now(): number }
  /** No parameter property: Node's type stripping loads this module as is. */
  constructor(deps: { show(snapshot: SceneSnapshot | null): void; now(): number }) {
    this.#deps = deps
  }
  get applied(): SceneApplied | undefined {
    return this.#applied
  }
  get current(): SceneSnapshot | null {
    return this.#current
  }
  owner(sid: string | null): void {
    if (this.#owner === sid) return
    this.#owner = sid
    this.#wanted = 0
    this.#drop()
  }
  #drop(): void {
    const had = this.#current !== null
    this.#current = null
    this.#applied = undefined
    if (had) this.#deps.show(null)
  }
  step(): void {
    if (this.#current && this.#deps.now() >= this.#current.expiresAt) this.#drop()
  }
  accept(snapshot: SceneSnapshot): boolean {
    if (snapshot.publisherSid !== this.#owner || snapshot.revision <= this.#wanted) return false
    if (snapshot.expiresAt <= this.#deps.now()) return false
    this.#wanted = snapshot.revision
    this.#applied = undefined
    this.#current = snapshot
    this.#deps.show(snapshot)
    return true
  }
  /** The frame for `revision` is drawn. */
  rendered(revision: number): void {
    const current = this.#current
    if (!current || current.revision !== revision || this.#deps.now() >= current.expiresAt) return
    this.#applied = { publisherSid: current.publisherSid, revision }
  }
}
