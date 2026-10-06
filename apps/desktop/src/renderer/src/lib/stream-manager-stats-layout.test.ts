import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StatsBar } from '@/components/stream-manager/stats-bar'
import type { StatId, StatItemModel } from '@/lib/stream-manager-stats'

import {
  arrangeStats,
  DEFAULT_STATS_LAYOUT,
  loadStatsLayout,
  moveStat,
  normalizeStatsLayout,
  saveStatsLayout,
  setStatHidden,
  STATS_LAYOUT_STORAGE_KEY,
  type StatsLayout
} from './stream-manager-stats-layout'

const item = (id: StatId): StatItemModel => ({
  id,
  label: id,
  value: '1',
  tone: 'neutral',
  details: [],
  description: id
})

const ALL: StatId[] = ['session', 'viewers', 'followers', 'supporters', 'tips', 'chat']

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values
  }
}

describe('stats bar layout (plan 057, D2)', () => {
  it('fills the main slots by position, whatever the session lacks', () => {
    const { main, more } = arrangeStats(
      ['chat', 'supporters', 'viewers', 'session'].map((id) => item(id as StatId)),
      DEFAULT_STATS_LAYOUT
    )
    // No followers this session: the third main slot stays empty rather than
    // pulling Supporters forward, so a stat never jumps between groups.
    expect(main.map((stat) => stat.id)).toEqual(['session', 'viewers'])
    expect(more.map((stat) => stat.id)).toEqual(['supporters', 'chat'])
  })

  it('moves a stat, and puts another into the third main slot', () => {
    const tipsFirstOfTheRest = moveStat(DEFAULT_STATS_LAYOUT, 'tips', 3)
    expect(tipsFirstOfTheRest.order).toEqual([
      'session',
      'viewers',
      'followers',
      'tips',
      'supporters',
      'chat'
    ])
    const supportersInMain = moveStat(DEFAULT_STATS_LAYOUT, 'supporters', 2)
    expect(arrangeStats(ALL.map(item), supportersInMain).main.map((stat) => stat.id)).toEqual([
      'session',
      'viewers',
      'supporters'
    ])
    // The viewers can lead: both locked stats are still in the main slots.
    expect(moveStat(DEFAULT_STATS_LAYOUT, 'viewers', 0).order.slice(0, 3)).toEqual([
      'viewers',
      'session',
      'followers'
    ])
  })

  it('refuses a move that pushes the clock or the viewer count out of the main slots', () => {
    expect(moveStat(DEFAULT_STATS_LAYOUT, 'viewers', 5)).toBe(DEFAULT_STATS_LAYOUT)
    const followersFirst = moveStat(DEFAULT_STATS_LAYOUT, 'followers', 0)
    expect(moveStat(followersFirst, 'tips', 0)).toBe(followersFirst)
    // Not a move at all: the same layout.
    expect(moveStat(DEFAULT_STATS_LAYOUT, 'followers', 2)).toBe(DEFAULT_STATS_LAYOUT)
  })

  it('hides and shows any stat but the clock and the viewer count', () => {
    const noTips = setStatHidden(DEFAULT_STATS_LAYOUT, 'tips', true)
    expect(noTips.hidden).toEqual(['tips'])
    expect(arrangeStats(ALL.map(item), noTips).more.map((stat) => stat.id)).not.toContain('tips')
    expect(setStatHidden(noTips, 'tips', false).hidden).toEqual([])
    expect(setStatHidden(DEFAULT_STATS_LAYOUT, 'viewers', true)).toBe(DEFAULT_STATS_LAYOUT)
    expect(setStatHidden(DEFAULT_STATS_LAYOUT, 'session', true)).toBe(DEFAULT_STATS_LAYOUT)
  })

  it('makes any stored value safe', () => {
    expect(normalizeStatsLayout(null)).toEqual(DEFAULT_STATS_LAYOUT)
    expect(normalizeStatsLayout('nonsense')).toEqual(DEFAULT_STATS_LAYOUT)
    const partial = normalizeStatsLayout({
      order: ['tips', 'session', 'viewers', 'bogus', 'tips'],
      hidden: ['chat', 'viewers', 'bogus']
    })
    // Unknown and repeated ids go, missing ones return in default order, and
    // a locked stat is never hidden.
    expect(partial.order).toEqual(['tips', 'session', 'viewers', 'followers', 'supporters', 'chat'])
    expect(partial.hidden).toEqual(['chat'])
    // A layout saved while the bar had a health stat loads without it.
    expect(
      normalizeStatsLayout({ order: ['session', 'viewers', 'health'], hidden: ['health'] })
    ).toEqual(DEFAULT_STATS_LAYOUT)
    // A stored order that pushed the viewers out falls back to the default.
    expect(
      normalizeStatsLayout({ order: ['followers', 'tips', 'chat', 'viewers', 'session'] }).order
    ).toEqual(DEFAULT_STATS_LAYOUT.order)
  })

  it('round-trips through storage and survives garbage or a throwing store', () => {
    const storage = memoryStorage()
    const layout: StatsLayout = moveStat(
      setStatHidden(DEFAULT_STATS_LAYOUT, 'chat', true),
      'tips',
      3
    )
    saveStatsLayout(storage, layout)
    expect(JSON.parse(storage.values.get(STATS_LAYOUT_STORAGE_KEY) ?? '')).toMatchObject({ v: 1 })
    expect(loadStatsLayout(storage)).toEqual(layout)
    expect(loadStatsLayout(memoryStorage({ [STATS_LAYOUT_STORAGE_KEY]: '{not json' }))).toBe(
      DEFAULT_STATS_LAYOUT
    )
    const throwing = {
      getItem: (): string => {
        throw new Error('denied')
      },
      setItem: (): void => {
        throw new Error('denied')
      }
    }
    expect(loadStatsLayout(throwing)).toBe(DEFAULT_STATS_LAYOUT)
    expect(() => saveStatsLayout(throwing, layout)).not.toThrow()
    expect(loadStatsLayout(undefined)).toBe(DEFAULT_STATS_LAYOUT)
  })

  it("draws the bar in the streamer's order", () => {
    const layout = moveStat(moveStat(DEFAULT_STATS_LAYOUT, 'viewers', 0), 'chat', 3)
    const markup = renderToStaticMarkup(
      createElement(StatsBar, { items: ALL.map(item), layout, onLayoutChange: () => undefined })
    )
    const order = [...markup.matchAll(/data-stat="([a-z]+)"/g)].map((match) => match[1])
    expect(order).toEqual(['viewers', 'session', 'followers', 'chat', 'supporters', 'tips'])
    expect(markup).toContain('draggable="true"')
    // Without a change handler the order is fixed and nothing drags.
    const fixed = renderToStaticMarkup(createElement(StatsBar, { items: ALL.map(item) }))
    expect(fixed).not.toContain('draggable')
  })
})
