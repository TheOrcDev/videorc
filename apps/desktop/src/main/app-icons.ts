import { APP_ICONS_MAX_IDS } from '../shared/app-icons'

/** Icons are drawn at this many pixels a side: crisp at `size-10` on a Retina display. */
export const APP_ICON_PIXELS = 128

/**
 * Session cache, including misses and in-flight lookups. Only main owns this.
 * `pngForBundleId` must render on the main thread (the native addon): Electron's
 * `app.getFileIcon` rasterises on a thread-pool worker and AppKit traps there on
 * macOS 26, killing main (plan 210 S4 crash). It is never used here.
 */
export function createAppIconHandler(options: {
  platform: string
  pngForBundleId: (id: string, pixels: number) => Uint8Array | null | undefined
}): (ids: unknown) => Promise<Record<string, string>> {
  const cache = new Map<string, Promise<string | null>>()
  return async (ids) => {
    if (options.platform !== 'darwin' || !Array.isArray(ids)) return {}
    const entries = await Promise.all(
      [...new Set(ids.slice(0, APP_ICONS_MAX_IDS))]
        .filter(
          (id): id is string =>
            typeof id === 'string' && /^[\w-]+(?:\.[\w-]+)+$/.test(id) && id.length <= 512
        )
        .map(async (id) => {
          let pending = cache.get(id)
          if (!pending) {
            pending = Promise.resolve().then(() => {
              try {
                const png = options.pngForBundleId(id, APP_ICON_PIXELS)
                if (!png || png.byteLength === 0) return null
                return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
              } catch {
                return null
              }
            })
            cache.set(id, pending)
          }
          return [id, await pending] as const
        })
    )
    return Object.fromEntries(entries.filter((entry) => entry[1] !== null)) as Record<
      string,
      string
    >
  }
}
