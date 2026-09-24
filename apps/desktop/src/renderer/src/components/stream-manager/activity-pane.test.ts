import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ActivityPane } from '@/components/stream-manager/activity-pane'
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
