/** Plan 249 S4. Public pixels only. Mirrored verbatim in the program client.
 * This extends S3 capabilities; it is not a second negotiation protocol. */
export const AVATAR_TOPIC = 'videorc.presentation.avatar.v1'
export const AVATAR_MAX_BYTES = 512 * 1024
export const AVATAR_LEASE_MS = 30_000
export type AvatarOutput = 'stream' | 'recording'
export type AvatarOrientation = 'h' | 'v'
export type AvatarRect = { x: number; y: number; w: number; h: number }
export type AvatarApplied = { publisherSid: string; revision: number }
export type AvatarCapability = {
  version: 1
  output: AvatarOutput
  orientation: AvatarOrientation
  applied?: AvatarApplied
}
export type AvatarLayer = {
  kind: 'avatar' | 'bubble'
  rect: AvatarRect
  /** Immutable PNG content, no URL, local path, persona or private text. */
  asset: { hash: string; png: string; width: number; height: number }
  expiresAt: number | null
}
export type AvatarSnapshot = {
  version: 1
  show: string
  publisherSid: string
  revision: number
  output: AvatarOutput
  orientation: AvatarOrientation
  expiresAt: number
  layers: AvatarLayer[]
}
const sid = (v: unknown): v is string => typeof v === 'string' && /^PA_[A-Za-z0-9]{1,64}$/.test(v)
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function parseAvatarCapability(value: unknown): AvatarCapability | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    !['stream', 'recording'].includes(String(value.output)) ||
    !['h', 'v'].includes(String(value.orientation))
  )
    return null
  let applied: AvatarApplied | undefined
  if (value.applied !== undefined) {
    if (
      !object(value.applied) ||
      !sid(value.applied.publisherSid) ||
      !positive(value.applied.revision)
    )
      return null
    applied = { publisherSid: value.applied.publisherSid, revision: value.applied.revision }
  }
  return {
    version: 1,
    output: value.output as AvatarOutput,
    orientation: value.orientation as AvatarOrientation,
    ...(applied ? { applied } : {})
  }
}
export function avatarRect(value: unknown): value is AvatarRect {
  if (!object(value)) return false
  const { x, y, w, h } = value
  return (
    [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Number(x) >= 0 &&
    Number(y) >= 0 &&
    Number(w) > 0 &&
    Number(h) > 0 &&
    Number(x) + Number(w) <= 1.00001 &&
    Number(y) + Number(h) <= 1.00001
  )
}
/** PNG header is checked before decoding, bounding decompressed allocation. */
export function avatarPng(
  png: string,
  width: number,
  height: number
): Uint8Array<ArrayBuffer> | null {
  if (
    png.length > 256 * 1024 ||
    png.length < 44 ||
    png.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(png)
  )
    return null
  let raw: string
  try {
    raw = atob(png)
  } catch {
    return null
  }
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0))
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return null
  const view = new DataView(bytes.buffer)
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height ||
    width < 1 ||
    height < 1 ||
    width > 1024 ||
    height > 1024 ||
    width * height > 1024 * 1024
  )
    return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const kind = view.getUint32(offset + 4)
    if (
      length > bytes.length - offset - 12 ||
      kind === 0x6163544c ||
      kind === 0x6663544c ||
      kind === 0x66644154
    )
      return null // APNG is not a static bounded raster
    offset += length + 12
    if (kind === 0x49454e44) return offset === bytes.length && length === 0 ? bytes : null
  }
  return null
}
export async function avatarHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
    n.toString(16).padStart(2, '0')
  ).join('')
}
export function parseAvatarSnapshot(
  value: unknown,
  page: {
    show: string
    publisherSid: string
    output: AvatarOutput
    orientation: AvatarOrientation
    now: number
  }
): AvatarSnapshot | null {
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
    value.expiresAt > page.now + AVATAR_LEASE_MS ||
    !Array.isArray(value.layers) ||
    value.layers.length > 2
  )
    return null
  const layers: AvatarLayer[] = []
  for (const layer of value.layers) {
    if (
      !object(layer) ||
      !['avatar', 'bubble'].includes(String(layer.kind)) ||
      layers.some((l) => l.kind === layer.kind) ||
      !avatarRect(layer.rect) ||
      !object(layer.asset) ||
      typeof layer.asset.png !== 'string' ||
      typeof layer.asset.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(layer.asset.hash) ||
      !positive(layer.asset.width) ||
      !positive(layer.asset.height) ||
      !avatarPng(layer.asset.png, layer.asset.width, layer.asset.height) ||
      (layer.expiresAt !== null &&
        (!positive(layer.expiresAt) || layer.expiresAt > value.expiresAt)) ||
      (layer.kind === 'bubble' && layer.expiresAt === null)
    )
      return null
    const { x, y, w, h } = layer.rect
    const { png, hash, width, height } = layer.asset
    layers.push({
      kind: layer.kind as AvatarLayer['kind'],
      rect: { x, y, w, h },
      asset: { png, hash, width, height },
      expiresAt: layer.expiresAt as number | null
    })
  }
  layers.sort((a, b) => Number(a.kind === 'bubble') - Number(b.kind === 'bubble'))
  return {
    version: 1,
    show: page.show,
    publisherSid: page.publisherSid,
    revision: value.revision,
    output: page.output,
    orientation: page.orientation,
    expiresAt: value.expiresAt,
    layers
  }
}

/** Latest revision wins even while assets decode; clear outranks older work.
 * One pending decode batch, two retained images, no unbounded asset cache. */
export class AvatarReceiver<T> {
  #owner: string | null = null
  #wanted = 0
  #generation = 0
  #busy = false
  #applied: AvatarApplied | undefined
  #expiresAt = 0
  constructor(
    private readonly deps: {
      prepare(layer: AvatarLayer): Promise<T>
      discard(asset: T): void
      commit(snapshot: AvatarSnapshot, assets: T[]): void | Promise<void>
      clear(): void
      now(): number
    }
  ) {}
  get applied(): AvatarApplied | undefined {
    return this.#applied
  }
  owner(sid: string | null): void {
    if (this.#owner === sid) return
    this.#owner = sid
    this.#wanted = 0
    this.clear()
  }
  clear(): void {
    this.#generation++
    this.#applied = undefined
    this.#expiresAt = 0
    this.deps.clear()
  }
  step(): void {
    if (this.#expiresAt && this.deps.now() >= this.#expiresAt) this.clear()
  }
  async accept(snapshot: AvatarSnapshot): Promise<boolean> {
    if (snapshot.publisherSid !== this.#owner || snapshot.revision <= this.#wanted) return false
    this.#wanted = snapshot.revision
    const generation = ++this.#generation
    // A clear always applies immediately, even with a decode in flight.
    if (!snapshot.layers.length) {
      this.clear()
      const clearGeneration = this.#generation
      this.#expiresAt = snapshot.expiresAt
      try {
        await this.deps.commit(snapshot, [])
      } catch (error) {
        if (clearGeneration === this.#generation) this.clear()
        throw error
      }
      if (clearGeneration !== this.#generation || snapshot.expiresAt <= this.deps.now())
        return false
      this.#applied = { publisherSid: snapshot.publisherSid, revision: snapshot.revision }
      return true
    }
    if (this.#busy) return false // producer retries a fresh revision, never queues bytes
    this.#busy = true
    const prepared: T[] = []
    try {
      for (const layer of snapshot.layers) {
        if (
          (await avatarHash(avatarPng(layer.asset.png, layer.asset.width, layer.asset.height)!)) !==
          layer.asset.hash
        )
          throw new Error('Avatar asset hash mismatch')
        if (generation !== this.#generation) return false
        prepared.push(await this.deps.prepare(layer))
      }
      if (generation !== this.#generation || snapshot.expiresAt <= this.deps.now()) return false
      this.#applied = undefined
      this.#expiresAt = snapshot.expiresAt
      const painting = this.deps.commit(snapshot, prepared.splice(0))
      await painting
      if (generation !== this.#generation || snapshot.expiresAt <= this.deps.now()) return false
      this.#expiresAt = snapshot.expiresAt
      this.#applied = { publisherSid: snapshot.publisherSid, revision: snapshot.revision }
      return true
    } catch (error) {
      if (generation === this.#generation) this.clear()
      throw error
    } finally {
      for (const asset of prepared) this.deps.discard(asset)
      this.#busy = false
    }
  }
}
