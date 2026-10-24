// Live backgrounds (plan 190): the ids and defaults the eager bundle needs.
// Names, looks and thumbnails live in the lazy Assets chunk
// (renderer/src/lib/live-backgrounds.ts); the backend owns the shaders and the
// catalogue (crates/videorc-backend/src/live_background/), and the generated
// `live-backgrounds.catalog.generated.json` pins both to it.

/** Each live background with its first look, which a click on its tile applies. */
export const LIVE_BACKGROUND_DEFAULT_LOOKS = {
  silk: 'satin',
  'side-rays': 'sunbeam',
  'plasma-wave': 'plasma',
  'liquid-chrome': 'polished',
  'line-waves': 'silk'
} as const

export type LiveBackgroundId = keyof typeof LIVE_BACKGROUND_DEFAULT_LOOKS

export const LIVE_BACKGROUND_IDS = Object.keys(LIVE_BACKGROUND_DEFAULT_LOOKS) as LiveBackgroundId[]

/** Calm runs at half the React Bits speed (plan 190 D5). */
export type LiveBackgroundMotion = 'calm' | 'normal'

const POSTER_ID = new RegExp(`^live-(${LIVE_BACKGROUND_IDS.join('|')})-([a-z][a-z0-9-]{0,31})$`)

export function isLiveBackgroundId(value: unknown): value is LiveBackgroundId {
  return LIVE_BACKGROUND_IDS.includes(value as LiveBackgroundId)
}

/** A well-formed look id (the backend draws the first look for an unknown one). */
export function isLiveBackgroundLook(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)
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
  const match = POSTER_ID.exec(assetId)
  return match ? { id: match[1] as LiveBackgroundId, look: match[2] } : null
}
