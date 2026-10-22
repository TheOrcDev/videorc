import { STORAGE_KEYS } from '@/lib/capture'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * The Livestream page's views (plan 174 S1.6b, A-14), in strip order, built
 * like Settings' tabs: Setup prepares the destinations and the stream
 * details, Upcoming lists scheduled streams. Ids are stable: they are stored
 * as the view used last and carried by links. Labels are copy.
 *
 * The shell imports this module, so it sits in the eager chunk: keep it to
 * ids, labels and the storage helpers (no icons, no components).
 */
export const LIVESTREAM_VIEWS = [
  { id: 'setup', label: 'Setup' },
  { id: 'upcoming', label: 'Upcoming' }
] as const

export type LivestreamViewId = (typeof LIVESTREAM_VIEWS)[number]['id']

export const DEFAULT_LIVESTREAM_VIEW: LivestreamViewId = 'setup'

export function isLivestreamViewId(value: unknown): value is LivestreamViewId {
  return LIVESTREAM_VIEWS.some((view) => view.id === value)
}

/** The page's localStorage, or null where reading the property itself throws. */
function pageStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * The view Livestream opens on: the last one used on this device, else
 * Setup. A convenience, so storage that is missing, holds an unknown id, or
 * throws falls back instead of breaking the page.
 */
export function readLastLivestreamView(
  storage: Pick<Storage, 'getItem'> | null = pageStorage()
): LivestreamViewId {
  try {
    const stored = storage?.getItem(STORAGE_KEYS.livestreamView)
    return isLivestreamViewId(stored) ? stored : DEFAULT_LIVESTREAM_VIEW
  } catch {
    return DEFAULT_LIVESTREAM_VIEW
  }
}

export function writeLastLivestreamView(
  view: LivestreamViewId,
  storage: Pick<Storage, 'setItem'> | null = pageStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEYS.livestreamView, view)
  } catch {
    // Not remembering the view is harmless; Livestream opens on Setup next time.
  }
}

/**
 * Opens the Livestream page (workspace id `live`) on `view` from outside
 * React (⌘K, a toast action), through the typed workspace navigation.
 */
export function openLivestreamView(view: LivestreamViewId): void {
  openWorkspaceTab('live', view)
}
