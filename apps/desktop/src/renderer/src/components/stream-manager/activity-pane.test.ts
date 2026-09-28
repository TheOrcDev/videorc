import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ActivityPane, activityRowShowsPerson } from '@/components/stream-manager/activity-pane'
import type { LiveChatProviderState } from '@/lib/backend'
import type { ActivityItem } from '@/lib/stream-activity'

const provider = (platform: 'twitch' | 'youtube'): LiveChatProviderState => ({
  id: platform,
  platform,
  read: 'ready',
  write: 'ready',
  state: 'connected',
  message: ''
})

const items: ActivityItem[] = [
  {
    id: 'a',
    kind: 'subscription',
    filter: 'support',
    platform: 'twitch',
    name: 'morgaesis',
    line: 'Resubscribed for 14 months at Tier 1',
    short: 'Resub · 14 months',
    at: '2026-09-24T10:00:00Z'
  },
  {
    id: 'b',
    kind: 'cheer',
    filter: 'tips',
    platform: 'twitch',
    name: 'sarzdotmd',
    line: 'Cheered 500 bits',
    short: '500 bits',
    message: 'that transition was clean',
    at: '2026-09-24T10:00:30Z'
  }
]

// Plan 057, D3: facts, not sentences.
describe('ActivityPane', () => {
  const markup = renderToStaticMarkup(
    createElement(ActivityPane, {
      items,
      providers: [provider('twitch'), provider('youtube')],
      nowMs: Date.parse('2026-09-24T10:01:00Z')
    })
  )

  it('shows the short fact beside the name, with the sentence on hover', () => {
    expect(markup).toContain('>Resub · 14 months<')
    expect(markup).toContain('title="Resubscribed for 14 months at Tier 1"')
    expect(markup).toContain('that transition was clean')
  })

  it('drops the summary sentence; chips carry counts and hide at zero', () => {
    expect(markup).not.toContain('This stream')
    expect(markup).toContain('Subs<span')
    expect(markup).toContain('Tips<span')
    expect(markup).not.toContain('Follows')
    expect(markup).not.toContain('Raids')
    expect(markup).not.toContain('Destinations')
  })
})

// Plan 071, S1: a row about one person shows that person.
describe('ActivityPane avatars', () => {
  const follows: ActivityItem[] = [
    {
      id: 'named',
      kind: 'follow',
      filter: 'follows',
      platform: 'twitch',
      name: 'Sam Carter',
      line: 'Followed',
      short: 'Follow',
      at: '2026-09-24T10:00:00Z',
      authorAvatarUrl: 'https://static-cdn.jtvnw.net/sam.png'
    },
    {
      id: 'no-picture',
      kind: 'follow',
      filter: 'follows',
      platform: 'kick',
      name: 'pixel',
      line: 'Followed',
      short: 'Follow',
      at: '2026-09-24T10:00:10Z'
    },
    {
      id: 'unnamed',
      kind: 'follow',
      filter: 'follows',
      platform: 'x',
      name: 'New follower',
      line: '1 new follower.',
      short: '',
      at: '2026-09-24T10:00:20Z',
      unnamed: true
    }
  ]
  const markup = renderToStaticMarkup(
    createElement(ActivityPane, {
      items: follows,
      providers: [provider('twitch')],
      nowMs: Date.parse('2026-09-24T10:01:00Z')
    })
  )
  const row = (id: string): string => {
    const start = markup.indexOf(`data-activity-id="${id}"`)
    return markup.slice(start, markup.indexOf('</li>', start))
  }

  it('shows the follower as an avatar circle, with initials until the picture loads', () => {
    expect(row('named')).toContain('data-slot="activity-avatar"')
    expect(row('named')).toContain('>SC<')
    expect(row('no-picture')).toContain('data-slot="activity-avatar"')
    expect(row('no-picture')).toContain('>P<')
  })

  it('keeps the glyph for a count the platform never named', () => {
    expect(row('unnamed')).toContain('data-slot="activity-glyph"')
    expect(row('unnamed')).not.toContain('activity-avatar')
  })
})

describe('activityRowShowsPerson', () => {
  const base: ActivityItem = {
    id: 'x',
    kind: 'follow',
    filter: 'follows',
    platform: 'twitch',
    name: 'sam',
    line: 'Followed',
    short: 'Follow',
    at: '2026-09-24T10:00:00Z'
  }

  it('is true for people and false for counts, announcements and destinations', () => {
    expect(activityRowShowsPerson(base)).toBe(true)
    expect(activityRowShowsPerson({ ...base, kind: 'raid' })).toBe(true)
    expect(activityRowShowsPerson({ ...base, unnamed: true })).toBe(false)
    expect(activityRowShowsPerson({ ...base, kind: 'announcement' })).toBe(false)
    expect(activityRowShowsPerson({ ...base, kind: 'destination-failed' })).toBe(false)
  })
})
