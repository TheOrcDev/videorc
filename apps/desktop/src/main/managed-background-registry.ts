/**
 * Startup rehydration of managed background capabilities (PERF-05).
 *
 * The Electron main process re-registers every bundled picture, live poster and
 * imported background with the backend each time it connects. Deriving the
 * `{assetId, path}` records used to resolve each id from scratch (rebuild both
 * shipped manifests, re-list the imported directory); this module collects them
 * once per rehydration instead. The filesystem and the registration RPC are
 * injected so the rules are verified in node. Nothing is cached across calls:
 * a later import must always be re-read.
 */

const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type ManagedBackgroundRecord = {
  assetId: string
  path: string
}

export type ManagedBackgroundShippedAsset = {
  id: string
  assetPath: string
}

export type ManagedBackgroundCollectionDeps = {
  /** Shipped pictures whose file exists (checked once by the caller). */
  bundled: readonly ManagedBackgroundShippedAsset[]
  /** Shipped live posters whose file exists (checked once by the caller). */
  posters: readonly ManagedBackgroundShippedAsset[]
  importedRoot: string
  /** Throws when the imported directory does not exist yet (a fresh profile). */
  readDirectory: (root: string) => readonly string[]
  /** The symlink / regular-file / canonical-root check; null rejects the file. */
  resolveRegularFile: (root: string, fileName: string) => string | null
  isSupportedFile: (fileName: string) => boolean
}

/**
 * Precedence matches the single-id path: a bundled picture wins over a live
 * poster, which wins over an imported file with the same id. An imported id
 * with several files takes the first supported regular file in directory order.
 */
export function collectManagedBackgroundRecords(
  deps: ManagedBackgroundCollectionDeps
): ManagedBackgroundRecord[] {
  const records = new Map<string, string>()
  for (const asset of [...deps.bundled, ...deps.posters]) {
    if (!records.has(asset.id)) {
      records.set(asset.id, asset.assetPath)
    }
  }

  let entries: readonly string[]
  try {
    entries = deps.readDirectory(deps.importedRoot)
  } catch {
    // A fresh profile has no imported background directory yet.
    entries = []
  }
  for (const entry of entries) {
    const dot = entry.lastIndexOf('.')
    const id = dot > 0 ? entry.slice(0, dot) : ''
    if (!ASSET_ID_PATTERN.test(id) || records.has(id) || !deps.isSupportedFile(entry)) {
      continue
    }
    const resolved = deps.resolveRegularFile(deps.importedRoot, entry)
    if (resolved) {
      records.set(id, resolved)
    }
  }
  return [...records].map(([assetId, path]) => ({ assetId, path }))
}

export async function rehydrateManagedBackgrounds(
  deps: ManagedBackgroundCollectionDeps & {
    register: (record: ManagedBackgroundRecord) => Promise<unknown>
  }
): Promise<void> {
  const records = collectManagedBackgroundRecords(deps)
  await Promise.all(records.map((record) => deps.register(record)))
}
