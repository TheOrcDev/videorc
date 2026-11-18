// Plan 249 S11: sandboxed HTML banners reach the cloud room as one packed
// colour+alpha "sheet" per orientation, over S10's transport
// (docs/cloud/249-s11-contract.md). Disabled: S10 is not
// qualified, so the web never offers it (`HTML_LAYER_PRODUCTION_QUALIFIED`).
// Mirrors web `lib/cloud/program/html-layer.ts`; both
// parse `protocol-fixtures/cloud-html-layer.json` identically.

import { alphaDimensions, ALPHA_LIMITS } from './cloud-alpha'

/** No environment variable or page option can turn this on. */
export const HTML_LAYER_PRODUCTION_QUALIFIED = false
export const HTML_LAYER_ROLE = 'videorc:html-layer:v1'
export const HTML_LAYER_TOPIC = 'videorc.presentation.html.v1'
export const HTML_LAYER_LIMITS = Object.freeze({
  layers: 4,
  publications: 2,
  fps: 15,
  leaseMs: 30_000,
  renewMs: 10_000,
  manifestBytes: 16 * 1024,
  bitrate: 2_500_000
})
/** The whole stage at S10's logical limits; layers are rects on it. */
export const HTML_LAYER_SHEET = Object.freeze({
  h: Object.freeze({ width: 640, height: 360 }),
  v: Object.freeze({ width: 360, height: 640 })
})

export type HtmlLayerOutput = 'stream' | 'recording'
export type HtmlLayerOrientation = 'h' | 'v'
export type HtmlLayerRect = { x: number; y: number; w: number; h: number }
export type HtmlLayerEntry = { id: string; rect: HtmlLayerRect }
export type HtmlLayerApplied = {
  publisherSid: string
  trackSid: string
  generation: number
  revision: number
}
export type HtmlLayerCapability = {
  version: 1
  output: HtmlLayerOutput
  orientation: HtmlLayerOrientation
  applied?: HtmlLayerApplied
}
export type HtmlLayerManifest = {
  version: 1
  role: typeof HTML_LAYER_ROLE
  show: string
  publisherSid: string
  trackSid: string
  generation: number
  controllerEpoch: number
  revision: number
  output: HtmlLayerOutput
  orientation: HtmlLayerOrientation
  width: number
  height: number
  fps: number
  packing: 'rgb-left-alpha-right'
  expiresAt: number
  layers: HtmlLayerEntry[]
}
/** What the page reads from the SFU about the sheet's publication. */
export type HtmlLayerFacts = {
  /** The current SID of `host:<show>`, or null when the host is not in. */
  hostSid: string | null
  /** The host's publication with the manifest's track SID, if any. */
  publication: { trackSid: string; trackName: string; source: string } | null
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const sid = (v: unknown, prefix: 'PA' | 'TR'): v is string =>
  typeof v === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{1,64}$`).test(v)
const lane = (o: unknown, r: unknown): boolean =>
  (o === 'stream' || o === 'recording') && (r === 'h' || r === 'v')
const count = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min

export function htmlLayerTrackName(orientation: HtmlLayerOrientation, generation: number): string {
  return `${HTML_LAYER_ROLE}:${orientation}:${generation}`
}

/**
 * A sheet publication, by name. Only ever used to exclude it from camera
 * readers: a name alone never authorizes drawing it.
 */
export function isHtmlLayerTrackName(name: string | undefined | null): boolean {
  return typeof name === 'string' && name.startsWith(`${HTML_LAYER_ROLE}:`)
}

export function parseHtmlLayerRect(v: unknown): HtmlLayerRect | null {
  if (!object(v)) return null
  const { x, y, w, h } = v
  if (
    ![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    (x as number) < 0 ||
    (y as number) < 0 ||
    (w as number) <= 0 ||
    (h as number) <= 0 ||
    (x as number) + (w as number) > 1 + 1e-9 ||
    (y as number) + (h as number) > 1 + 1e-9
  )
    return null
  return { x: x as number, y: y as number, w: w as number, h: h as number }
}

export function parseHtmlLayerCapability(v: unknown): HtmlLayerCapability | null {
  if (!object(v) || v.version !== 1 || !lane(v.output, v.orientation)) return null
  const capability: HtmlLayerCapability = {
    version: 1,
    output: v.output as HtmlLayerOutput,
    orientation: v.orientation as HtmlLayerOrientation
  }
  if (v.applied === undefined) return capability
  const a = v.applied
  if (
    !object(a) ||
    !sid(a.publisherSid, 'PA') ||
    !sid(a.trackSid, 'TR') ||
    !count(a.generation, 1) ||
    !count(a.revision, 1)
  )
    return null
  return {
    ...capability,
    applied: {
      publisherSid: a.publisherSid,
      trackSid: a.trackSid,
      generation: a.generation,
      revision: a.revision
    }
  }
}

/**
 * The manifest's own shape, for the page's lane, with a current lease. Its
 * authority still needs `htmlLayerAuthorized` against SFU facts.
 */
export function parseHtmlLayerManifest(
  v: unknown,
  page: {
    show: string
    output: HtmlLayerOutput
    orientation: HtmlLayerOrientation
    now: number
  }
): HtmlLayerManifest | null {
  if (
    !object(v) ||
    v.version !== 1 ||
    v.role !== HTML_LAYER_ROLE ||
    v.packing !== 'rgb-left-alpha-right' ||
    v.show !== page.show ||
    v.output !== page.output ||
    v.orientation !== page.orientation ||
    !sid(v.publisherSid, 'PA') ||
    !sid(v.trackSid, 'TR') ||
    !count(v.generation, 1) ||
    !count(v.controllerEpoch, 0) ||
    !count(v.revision, 1) ||
    !count(v.fps, 1) ||
    v.fps > HTML_LAYER_LIMITS.fps ||
    v.fps > ALPHA_LIMITS.fps ||
    !Number.isFinite(page.now) ||
    typeof v.expiresAt !== 'number' ||
    !Number.isFinite(v.expiresAt) ||
    v.expiresAt <= page.now ||
    v.expiresAt > page.now + HTML_LAYER_LIMITS.leaseMs ||
    !Array.isArray(v.layers) ||
    v.layers.length > HTML_LAYER_LIMITS.layers
  )
    return null
  const sheet = HTML_LAYER_SHEET[page.orientation]
  if (
    v.width !== sheet.width ||
    v.height !== sheet.height ||
    !alphaDimensions(sheet.width, sheet.height)
  )
    return null
  const layers: HtmlLayerEntry[] = []
  const ids = new Set<string>()
  for (const raw of v.layers) {
    if (
      !object(raw) ||
      typeof raw.id !== 'string' ||
      !/^banner:[A-Za-z0-9_-]{1,64}$/.test(raw.id) ||
      ids.has(raw.id)
    )
      return null
    const rect = parseHtmlLayerRect(raw.rect)
    if (!rect) return null
    ids.add(raw.id)
    layers.push({ id: raw.id, rect })
  }
  return {
    version: 1,
    role: HTML_LAYER_ROLE,
    show: page.show,
    publisherSid: v.publisherSid,
    trackSid: v.trackSid,
    generation: v.generation,
    controllerEpoch: v.controllerEpoch,
    revision: v.revision,
    output: page.output,
    orientation: page.orientation,
    width: sheet.width,
    height: sheet.height,
    fps: v.fps,
    packing: 'rgb-left-alpha-right',
    expiresAt: v.expiresAt,
    layers
  }
}

/** SFU facts decide; the manifest's words and the track name never do. */
export function htmlLayerAuthorized(manifest: HtmlLayerManifest, facts: HtmlLayerFacts): boolean {
  return (
    facts.hostSid !== null &&
    facts.hostSid === manifest.publisherSid &&
    facts.publication !== null &&
    facts.publication.trackSid === manifest.trackSid &&
    facts.publication.source === 'camera' &&
    facts.publication.trackName === htmlLayerTrackName(manifest.orientation, manifest.generation)
  )
}

/**
 * Whether `next` may renew the consumer `current` holds: only the revision,
 * lease and layers may change. Anything else needs a new consumer.
 */
export function htmlLayerSameSource(current: HtmlLayerManifest, next: HtmlLayerManifest): boolean {
  return (
    current.show === next.show &&
    current.publisherSid === next.publisherSid &&
    current.trackSid === next.trackSid &&
    current.generation === next.generation &&
    current.controllerEpoch === next.controllerEpoch &&
    current.output === next.output &&
    current.orientation === next.orientation &&
    next.revision >= current.revision
  )
}

/** A layer's rect in sheet pixels, snapped outward to whole pixels. */
export function htmlLayerPixels(
  rect: HtmlLayerRect,
  sheet: { width: number; height: number }
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.floor(rect.x * sheet.width))
  const y = Math.max(0, Math.floor(rect.y * sheet.height))
  const right = Math.min(sheet.width, Math.ceil((rect.x + rect.w) * sheet.width))
  const bottom = Math.min(sheet.height, Math.ceil((rect.y + rect.h) * sheet.height))
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}
