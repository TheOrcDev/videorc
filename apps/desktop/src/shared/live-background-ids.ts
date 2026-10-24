// Live backgrounds (plan 190): the ids and defaults the eager bundle needs.
// Names, looks and thumbnails live in the lazy Assets chunk
// (renderer/src/lib/live-backgrounds.ts); the backend owns the shaders and the
// catalogue (crates/videorc-backend/src/live_background/), and the generated
// `live-backgrounds.catalog.generated.json` pins both to it.

export const LIVE_BACKGROUND_IDS = [
  'silk',
  'side-rays',
  'plasma-wave',
  'liquid-chrome',
  'line-waves'
] as const

export type LiveBackgroundId = (typeof LIVE_BACKGROUND_IDS)[number]

/** Calm runs at half the React Bits speed (plan 190 D5). */
export type LiveBackgroundMotion = 'calm' | 'normal'

/** Each background's first look, applied by a click on its tile. */
export const LIVE_BACKGROUND_DEFAULT_LOOKS: Readonly<Record<LiveBackgroundId, string>> = {
  silk: 'satin',
  'side-rays': 'sunbeam',
  'plasma-wave': 'plasma',
  'liquid-chrome': 'polished',
  'line-waves': 'silk'
}

const LOOK_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export function isLiveBackgroundId(value: unknown): value is LiveBackgroundId {
  return typeof value === 'string' && (LIVE_BACKGROUND_IDS as readonly string[]).includes(value)
}

export function isLiveBackgroundLook(value: unknown): value is string {
  return typeof value === 'string' && LOOK_PATTERN.test(value)
}

/** The bundled poster's managed asset id (`live-<id>-<look>`). */
export function livePosterAssetId(id: LiveBackgroundId, look: string): string {
  return `live-${id}-${look}`
}

/** The poster's file in the bundled backgrounds folder. */
export function livePosterFileName(id: LiveBackgroundId, look: string): string {
  return `${livePosterAssetId(id, look)}.webp`
}

/** Splits a poster asset id back into its background and look, or null. */
export function parseLivePosterAssetId(
  assetId: string
): { id: LiveBackgroundId; look: string } | null {
  if (!assetId.startsWith('live-')) return null
  const rest = assetId.slice('live-'.length)
  const id = LIVE_BACKGROUND_IDS.find((candidate) => rest.startsWith(`${candidate}-`))
  if (!id) return null
  const look = rest.slice(id.length + 1)
  return isLiveBackgroundLook(look) ? { id, look } : null
}
