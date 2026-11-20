/** S9 static presentation. Pixels only; S3/S4 remain the capability authority. */
import {
  avatarHash,
  avatarRect,
  base64Bytes,
  withHeldPng,
  type AvatarApplied,
  type AvatarRect
} from './cloud-avatar'
export const GRAPHICS_TOPIC = 'videorc.presentation.static.v1'
export const GRAPHICS_MAX_BYTES = 6 * 1024 * 1024
export const GRAPHICS_LEASE_MS = 30_000
export const GRAPHICS_ASSET_BYTES = 1024 * 1024
export const GRAPHICS_MAX_LAYERS = 7 // four banners, caption, curated chat, highlight
export type GraphicsKind = 'banner' | 'caption' | 'chat' | 'highlight'
export type GraphicsAsset = { png: string; hash: string; width: number; height: number }
export type GraphicsLayer = {
  id: string
  kind: GraphicsKind
  rect: AvatarRect
  asset: GraphicsAsset
  opacity: number
  /** Native banner ease-out cubic; absolute time prevents replay on late join. */
  fade: { at: number; from: number; to: number } | null
  expiresAt: number | null
}
export type GraphicsContent = {
  h: (GraphicsLayer & {
    stream: boolean
    recording: boolean
    outputRects?: { stream: AvatarRect; recording: AvatarRect }
  })[]
  v: (GraphicsLayer & {
    stream: boolean
    recording: boolean
    outputRects?: { stream: AvatarRect; recording: AvatarRect }
  })[]
  unsupported: string[]
  /**
   * Plan 249 S11: HTML banners' placement on the room canvases (no pixels:
   * the HTML layer sheet carries them, default-off). At most four a lane.
   */
  html?: { h: HtmlBannerPlacement[]; v: HtmlBannerPlacement[] }
}
/** Plan 249 S11: one HTML banner on a room canvas. */
export type HtmlBannerPlacement = {
  /** `banner:<bannerId>`, the sheet layer id. */
  id: string
  /** The banner's own id: its frames are read by this. */
  bannerId: string
  rect: AvatarRect
  opacity: number
  fade: { at: number; from: number; to: number } | null
  stream: boolean
  recording: boolean
}
export type GraphicsSnapshot = {
  version: 1
  show: string
  publisherSid: string
  revision: number
  output: 'stream' | 'recording'
  orientation: 'h' | 'v'
  expiresAt: number
  layers: GraphicsLayer[]
}
export { parseStaticCapability, type StaticCapability } from './cloud-avatar'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const unit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
/** Validate PNG dimensions and static chunks before the browser allocates a bitmap. */
export function graphicsPng(asset: GraphicsAsset): Uint8Array<ArrayBuffer> | null {
  const { png, width, height } = asset
  if (
    typeof png !== 'string' ||
    png.length > GRAPHICS_ASSET_BYTES ||
    png.length < 44 ||
    png.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(png) ||
    !positive(width) ||
    !positive(height) ||
    width > 1920 ||
    height > 1920 ||
    width * height > 1920 * 1080
  )
    return null
  const bytes = base64Bytes(png)
  if (
    !bytes ||
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    return null
  const view = new DataView(bytes.buffer)
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height
  )
    return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset),
      kind = view.getUint32(offset + 4)
    if (size > bytes.length - offset - 12 || [0x6163544c, 0x6663544c, 0x66644154].includes(kind))
      return null
    offset += size + 12
    if (kind === 0x49454e44) return size === 0 && offset === bytes.length ? bytes : null
  }
  return null
}
/**
 * PH-05, PH-06: the pictures `graphicsPng` passed last, by hash, newest last.
 * A caption update re-sends every layer, and each unchanged banner was decoded
 * and walked again by every parse, page send and apply. A hit needs the very
 * same base64 and size, so it can only repeat an answer already given; a miss
 * checks as before. Bounded in count and in base64 held.
 */
const checked = new Map<string, GraphicsAsset>()
let checkedLength = 0
const CHECKED_MAX = 4 * GRAPHICS_MAX_LAYERS
const CHECKED_LENGTH_MAX = 2 * GRAPHICS_MAX_BYTES
/** Whether `asset` passes `graphicsPng`; one it passed before is not decoded again. */
export function graphicsPngChecked(asset: GraphicsAsset): boolean {
  const seen = checked.get(asset.hash)
  if (
    seen &&
    seen.png === asset.png &&
    seen.width === asset.width &&
    seen.height === asset.height
  ) {
    checked.delete(asset.hash)
    checked.set(asset.hash, seen)
    return true
  }
  if (!graphicsPng(asset)) return false
  if (seen) checkedLength -= seen.png.length
  checked.delete(asset.hash)
  const { png, hash, width, height } = asset
  checked.set(hash, { png, hash, width, height })
  checkedLength += png.length
  for (const [oldest, old] of checked) {
    if (checked.size <= CHECKED_MAX && checkedLength <= CHECKED_LENGTH_MAX) break
    checked.delete(oldest)
    checkedLength -= old.png.length
  }
  return true
}
/** Whether two assets are the very same picture: hash, size and base64. */
export function sameGraphicsAsset(a: GraphicsAsset, b: GraphicsAsset): boolean {
  return a.hash === b.hash && a.width === b.width && a.height === b.height && a.png === b.png
}
export function graphicsOpacity(layer: GraphicsLayer, now: number): number {
  if (layer.expiresAt !== null && layer.expiresAt <= now) return 0
  if (!layer.fade) return layer.opacity
  const t = Math.max(0, Math.min(1, (now - layer.fade.at) / 200))
  return layer.opacity * (layer.fade.from + (layer.fade.to - layer.fade.from) * (1 - (1 - t) ** 3))
}
export function parseGraphicsSnapshot(
  value: unknown,
  page: Pick<GraphicsSnapshot, 'show' | 'publisherSid' | 'output' | 'orientation'> & {
    now: number
    /**
     * PERF-06: the asset this page holds for a hash, for an asset sent as a
     * reference (no `png`). Absent, or no asset held: such a snapshot is refused.
     */
    resolve?: (hash: string) => GraphicsAsset | undefined
  }
): GraphicsSnapshot | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.show !== page.show ||
    value.publisherSid !== page.publisherSid ||
    !/^PA_[A-Za-z0-9]{1,64}$/.test(page.publisherSid) ||
    value.output !== page.output ||
    value.orientation !== page.orientation ||
    !positive(value.revision) ||
    !positive(value.expiresAt) ||
    value.expiresAt <= page.now ||
    value.expiresAt > page.now + GRAPHICS_LEASE_MS ||
    !Array.isArray(value.layers) ||
    value.layers.length > GRAPHICS_MAX_LAYERS
  )
    return null
  const layers: GraphicsLayer[] = []
  let bytes = 0
  for (const input of value.layers) {
    const l = withHeldPng(input, page.resolve)
    if (
      !object(l) ||
      typeof l.id !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,100}$/.test(l.id) ||
      layers.some((x) => x.id === l.id) ||
      !['banner', 'caption', 'chat', 'highlight'].includes(String(l.kind)) ||
      !avatarRect(l.rect) ||
      !unit(l.opacity) ||
      !object(l.asset) ||
      typeof l.asset.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(l.asset.hash)
    )
      return null
    const asset = l.asset as GraphicsAsset
    if (!graphicsPngChecked(asset)) return null
    bytes += asset.png.length
    if (bytes > GRAPHICS_MAX_BYTES - 4096) return null
    if (l.expiresAt !== null && (!positive(l.expiresAt) || l.expiresAt > value.expiresAt))
      return null
    if (
      l.fade !== null &&
      (!object(l.fade) ||
        !positive(l.fade.at) ||
        l.fade.at > page.now + 1000 ||
        !unit(l.fade.from) ||
        !unit(l.fade.to) ||
        l.kind !== 'banner')
    )
      return null
    if ((l.kind === 'highlight' || l.kind === 'caption') && l.expiresAt === null) return null
    if (l.kind !== 'banner' && layers.some((x) => x.kind === l.kind)) return null
    const { x, y, w, h } = l.rect
    layers.push({
      id: l.id,
      kind: l.kind as GraphicsKind,
      rect: { x, y, w, h },
      asset: { png: asset.png, hash: asset.hash, width: asset.width, height: asset.height },
      opacity: l.opacity,
      expiresAt: l.expiresAt as number | null,
      fade:
        l.fade === null
          ? null
          : {
              at: (l.fade as GraphicsLayer['fade'])!.at,
              from: (l.fade as GraphicsLayer['fade'])!.from,
              to: (l.fade as GraphicsLayer['fade'])!.to
            }
    })
  }
  if (layers.filter((l) => l.kind === 'banner').length > 4) return null
  return {
    version: 1,
    show: page.show,
    publisherSid: page.publisherSid,
    output: page.output,
    orientation: page.orientation,
    revision: value.revision,
    expiresAt: value.expiresAt,
    layers
  }
}
/**
 * PERF-06: whether `next` only renews `current`'s lease: the same layers, in
 * order, with the same placement, opacity, fade and the very same pixels (hash
 * and base64), differing at most in `expiresAt`.
 */
function graphicsRenewal(current: GraphicsLayer[], next: GraphicsLayer[]): boolean {
  return (
    current.length === next.length &&
    current.every((a, i) => {
      const b = next[i]!
      return (
        a.id === b.id &&
        a.kind === b.kind &&
        a.rect.x === b.rect.x &&
        a.rect.y === b.rect.y &&
        a.rect.w === b.rect.w &&
        a.rect.h === b.rect.h &&
        a.opacity === b.opacity &&
        a.fade?.at === b.fade?.at &&
        a.fade?.from === b.fade?.from &&
        a.fade?.to === b.fade?.to &&
        sameGraphicsAsset(a.asset, b.asset)
      )
    })
  )
}
/** Latest snapshot wins, with a bounded decode batch and independent clear. */
export class GraphicsReceiver<T> {
  #owner: string | null = null
  #revision = 0
  #generation = 0
  #busy = false
  /** PERF-06: the snapshot `applied` names (null exactly when it is undefined). */
  #current: GraphicsSnapshot | null = null
  /**
   * PERF-06: the last snapshot committed, whose pictures a reference may name.
   * Unlike `#current` it survives a newer apply in flight; only a clear drops it.
   */
  #held: GraphicsSnapshot | null = null
  #pending: {
    snapshot: GraphicsSnapshot
    generation: number
    resolve(value: boolean): void
    reject(error: unknown): void
  } | null = null
  #expires = 0
  applied: AvatarApplied | undefined
  constructor(
    private deps: {
      now(): number
      /** `bytes`: the layer's PNG, decoded and hashed once here. */
      prepare(layer: GraphicsLayer, bytes: Uint8Array<ArrayBuffer>): Promise<T>
      discard(asset: T): void
      commit(s: GraphicsSnapshot, assets: T[]): Promise<void>
      clear(): void
      retain?(ids: ReadonlySet<string>): void
      /**
       * PH-06: the prepared asset of a layer the view shows right now with
       * these very pixels (same id, kind, hash, size and base64). `commit`
       * gets it in place of a new one: no hash, no decode, no new element.
       * It stays the view's; the receiver never discards it. Absent, or
       * `undefined`: the layer is prepared.
       */
      kept?(layer: GraphicsLayer): T | undefined
      /**
       * PERF-06: a lease renewal of what is on screen (same pixels, same
       * placement): update layer expiries in place. Absent: renewals take
       * the full prepare/commit path.
       */
      renew?(s: GraphicsSnapshot): void
    }
  ) {}
  /** PERF-06: the asset this page holds for a hash (the applied snapshot's), for references. */
  asset(hash: string): GraphicsAsset | undefined {
    return this.#held?.layers.find((l) => l.asset.hash === hash)?.asset
  }
  owner(owner: string | null): void {
    if (owner !== this.#owner) {
      this.#owner = owner
      this.#revision = 0
      this.clear()
    }
  }
  clear(): void {
    this.#generation++
    this.#pending?.resolve(false)
    this.#pending = null
    this.applied = undefined
    this.#current = null
    this.#held = null
    this.#expires = 0
    this.deps.clear()
  }
  step(): void {
    if (this.#expires && this.#expires <= this.deps.now()) this.clear()
  }
  async accept(s: GraphicsSnapshot): Promise<boolean> {
    if (s.publisherSid !== this.#owner || s.revision <= this.#revision) return false
    // PERF-06: a renewal of what is on screen (nothing expired yet) only moves
    // the lease: no hash, decode or DOM rebuild.
    const current = this.#current
    const now = this.deps.now()
    if (
      this.deps.renew &&
      current &&
      !this.#busy &&
      s.layers.length &&
      s.expiresAt > now &&
      current.layers.every((l) => l.expiresAt === null || l.expiresAt > now) &&
      graphicsRenewal(current.layers, s.layers)
    ) {
      this.#revision = s.revision
      this.#generation++
      this.#expires = s.expiresAt
      this.deps.renew(s)
      this.#current = this.#held = s
      this.applied = { publisherSid: s.publisherSid, revision: s.revision }
      return true
    }
    this.applied = undefined
    this.#current = null
    this.deps.retain?.(new Set(s.layers.map((l) => l.id)))
    this.#revision = s.revision
    const gen = ++this.#generation
    this.#pending?.resolve(false)
    this.#pending = null
    if (s.layers.length && this.#busy)
      return new Promise<boolean>((resolve, reject) => {
        this.#pending = { snapshot: s, generation: gen, resolve, reject }
      })
    return this.#apply(s, gen)
  }
  async #apply(s: GraphicsSnapshot, gen: number): Promise<boolean> {
    if (s.layers.length) this.#busy = true
    // Prepared here, and this apply's to discard until `commit` takes them.
    // A kept asset is the view's and is never in this map.
    const fresh = new Map<GraphicsLayer, T>()
    try {
      let assets: T[]
      for (;;) {
        // PH-06: one changed layer (a caption line) used to hash, decode and
        // rebuild every layer. A picture the view shows now is kept instead.
        // The view can drop one while this waits (its expiry passed), so the
        // kept ones are looked up again after every wait: nothing runs
        // between the last lookup and `commit`.
        assets = []
        let next: GraphicsLayer | undefined
        for (const l of s.layers) {
          if (fresh.has(l)) {
            assets.push(fresh.get(l)!)
            continue
          }
          const kept = this.deps.kept?.(l)
          if (kept === undefined || assets.includes(kept)) {
            next = l
            break
          }
          assets.push(kept)
        }
        if (!next) break
        const bytes = graphicsPng(next.asset)
        if (!bytes || (await avatarHash(bytes)) !== next.asset.hash)
          throw Error('Graphic hash mismatch')
        if (gen !== this.#generation) return false
        fresh.set(next, await this.deps.prepare(next, bytes))
      }
      if (gen !== this.#generation || s.expiresAt <= this.deps.now()) return false
      this.applied = undefined
      this.#current = null
      this.#expires = s.expiresAt
      fresh.clear()
      await this.deps.commit(s, assets)
      if (gen === this.#generation) this.#held = s
      if (gen !== this.#generation || s.expiresAt <= this.deps.now()) return false
      this.applied = { publisherSid: s.publisherSid, revision: s.revision }
      this.#current = this.#held = s
      return true
    } catch (error) {
      if (gen === this.#generation) this.clear()
      throw error
    } finally {
      fresh.forEach((a) => this.deps.discard(a))
      if (s.layers.length) {
        this.#busy = false
        const next = this.#pending
        this.#pending = null
        if (next) void this.#apply(next.snapshot, next.generation).then(next.resolve, next.reject)
      }
    }
  }
}

export type GraphicsSource = { signature: string; content: GraphicsContent | null }
export function parseGraphicsSource(
  value: unknown,
  /**
   * PH-05: the picture the reader holds for a hash, for a layer the backend
   * answered by reference (no `png`). Absent, or none held: refused.
   */
  resolve?: (hash: string) => GraphicsAsset | undefined
): GraphicsSource | null {
  if (
    !object(value) ||
    typeof value.signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.signature)
  )
    return null
  if (value.content === null) return { signature: value.signature, content: null }
  const raw = value.content
  if (
    !object(raw) ||
    !Array.isArray(raw.unsupported) ||
    raw.unsupported.length > 4 ||
    raw.unsupported.some((s) => typeof s !== 'string' || s.length > 160)
  )
    return null
  const content: GraphicsContent = { h: [], v: [], unsupported: raw.unsupported as string[] }
  const now = Date.now()
  for (const orientation of ['h', 'v'] as const) {
    if (!Array.isArray(raw[orientation])) return null
    const input = raw[orientation] as unknown[]
    if (
      input.some(
        (l) =>
          !object(l) ||
          typeof l.stream !== 'boolean' ||
          typeof l.recording !== 'boolean' ||
          (l.outputRects !== undefined &&
            (l.kind !== 'caption' ||
              !object(l.outputRects) ||
              !avatarRect(l.outputRects.stream) ||
              !avatarRect(l.outputRects.recording)))
      )
    )
      return null
    const page = {
      show: 'local',
      publisherSid: 'PA_local',
      output: 'stream' as const,
      orientation,
      now,
      ...(resolve ? { resolve } : {})
    }
    const snapshot = parseGraphicsSnapshot(
      { ...page, version: 1, revision: 1, expiresAt: now + GRAPHICS_LEASE_MS, layers: input },
      page
    )
    if (!snapshot) return null
    content[orientation] = snapshot.layers.map((l, i) => ({
      ...l,
      ...((input[i] as Record<string, unknown>).outputRects
        ? {
            outputRects: (() => {
              const r = (input[i] as { outputRects: { stream: AvatarRect; recording: AvatarRect } })
                .outputRects
              const clean = ({ x, y, w, h }: AvatarRect) => ({ x, y, w, h })
              return { stream: clean(r.stream), recording: clean(r.recording) }
            })()
          }
        : {}),
      stream: (input[i] as Record<string, unknown>).stream === true,
      recording: (input[i] as Record<string, unknown>).recording === true
    }))
  }
  if (raw.html !== undefined) {
    const html = parseHtmlBannerPlacements(raw.html)
    if (!html) return null
    content.html = html
  }
  return { signature: value.signature, content }
}

/**
 * PH-05: the pictures of the last two `cloud.graphics.snapshot` answers this
 * window read, by hash. With live captions on, every caption update is a full
 * answer; each one carried every banner, the chat box and the card again as
 * base64, although only the caption bar had changed. The room's poll names
 * the hashes of the last answer (`graphicsSourceHeld`), the backend answers
 * those layers without their `png`, and the answer is completed from here.
 * Two answers, not one: a poll that was still in flight when the room's
 * effect restarted may be read after a newer one.
 */
let sourceHeld = new Map<string, GraphicsAsset>()
let sourceHeldBefore = new Map<string, GraphicsAsset>()
/** The `held` of the next `cloud.graphics.snapshot`: what the last answer carried. */
export function graphicsSourceHeld(): string[] {
  return [...sourceHeld.keys()]
}
/** The room closed, or an answer could not be read: the next answer comes whole. */
export function forgetGraphicsSource(): void {
  sourceHeld = new Map()
  sourceHeldBefore = new Map()
}
/** Reads a `cloud.graphics.snapshot` answer, completing layers sent by reference. */
export function readGraphicsSource(value: unknown): GraphicsSource | null {
  const source = parseGraphicsSource(
    value,
    (hash) => sourceHeld.get(hash) ?? sourceHeldBefore.get(hash)
  )
  if (source?.content) {
    sourceHeldBefore = sourceHeld
    sourceHeld = new Map(
      [...source.content.h, ...source.content.v].map((layer) => [layer.asset.hash, layer.asset])
    )
  }
  return source
}

const unitNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
/** Plan 249 S11: at most four HTML banners a lane, each a bounded rect. */
export function parseHtmlBannerPlacements(
  value: unknown
): { h: HtmlBannerPlacement[]; v: HtmlBannerPlacement[] } | null {
  if (!object(value)) return null
  const out: { h: HtmlBannerPlacement[]; v: HtmlBannerPlacement[] } = { h: [], v: [] }
  for (const orientation of ['h', 'v'] as const) {
    const lane = value[orientation]
    if (!Array.isArray(lane) || lane.length > 4) return null
    for (const l of lane as unknown[]) {
      if (
        !object(l) ||
        typeof l.bannerId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(l.bannerId) ||
        l.id !== `banner:${l.bannerId}` ||
        !avatarRect(l.rect) ||
        !unitNumber(l.opacity) ||
        typeof l.stream !== 'boolean' ||
        typeof l.recording !== 'boolean'
      )
        return null
      const f = l.fade
      if (
        f !== null &&
        (!object(f) ||
          typeof f.at !== 'number' ||
          !Number.isSafeInteger(f.at) ||
          !unitNumber(f.from) ||
          !unitNumber(f.to))
      )
        return null
      const { x, y, w, h } = l.rect as AvatarRect
      out[orientation].push({
        id: l.id,
        bannerId: l.bannerId,
        rect: { x, y, w, h },
        opacity: l.opacity,
        fade:
          f === null ? null : { at: f.at as number, from: f.from as number, to: f.to as number },
        stream: l.stream,
        recording: l.recording
      })
    }
  }
  return out
}
