import { DEFAULT_STAT_ORDER, type StatId, type StatItemModel } from '@/lib/stream-manager-stats'

// Where each stat sits in the Stream Manager's stats bar (plan 057, D2). The
// first MAIN_SLOTS positions of `order` are the main slots: never clipped,
// drawn larger. The rest follow and drop off the end when the window is too
// narrow. The clock and the viewer count always stay in the main slots, so
// the viewer count is never hidden while live (plan 047).

export interface StatsLayout {
  order: StatId[]
  hidden: StatId[]
}

export const MAIN_SLOTS = 3

/** Always shown, always in the main slots. */
export const LOCKED_STATS: ReadonlySet<StatId> = new Set<StatId>(['session', 'viewers'])

export const DEFAULT_STATS_LAYOUT: StatsLayout = {
  order: [...DEFAULT_STAT_ORDER],
  hidden: []
}

/** The session's stats in layout order, split into the main slots and the rest. */
export function arrangeStats(
  items: readonly StatItemModel[],
  layout: StatsLayout = DEFAULT_STATS_LAYOUT
): { main: StatItemModel[]; more: StatItemModel[] } {
  const byId = new Map(items.map((item) => [item.id, item]))
  const hidden = new Set(layout.hidden)
  const main: StatItemModel[] = []
  const more: StatItemModel[] = []
  layout.order.forEach((id, index) => {
    const item = byId.get(id)
    if (!item || hidden.has(id)) return
    ;(index < MAIN_SLOTS ? main : more).push(item)
  })
  return { main, more }
}

/** One per machine, beside the window's other renderer-local preferences. */
export const STATS_LAYOUT_STORAGE_KEY = 'videorc.streamManager.statsBar'

const KNOWN_STATS: ReadonlySet<string> = new Set(DEFAULT_STAT_ORDER)

function isStatId(value: unknown): value is StatId {
  return typeof value === 'string' && KNOWN_STATS.has(value)
}

/** Neither the clock nor the viewer count may leave the main slots. */
function lockedInMain(order: readonly StatId[]): boolean {
  return [...LOCKED_STATS].every((id) => {
    const index = order.indexOf(id)
    return index >= 0 && index < MAIN_SLOTS
  })
}

/**
 * Any stored value, made safe: unknown ids dropped, duplicates dropped,
 * missing ids appended in default order, and a layout that moved the clock or
 * the viewer count out of the main slots, or hid them, falls back to default.
 */
export function normalizeStatsLayout(raw: unknown): StatsLayout {
  if (!raw || typeof raw !== 'object') return DEFAULT_STATS_LAYOUT
  const record = raw as { order?: unknown; hidden?: unknown }
  const stored = Array.isArray(record.order) ? record.order.filter(isStatId) : []
  const order = [...new Set(stored)]
  for (const id of DEFAULT_STAT_ORDER) if (!order.includes(id)) order.push(id)
  const hidden = Array.isArray(record.hidden)
    ? [...new Set(record.hidden.filter(isStatId))].filter((id) => !LOCKED_STATS.has(id))
    : []
  if (!lockedInMain(order)) return { order: [...DEFAULT_STAT_ORDER], hidden }
  return { order, hidden }
}

/**
 * Moves one stat to `toIndex` (its position after the move). A move that would
 * push the clock or the viewer count out of the main slots is refused: the
 * same layout comes back.
 */
export function moveStat(layout: StatsLayout, id: StatId, toIndex: number): StatsLayout {
  const from = layout.order.indexOf(id)
  if (from < 0) return layout
  const order = layout.order.filter((candidate) => candidate !== id)
  const index = Math.max(0, Math.min(order.length, toIndex))
  order.splice(index, 0, id)
  if (order.every((candidate, position) => candidate === layout.order[position])) return layout
  return lockedInMain(order) ? { ...layout, order } : layout
}

export function setStatHidden(layout: StatsLayout, id: StatId, hidden: boolean): StatsLayout {
  if (LOCKED_STATS.has(id)) return layout
  const without = layout.hidden.filter((candidate) => candidate !== id)
  return { ...layout, hidden: hidden ? [...without, id] : without }
}

/** Storage can be missing or throw (private profiles, tests): default then. */
export function loadStatsLayout(storage: Pick<Storage, 'getItem'> | undefined): StatsLayout {
  try {
    const raw = storage?.getItem(STATS_LAYOUT_STORAGE_KEY)
    return raw ? normalizeStatsLayout(JSON.parse(raw)) : DEFAULT_STATS_LAYOUT
  } catch {
    return DEFAULT_STATS_LAYOUT
  }
}

export function saveStatsLayout(
  storage: Pick<Storage, 'setItem'> | undefined,
  layout: StatsLayout
): void {
  try {
    storage?.setItem(STATS_LAYOUT_STORAGE_KEY, JSON.stringify({ v: 1, ...layout }))
  } catch {
    // A preference that cannot be saved still applies for this window's life.
  }
}

/** The window's `localStorage`, or undefined where touching it throws. */
export function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
