import { describe, expect, it } from 'vitest'

import type { StatId, StatItemModel } from '@/lib/stream-manager-stats'

import { arrangeStats, DEFAULT_STATS_LAYOUT } from './stream-manager-stats-layout'

const item = (id: StatId): StatItemModel => ({
  id,
  label: id,
  value: '1',
  tone: 'neutral',
  details: [],
  description: id
})

describe('stats bar layout (plan 057, D2)', () => {
  it('fills the main slots by position, whatever the session lacks', () => {
    const { main, more } = arrangeStats(
      ['chat', 'followers', 'viewers', 'session'].map((id) => item(id as StatId)),
      DEFAULT_STATS_LAYOUT
    )
    // No health this session: the third main slot stays empty rather than
    // pulling Followers forward, so a stat never jumps between groups.
    expect(main.map((stat) => stat.id)).toEqual(['session', 'viewers'])
    expect(more.map((stat) => stat.id)).toEqual(['followers', 'chat'])
  })
})
