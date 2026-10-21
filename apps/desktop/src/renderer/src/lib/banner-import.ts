import type { TakeoverImportPhase } from '@/lib/takeover-import'

// Assets → Banners → Import image… (plan 186 S5). The picker and the import
// follow the takeover lifecycle (plan 182): one at a time, quiet on a cancel,
// and a late answer from a retired connection changes nothing. Takeovers now
// import a batch; a banner is still one image per pick. Eager (the Studio
// provider owns it), so the words and rules live in `lib/banners.ts`.

export type BannerImportPhase = TakeoverImportPhase

export type BannerImporter = ReturnType<typeof createBannerImporter>

/**
 * One banner picker and import at a time. Its own instance, so a banner
 * import never waits on a takeover's picker; the backend's one AssetImport
 * lane still runs them one after the other.
 */
export function createBannerImporter() {
  let operation: object | null = null
  return {
    reset() {
      operation = null
    },
    async run<Selection, Banner>(options: {
      pick: () => Promise<Selection | null>
      importImage: (selection: Selection) => Promise<Banner>
      isCurrent: () => boolean
      onPhase: (phase: BannerImportPhase) => void
      onImported: (banner: Banner) => void
      onError: (error: unknown) => void
    }): Promise<void> {
      if (operation) return
      const token = {}
      operation = token
      const current = () => operation === token && options.isCurrent()
      options.onPhase('choosing')
      try {
        const selection = await options.pick()
        if (!selection || !current()) return
        options.onPhase('importing')
        const banner = await options.importImage(selection)
        if (current()) options.onImported(banner)
      } catch (error) {
        if (current()) options.onError(error)
      } finally {
        if (operation === token) {
          operation = null
          options.onPhase('idle')
        }
      }
    }
  }
}
