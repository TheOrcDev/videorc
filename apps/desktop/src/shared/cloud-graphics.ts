/** S9 static presentation. Pixels only; S3/S4 remain the capability authority. */
import { avatarHash, avatarRect, type AvatarApplied, type AvatarRect } from './cloud-avatar'
export const GRAPHICS_TOPIC = 'videorc.presentation.static.v1'
export const GRAPHICS_MAX_BYTES = 6 * 1024 * 1024
export const GRAPHICS_LEASE_MS = 30_000
export const GRAPHICS_ASSET_BYTES = 1024 * 1024
export const GRAPHICS_MAX_LAYERS = 6 // four banners, curated chat, highlight
export type GraphicsKind = 'banner' | 'chat' | 'highlight'
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
  h: (GraphicsLayer & { stream: boolean; recording: boolean })[]
  v: (GraphicsLayer & { stream: boolean; recording: boolean })[]
  unsupported: string[]
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
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
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
export function graphicsOpacity(layer: GraphicsLayer, now: number): number {
  if (layer.expiresAt !== null && layer.expiresAt <= now) return 0
  if (!layer.fade) return layer.opacity
  const t = Math.max(0, Math.min(1, (now - layer.fade.at) / 200))
  return layer.opacity * (layer.fade.from + (layer.fade.to - layer.fade.from) * (1 - (1 - t) ** 3))
}
export function parseGraphicsSnapshot(
  value: unknown,
  page: Pick<GraphicsSnapshot, 'show' | 'publisherSid' | 'output' | 'orientation'> & { now: number }
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
  for (const l of value.layers) {
    if (
      !object(l) ||
      typeof l.id !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,100}$/.test(l.id) ||
      layers.some((x) => x.id === l.id) ||
      !['banner', 'chat', 'highlight'].includes(String(l.kind)) ||
      !avatarRect(l.rect) ||
      !unit(l.opacity) ||
      !object(l.asset) ||
      typeof l.asset.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(l.asset.hash)
    )
      return null
    const asset = l.asset as GraphicsAsset
    if (!graphicsPng(asset)) return null
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
    if (l.kind === 'highlight' && l.expiresAt === null) return null
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
/** Latest snapshot wins, with a bounded decode batch and independent clear. */
export class GraphicsReceiver<T> {
  #owner: string | null = null
  #revision = 0
  #generation = 0
  #busy = false
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
      prepare(layer: GraphicsLayer): Promise<T>
      discard(asset: T): void
      commit(s: GraphicsSnapshot, assets: T[]): Promise<void>
      clear(): void
    }
  ) {}
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
    this.#expires = 0
    this.deps.clear()
  }
  step(): void {
    if (this.#expires && this.#expires <= this.deps.now()) this.clear()
  }
  async accept(s: GraphicsSnapshot): Promise<boolean> {
    if (s.publisherSid !== this.#owner || s.revision <= this.#revision) return false
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
    const assets: T[] = []
    try {
      for (const l of s.layers) {
        if ((await avatarHash(graphicsPng(l.asset)!)) !== l.asset.hash)
          throw Error('Graphic hash mismatch')
        if (gen !== this.#generation) return false
        assets.push(await this.deps.prepare(l))
      }
      if (gen !== this.#generation || s.expiresAt <= this.deps.now()) return false
      this.applied = undefined
      this.#expires = s.expiresAt
      await this.deps.commit(s, assets.splice(0))
      if (gen !== this.#generation || s.expiresAt <= this.deps.now()) return false
      this.applied = { publisherSid: s.publisherSid, revision: s.revision }
      return true
    } catch (error) {
      if (gen === this.#generation) this.clear()
      throw error
    } finally {
      assets.forEach((a) => this.deps.discard(a))
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
export function parseGraphicsSource(value: unknown): GraphicsSource | null {
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
        (l) => !object(l) || typeof l.stream !== 'boolean' || typeof l.recording !== 'boolean'
      )
    )
      return null
    const page = {
      show: 'local',
      publisherSid: 'PA_local',
      output: 'stream' as const,
      orientation,
      now
    }
    const snapshot = parseGraphicsSnapshot(
      { ...page, version: 1, revision: 1, expiresAt: now + GRAPHICS_LEASE_MS, layers: input },
      page
    )
    if (!snapshot) return null
    content[orientation] = snapshot.layers.map((l, i) => ({
      ...l,
      stream: (input[i] as Record<string, unknown>).stream === true,
      recording: (input[i] as Record<string, unknown>).recording === true
    }))
  }
  return { signature: value.signature, content }
}
