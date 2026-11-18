/**
 * Plan 249 S14. The scene background on the cloud program: a picture or a
 * live (shader) background behind the scene's sources, like the native
 * compositor draws it. Mirrored in the program client (web
 * `lib/cloud/program/cloud-background.ts`) and pinned on both sides by
 * `protocol-fixtures/cloud-parity-background.json`.
 *
 * The background rides in S12's scene as an optional `background` field (old
 * pages ignore it and keep their plain ground). A picture names an immutable
 * asset by SHA-256; its bytes travel once per consumer on
 * `BACKGROUND_ASSET_TOPIC`, targeted to authorized program egress consumers
 * only (never guests), bounded and hash-checked before use. A live background
 * carries no pixels: the page runs the same GLSL ES 3.00 shaders the Electron
 * previews run (`live-background-webgl.js` with the backend's generated render
 * JSON, byte-mirrored) on one shared phase clock, so every lane shows the
 * same frame at the same time. Nothing here claims a static poster is
 * animation parity: a page that cannot run the shader says why.
 *
 * Native semantics mirrored (crates/videorc-backend/src):
 * - Picture: `background_zoom_crop` (scale 100..200 with offsets) and fit
 *   (`fit` = contain, `fill`/`stretch` = cover), drawn over black.
 * - Live: full canvas, Dim = `dimPercent / 100` clamped to 0..0.8
 *   (`live_background/runtime.rs`), drawn over the React Bits base colour.
 * - The stage margin (visibility) is already in S12's item rects.
 *
 * Pure: no DOM, no clock reads, no backend types.
 */
export const BACKGROUND_ASSET_TOPIC = 'videorc.presentation.background-asset.v1'
/** Bytes of one encoded picture (WebP/JPEG/PNG), header excluded. */
export const BACKGROUND_ASSET_MAX_BYTES = 2 * 1024 * 1024
export const BACKGROUND_ASSET_HEADER_MAX = 1024
/** Assets a page keeps: the current one and the one being replaced. */
export const BACKGROUND_ASSET_CACHE = 2
/** React Bits' studio stage behind the transparent live looks (`looks::BASE_COLOR`). */
export const LIVE_BACKGROUND_BASE_RGB = [5, 5, 6] as const
export const LIVE_BACKGROUND_FPS = 30
export const CLOUD_BACKGROUND_PRODUCTION_QUALIFIED = false

export {
  BACKGROUND_ASSET_MAX_SIDE,
  BACKGROUND_DIM_MAX,
  BACKGROUND_STILL_REASONS,
  LIVE_BACKGROUND_IDS,
  isBackgroundHash,
  isBackgroundMime,
  isLiveBackgroundId,
  parseBackgroundCapability,
  parseSceneBackground,
  type BackgroundCapability,
  type BackgroundCrop,
  type BackgroundDrawn,
  type BackgroundMime,
  type BackgroundRendering,
  type BackgroundStillReason,
  type LiveBackground,
  type LiveBackgroundWireId,
  type PictureBackground,
  type SceneBackground
} from './cloud-scene'
import {
  BACKGROUND_ASSET_MAX_SIDE,
  BACKGROUND_DIM_MAX,
  isBackgroundHash,
  isBackgroundMime,
  type BackgroundCrop,
  type BackgroundMime,
  type LiveBackground,
  type SceneBackground
} from './cloud-scene'

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const dimension = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= BACKGROUND_ASSET_MAX_SIDE
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** FNV-1a 32, 8 hex (the S6/S12 key). */
function fnv(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
/** What a page reports drawing; equal backgrounds share a key. */
export function backgroundKey(background: SceneBackground | null | undefined): string {
  return background ? fnv(JSON.stringify(background)) : 'none'
}

/** Rust `scene_geometry::background_zoom_crop`. */
export function backgroundZoomCrop(
  scale: number,
  offsetX: number,
  offsetY: number
): BackgroundCrop {
  const s = clamp(finite(scale) ? scale : 100, 100, 200)
  if (s <= 100) return { l: 0, t: 0, r: 0, b: 0 }
  const total = 1 - 100 / s
  const x = (clamp(finite(offsetX) ? offsetX : 0, -100, 100) / 200) * total
  const y = (clamp(finite(offsetY) ? offsetY : 0, -100, 100) / 200) * total
  return {
    l: clamp(total / 2 + x, 0, 0.95),
    t: clamp(total / 2 + y, 0, 0.95),
    r: clamp(total / 2 - x, 0, 0.95),
    b: clamp(total / 2 - y, 0, 0.95)
  }
}
/** Native fit: only `fit` keeps the whole picture; `fill` and `stretch` cover. */
export function backgroundFit(fit: string): 'contain' | 'cover' {
  return fit === 'fit' ? 'contain' : 'cover'
}
/** `live_background/runtime.rs`: `(dim_percent / 100).clamp(0, 0.8)`. */
export function liveBackgroundDim(dimPercent: number): number {
  return clamp((finite(dimPercent) ? dimPercent : 0) / 100, 0, BACKGROUND_DIM_MAX)
}
/** The shader phase at wall time `now` (ms); never runs backwards before the anchor. */
export function liveBackgroundPhase(clock: LiveBackground['clock'], now: number): number {
  return clock.anchorPhase + clock.rate * Math.max(0, (now - clock.anchorAt) / 1000)
}
/**
 * The next clock for `next`, continuing `previous` without a jump (the
 * clock.rs rule): the same background keeps its phase and changes only its
 * rate; another background starts again at its poster phase.
 */
export function nextLiveClock(
  previous: { id: string; clock: LiveBackground['clock'] } | null,
  next: { id: string; rate: number; posterPhase: number },
  now: number
): LiveBackground['clock'] {
  if (previous && previous.id === next.id) {
    if (previous.clock.rate === next.rate) return { ...previous.clock }
    return { anchorAt: now, anchorPhase: liveBackgroundPhase(previous.clock, now), rate: next.rate }
  }
  return { anchorAt: now, anchorPhase: next.posterPhase, rate: next.rate }
}

export type BackgroundAssetHeader = {
  version: 1
  show: string
  publisherSid: string
  hash: string
  mime: BackgroundMime
  width: number
  height: number
  size: number
}

/** One message: u32 big-endian header length, the UTF-8 JSON header, the encoded picture. */
export function encodeBackgroundAsset(
  header: BackgroundAssetHeader,
  image: Uint8Array
): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(JSON.stringify(header))
  if (head.length > BACKGROUND_ASSET_HEADER_MAX) throw new Error('Background header too large')
  if (image.length !== header.size || image.length > BACKGROUND_ASSET_MAX_BYTES)
    throw new Error('Background asset too large')
  const out = new Uint8Array(4 + head.length + image.length)
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  out.set(image, 4 + head.length)
  return out
}

/**
 * The asset in one message, or null. The page still checks the SHA-256 of
 * `image` against `header.hash` before decoding it.
 */
export function decodeBackgroundAsset(
  bytes: Uint8Array,
  page: { show: string; publisherSid: string }
): { header: BackgroundAssetHeader; image: Uint8Array } | null {
  if (
    bytes.length < 5 ||
    bytes.length > 4 + BACKGROUND_ASSET_HEADER_MAX + BACKGROUND_ASSET_MAX_BYTES
  )
    return null
  const headLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (headLength < 2 || headLength > BACKGROUND_ASSET_HEADER_MAX || 4 + headLength > bytes.length)
    return null
  let raw: unknown
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + headLength))
    )
  } catch {
    return null
  }
  const image = bytes.subarray(4 + headLength)
  if (
    !object(raw) ||
    raw.version !== 1 ||
    raw.show !== page.show ||
    raw.publisherSid !== page.publisherSid ||
    !isBackgroundHash(raw.hash) ||
    !isBackgroundMime(raw.mime) ||
    !dimension(raw.width) ||
    !dimension(raw.height) ||
    raw.size !== image.length ||
    image.length < 1 ||
    image.length > BACKGROUND_ASSET_MAX_BYTES
  )
    return null
  return {
    header: {
      version: 1,
      show: raw.show,
      publisherSid: raw.publisherSid,
      hash: raw.hash,
      mime: raw.mime,
      width: raw.width,
      height: raw.height,
      size: image.length
    },
    image
  }
}

/** Lowercase hex of a digest. */
export function hexOf(digest: ArrayBuffer | Uint8Array): string {
  const bytes = digest instanceof Uint8Array ? digest : new Uint8Array(digest)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * The page's verified pictures by hash, newest last, at most
 * `BACKGROUND_ASSET_CACHE`. An owner change empties it.
 */
export class BackgroundAssetCache<T> {
  #owner: string | null = null
  #items: { hash: string; value: T }[] = []
  readonly #release: (value: T) => void
  /** No parameter property: Node's type stripping loads this module as is. */
  constructor(release: (value: T) => void = () => {}) {
    this.#release = release
  }
  owner(sid: string | null): void {
    if (this.#owner === sid) return
    this.#owner = sid
    for (const item of this.#items.splice(0)) this.#release(item.value)
  }
  get(hash: string): T | undefined {
    return this.#items.find((item) => item.hash === hash)?.value
  }
  has(hash: string): boolean {
    return this.#items.some((item) => item.hash === hash)
  }
  /** Keep `value` for `hash`; `keep` (the hash on the program) is never evicted. */
  put(hash: string, value: T, keep?: string): void {
    const old = this.#items.findIndex((item) => item.hash === hash)
    if (old >= 0) this.#release(this.#items.splice(old, 1)[0]!.value)
    this.#items.push({ hash, value })
    while (this.#items.length > BACKGROUND_ASSET_CACHE) {
      const index = this.#items.findIndex((item) => item.hash !== keep && item.hash !== hash)
      if (index < 0) break
      this.#release(this.#items.splice(index, 1)[0]!.value)
    }
  }
  get size(): number {
    return this.#items.length
  }
}
