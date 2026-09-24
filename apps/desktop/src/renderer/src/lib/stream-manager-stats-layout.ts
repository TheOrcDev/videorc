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
