import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ActivityPane,
  activityCapabilityNote,
  activityHighlight,
  activityRowActions,
  activityRowShowsPerson
} from '@/components/stream-manager/activity-pane'
import type { CommentHighlightState, LiveChatProviderState } from '@/lib/backend'
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

// Plan 071, S2: the Twitch reconnect is one click from Activity.
describe('ActivityPane Show who followed', () => {
  const render = (audienceScopes: boolean, withAction: boolean) =>
    renderToStaticMarkup(
      createElement(ActivityPane, {
        items: [],
        providers: [provider('twitch')],
        nowMs: Date.parse('2026-09-24T10:01:00Z'),
        audience: {
          sessionId: 's',
          updatedAt: '2026-09-24T10:00:00Z',
          platforms: [
            { platform: 'twitch', metric: 'followers', capability: 'available', audienceScopes }
          ]
        },
        ...(withAction ? { onShowFollowNames: () => undefined } : {})
      })
    )

  it('offers the reconnect while Twitch lacks the follow permission', () => {
    const markup = render(false, true)
    expect(markup).toContain('data-slot="activity-follow-names"')
    expect(markup).toContain('Twitch names each follower once you allow it.')
    expect(markup).not.toContain('Livestream → Setup')
  })

  it('hides it once the permission is granted, or when the window cannot act', () => {
    expect(render(true, true)).not.toContain('activity-follow-names')
    expect(render(false, false)).not.toContain('activity-follow-names')
  })
})

// Plan 071, S4: X names followers while its follow subscription is live.
describe('activityCapabilityNote for X', () => {
  const note = (namedFollowsSince?: string, namedFollowsUntil?: string) =>
    activityCapabilityNote(['x'], {
      sessionId: 's',
      updatedAt: '2026-09-28T10:00:00Z',
      platforms: [
        {
          platform: 'x',
          metric: 'followers',
          capability: 'available',
          ...(namedFollowsSince ? { namedFollowsSince } : {}),
          ...(namedFollowsUntil ? { namedFollowsUntil } : {})
        }
      ]
    })

  it('says follows are a count only while X is not naming them', () => {
    expect(note()).toBe("X doesn't share tips. New X followers show as a count.")
    expect(note('2026-09-28T10:00:00Z')).toBe("X doesn't share tips.")
    expect(note('2026-09-28T10:00:00Z', '2026-09-28T10:30:00Z')).toBe(
      "X doesn't share tips. New X followers show as a count."
    )
  })
})

// Plan 095, S2: Activity says what is on stream, with chat's own badge.
describe('ActivityPane on stream', () => {
  const rows: ActivityItem[] = [
    {
      id: 'follow',
      kind: 'follow',
      filter: 'follows',
      platform: 'x',
      name: 'New Fan',
      line: 'Followed',
      short: 'Follow',
      at: '2026-09-24T10:00:00Z',
      messageId: 'm-follow'
    },
    {
      id: 'sub',
      kind: 'subscription',
      filter: 'support',
      platform: 'twitch',
      name: 'morgaesis',
      line: 'Resubscribed for 14 months at Tier 1',
      short: 'Resub · 14 months',
      at: '2026-09-24T10:00:10Z',
      messageId: 'm-sub'
    },
    {
      id: 'destination',
      kind: 'destination-failed',
      filter: 'destinations',
      platform: 'youtube',
      name: 'YouTube',
      line: 'YouTube failed',
      short: 'Failed',
      at: '2026-09-24T10:00:20Z'
    }
  ]
  const live = (messageId: string): CommentHighlightState => ({
    generation: 3,
    phase: 'live',
    messageId
  })
  const render = (props: Partial<Parameters<typeof ActivityPane>[0]>): string =>
    renderToStaticMarkup(
      createElement(ActivityPane, {
        items: rows,
        providers: [provider('twitch')],
        nowMs: Date.parse('2026-09-24T10:01:00Z'),
        onShowOnStream: () => undefined,
        ...props
      })
    )
  const rowOf = (markup: string, id: string): string => {
    const at = markup.indexOf(`data-activity-id="${id}"`)
    expect(at).toBeGreaterThan(-1)
    const start = markup.lastIndexOf('<li', at)
    return markup.slice(start, markup.indexOf('</li>', at))
  }
  // Selected = a full-row bg-accent block, not only the hover one.
  const selected = (row: string): boolean =>
    (row.match(/^<li class="([^"]*)"/)?.[1] ?? '').split(' ').includes('bg-accent')

  it('shows On stream on the live row only, as a full-row selection', () => {
    const markup = render({ highlightState: live('m-follow'), liveHighlightId: 'm-follow' })
    const follow = rowOf(markup, 'follow')
    expect(follow).toContain('data-highlight-phase="live"')
    expect(follow).toContain('data-slot="activity-highlight"')
    expect(follow).toMatch(/data-variant="success"[^>]*>On stream</)
    expect(follow).not.toMatch(/data-variant="live"/)
    expect(selected(follow)).toBe(true)
    expect(rowOf(markup, 'sub')).toContain('data-highlight-phase="idle"')
    expect(rowOf(markup, 'sub')).not.toContain('On stream')
    expect(selected(rowOf(markup, 'sub'))).toBe(false)
    expect(markup.match(/On stream/g)).toHaveLength(1)
  })

  it('shows Applying… and Failed (with the reason on hover) on the matching row', () => {
    const applying = render({ highlightApplyingId: 'm-sub' })
    expect(rowOf(applying, 'sub')).toContain('data-highlight-phase="applying"')
    expect(rowOf(applying, 'sub')).toMatch(/data-variant="secondary"[^>]*>Applying…</)
    expect(rowOf(applying, 'follow')).not.toContain('Applying')

    const failed = render({
      highlightFailure: { messageId: 'm-follow', reason: 'The stream is not live.' }
    })
    expect(rowOf(failed, 'follow')).toContain('data-highlight-phase="failed"')
    expect(rowOf(failed, 'follow')).toMatch(
      /data-variant="destructive"[^>]*title="The stream is not live\."[^>]*>Failed</
    )
    expect(rowOf(failed, 'sub')).not.toContain('Failed<')
    // A failed row is not a selected row.
    expect(selected(rowOf(failed, 'follow'))).toBe(false)
  })

  it('never badges a row without a chat message behind it', () => {
    const markup = render({ highlightState: live('m-follow'), liveHighlightId: 'm-follow' })
    const destination = rowOf(markup, 'destination')
    expect(destination).not.toContain('data-highlight-phase')
    expect(destination).not.toContain('activity-highlight')
    const item = rows[2]!
    expect(activityHighlight(item, { highlightApplyingId: 'destination' })).toEqual({
      phase: 'idle'
    })
  })

  it('is idle for a different message or an idle slot', () => {
    expect(activityHighlight(rows[0]!, { highlightState: live('m-sub') })).toEqual({
      phase: 'idle'
    })
    expect(
      activityHighlight(rows[0]!, {
        highlightState: { generation: 4, phase: 'idle', messageId: 'm-follow' }
      })
    ).toEqual({ phase: 'idle', reason: undefined })
    expect(activityHighlight(rows[0]!, {})).toEqual({ phase: 'idle' })
    const markup = render({ highlightState: { generation: 4, phase: 'idle' } })
    expect(markup).not.toContain('activity-highlight')
    expect(markup).not.toContain('data-highlight-phase="live"')
  })

  it('flips Show on stream to Take off stream while the row is live', () => {
    const onShowOnStream = (): void => undefined
    const show = (phase: 'idle' | 'applying' | 'live' | 'failed') =>
      activityRowActions(rows[0]!, { phase }, { onShowOnStream }).find(
        (action) => action.id === 'show'
      )
    expect(show('idle')?.label).toBe('Show on stream')
    expect(show('failed')?.label).toBe('Show on stream')
    expect(show('live')?.label).toBe('Take off stream')
    expect(show('applying')?.disabled).toBe(true)
    expect(show('live')?.disabled).toBe(false)
    // No chat message behind it, or no live window: nothing to show.
    expect(
      activityRowActions(rows[2]!, { phase: 'idle' }, { onShowOnStream }).map(({ id }) => id)
    ).not.toContain('show')
    expect(activityRowActions(rows[0]!, { phase: 'live' }, {}).map(({ id }) => id)).toEqual([
      'copy'
    ])
  })
})
