import { APP_ICONS_MAX_IDS } from '../shared/app-icons'

/** Session cache, including misses and in-flight lookups. Only main owns this. */
export function createAppIconHandler(options: {
  platform: string
  pathForBundleId: (id: string) => string | null
  pngForPath: (path: string) => Promise<string>
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
            pending = Promise.resolve().then(async () => {
              try {
                const path = options.pathForBundleId(id)
                if (!path) return null
                const png = await options.pngForPath(path)
                return png.startsWith('data:image/png;base64,') ? png : null
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
