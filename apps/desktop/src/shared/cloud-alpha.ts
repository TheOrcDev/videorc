/** S10 experimental transport only. Neither media-v2 nor graphics consent enables it. */
export const ALPHA_PRODUCTION_ENABLED = false
export const ALPHA_EXPERIMENT = 'local-packed-alpha-v1'
export const ALPHA_ROLE = 'videorc:experimental:packed-alpha:v1'
export const ALPHA_LIMITS = Object.freeze({
  width: 640,
  height: 640,
  pixels: 640 * 360,
  fps: 30,
  gutter: 8,
  publications: 2,
  leaseMs: 30_000,
  queue: 1,
  alphaTolerance: 16,
  colorTolerance: 24
})
export type AlphaRect = { x: number; y: number; w: number; h: number }
export type AlphaLane = { output: 'stream' | 'recording'; orientation: 'h' | 'v' }
export type AlphaManifest = AlphaLane & {
  version: 1
  show: string
  publisherSid: string
  trackSid: string
  epoch: string
  generation: number
  expiresAt: number
  width: number
  height: number
  fps: number
  rect: AlphaRect
  role: typeof ALPHA_ROLE
  source: 'camera'
  packing: 'rgb-left-alpha-right'
}
/** Supplied by an authenticated controller/fixture after inspecting SFU publications.
 * Never derive it from a track name, room metadata or publisher data alone. */
export type AlphaAuthority = AlphaLane & {
  experiment: typeof ALPHA_EXPERIMENT
  show: string
  hostIdentity: string
  publisherSid: string
  trackSid: string
  epoch: string
  generation: number
  source: 'camera'
  canPublishSources: readonly string[]
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const sid = (v: unknown, prefix: string): v is string =>
  typeof v === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,96}$`).test(v)
export function alphaDimensions(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 64 &&
    height >= 64 &&
    width % 2 === 0 &&
    height % 2 === 0 &&
    width <= ALPHA_LIMITS.width &&
    height <= ALPHA_LIMITS.height &&
    width * height <= ALPHA_LIMITS.pixels
  )
}
export function parseAlphaManifest(
  value: unknown,
  a: AlphaAuthority,
  now: number
): AlphaManifest | null {
  if (
    !object(value) ||
    !object(value.rect) ||
    !Number.isFinite(now) ||
    a.experiment !== ALPHA_EXPERIMENT ||
    a.hostIdentity !== `host:${a.show}` ||
    !a.canPublishSources.includes('camera') ||
    a.source !== 'camera' ||
    value.version !== 1 ||
    value.role !== ALPHA_ROLE ||
    value.source !== 'camera' ||
    value.packing !== 'rgb-left-alpha-right' ||
    value.show !== a.show ||
    value.publisherSid !== a.publisherSid ||
    !sid(value.publisherSid, 'PA') ||
    value.trackSid !== a.trackSid ||
    !sid(value.trackSid, 'TR') ||
    value.epoch !== a.epoch ||
    typeof value.epoch !== 'string' ||
    value.epoch.length > 96 ||
    !value.epoch ||
    value.generation !== a.generation ||
    !Number.isSafeInteger(value.generation) ||
    a.generation < 1 ||
    value.output !== a.output ||
    value.orientation !== a.orientation ||
    !['stream', 'recording'].includes(a.output) ||
    !['h', 'v'].includes(a.orientation) ||
    typeof value.width !== 'number' ||
    typeof value.height !== 'number' ||
    !alphaDimensions(value.width, value.height) ||
    value.fps !== ALPHA_LIMITS.fps ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + ALPHA_LIMITS.leaseMs
  )
    return null
  const r = value.rect
  if (
    ![r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    (r.x as number) < 0 ||
    (r.y as number) < 0 ||
    (r.w as number) <= 0 ||
    (r.h as number) <= 0 ||
    (r.x as number) + (r.w as number) > 1 ||
    (r.y as number) + (r.h as number) > 1
  )
    return null
  return {
    version: 1,
    role: ALPHA_ROLE,
    source: 'camera',
    packing: 'rgb-left-alpha-right',
    show: a.show,
    publisherSid: a.publisherSid,
    trackSid: a.trackSid,
    epoch: a.epoch,
    generation: a.generation,
    output: a.output,
    orientation: a.orientation,
    width: value.width,
    height: value.height,
    fps: value.fps,
    expiresAt: value.expiresAt,
    rect: { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number }
  }
}
export function packedSize(width: number, height: number) {
  if (!alphaDimensions(width, height)) throw new Error('alpha dimensions refused')
  return { width: width * 2 + ALPHA_LIMITS.gutter, height }
}
/** Pixel-center sampling stays out of the gutter and codec edge bleed. */
export function packedUv(x: number, y: number, width: number, height: number, mask: boolean) {
  const size = packedSize(width, height)
  return {
    u:
      (Math.max(0, Math.min(width - 1, x)) + 0.5 + (mask ? width + ALPHA_LIMITS.gutter : 0)) /
      size.width,
    v: (Math.max(0, Math.min(height - 1, y)) + 0.5) / height
  }
}
export function blendPixel(rgb: readonly number[], alpha: number, background: readonly number[]) {
  const a = Math.max(0, Math.min(255, alpha)) / 255
  return [0, 1, 2].map((i) => Math.round((rgb[i] ?? 0) * a + (background[i] ?? 0) * (1 - a)))
}
export const ALPHA_PATCHES = [
  { x: 0.125, y: 0.125, rgba: [255, 0, 255, 255] },
  { x: 0.375, y: 0.125, rgba: [0, 255, 0, 128] },
  { x: 0.625, y: 0.125, rgba: [0, 0, 0, 0] }
] as const
export function stampBits(now: number): number[] {
  const n = Math.floor(now) % 0x1000000
  const check = ((n >>> 16) ^ (n >>> 8) ^ n) & 255
  return Array.from({ length: 32 }, (_, i) => (i < 24 ? (n >>> i) & 1 : (check >>> (i - 24)) & 1))
}
export function stampLatency(samples: readonly number[], now: number): number | null {
  if (samples.length !== 32 || samples.some((v) => !Number.isFinite(v) || (v > 96 && v < 160)))
    return null
  let n = 0,
    check = 0
  for (let i = 0; i < 32; i++)
    if (samples[i]! >= 160) {
      if (i < 24) n |= 1 << i
      else check |= 1 << (i - 24)
    }
  if ((((n >>> 16) ^ (n >>> 8) ^ n) & 255) !== check) return null
  const latency = (Math.floor(now) - n + 0x1000000) % 0x1000000
  return latency <= 60_000 ? latency : null
}
