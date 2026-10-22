import { createTakeoverImporter, type TakeoverImportPhase } from '@/lib/takeover-import'

// Assets → Banners → Import image… (plan 186 S5). The picker and the import
// follow the takeover lifecycle (plan 182): one at a time, quiet on a cancel,
// and a late answer from a retired connection changes nothing. Eager (the
// Studio provider owns it), so the words and rules live in `lib/banners.ts`.

export type BannerImportPhase = TakeoverImportPhase

export type BannerImporter = ReturnType<typeof createTakeoverImporter>

/**
 * One banner picker and import at a time. Its own instance, so a banner
 * import never waits on a takeover's picker; the backend's one AssetImport
 * lane still runs them one after the other.
 */
export function createBannerImporter(): BannerImporter {
  return createTakeoverImporter()
}
