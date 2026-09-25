import { describe, expect, it } from 'vitest'

import type {
  LiveChatMessage,
  LiveChatProviderState,
  StreamPlatform,
  StreamTargetRuntime,
  ViewerSample
} from '@/lib/backend'

import {
  emptyLiveDashboardState,
  reduceDashboardAudience,
  reduceDashboardHealth,
  reduceDashboardRecording,
  reduceDashboardTargets,
  reduceDashboardViewers,
  type LiveDashboardState
} from '../../../shared/live-dashboard'
import {
  formatClock,
  formatMoneyShort,
  statItems,
  supportersUnit,
  type StatId,
  type StatItemModel
} from './stream-manager-stats'

const T0 = Date.parse('2026-09-24T10:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

function provider(platform: StreamPlatform): LiveChatProviderState {
  return {
    id: platform,
    platform,
    read: 'ready',
    write: platform === 'x' ? 'read-only' : 'ready',
    state: 'connected',
    message: ''
  }
}

function sample(seconds: number, total: number): ViewerSample {
  return {
    sessionId: 's',
    platforms: [{ platform: 'twitch', count: total }],
    total,
    at: at(seconds)
  }
}

function live(): LiveDashboardState {
  return reduceDashboardRecording(
    emptyLiveDashboardState(at(0)),
    { state: 'streaming', sessionId: 's', startedAt: at(0) },
    at(0)
  )
}

function withTargets(
  dashboard: LiveDashboardState,
  targets: StreamTargetRuntime[]
): LiveDashboardState {
  return reduceDashboardTargets(dashboard, { sessionId: 's', targets }, at(30))
}

function healthy(): LiveDashboardState {
  let dashboard = reduceDashboardHealth(
    live(),
    { sessionId: 's', bitrateKbps: 6000, fps: 60, droppedFrames: 0, createdAt: at(0) },
    at(0)
  )
  dashboard = reduceDashboardHealth(
    dashboard,
    { sessionId: 's', bitrateKbps: 6012, fps: 60, droppedFrames: 0, createdAt: at(30) },
    at(30)
  )
  return withTargets(dashboard, [
    { targetId: 'twitch', platform: 'twitch', label: 'Twitch', state: 'live' },
    { targetId: 'x', platform: 'x', label: 'X', state: 'live' }
  ])
}

const ids = (items: { id: StatId }[]): StatId[] => items.map((item) => item.id)
const find = (items: StatItemModel[], id: StatId): StatItemModel | undefined =>
  items.find((item) => item.id === id)

function message(overrides: Partial<LiveChatMessage>): LiveChatMessage {
  const receivedAt = overrides.receivedAt ?? at(50)
  return {
    id: overrides.id ?? 'm',
    sessionId: 's',
    platform: 'twitch',
    providerMessageId: overrides.id ?? 'm',
    authorName: 'viewer',
    authorRoles: [],
    authorBadges: [],
    publishedAt: receivedAt,
    receivedAt,
    messageText: 'hi',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

describe('stats bar items (plan 057)', () => {
  it('shows only the session when nothing is running', () => {
    const items = statItems({
      dashboard: null,
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: T0
    })
    expect(items).toEqual([
      {
        id: 'session',
        label: 'Session',
        value: 'Off air',
        tone: 'subtle',
        badge: 'off-air',
        details: [],
        description: 'Off air'
      }
    ])
  })

  it('puts the clock, viewers and health first, in that order', () => {
    const dashboard = reduceDashboardViewers(healthy(), sample(40, 1234), at(40))
    const items = statItems({
      dashboard,
      viewerSample: null,
      messages: [],
      providers: [provider('twitch'), provider('x')],
      nowMs: T0 + 3_725_000
    })
    expect(ids(items).slice(0, 3)).toEqual(['session', 'viewers', 'health'])
    expect(find(items, 'session')).toMatchObject({
      value: '1:02:05',
      badge: 'live',
      description: 'On air for 1:02:05'
    })
    expect(formatClock(59_000)).toBe('0:59')
  })

  it('keeps the viewer count in place while live, as a dash until a platform reports', () => {
    const items = statItems({
      dashboard: live(),
      viewerSample: null,
      messages: [],
      providers: [provider('x')],
      nowMs: T0 + 5_000
    })
    // X shares no tips or subs: no Supporters or Tips stat, never a fake 0.
    expect(ids(items)).toEqual(['session', 'viewers', 'health', 'chat'])
    expect(find(items, 'viewers')).toMatchObject({
      value: '–',
      tone: 'subtle',
      description: 'No viewer count yet'
    })
    // No sample yet: health holds its place with a dash, not a zero.
    expect(find(items, 'health')).toMatchObject({ value: '–', tone: 'neutral' })
  })

  it('reports viewers with the peak on hover, greyed once stale', () => {
    let dashboard = reduceDashboardViewers(live(), sample(30, 900), at(30))
    dashboard = reduceDashboardViewers(dashboard, sample(60, 1234), at(60))
    const fresh = find(
      statItems({
        dashboard,
        viewerSample: null,
        messages: [],
        providers: [provider('twitch')],
        nowMs: T0 + 70_000
      }),
      'viewers'
    )
    expect(fresh).toMatchObject({
      value: '1.2k',
      tone: 'neutral',
      spark: [900, 1234],
      description: '1.2k viewers, peak 1.2k'
    })
    expect(fresh?.unit).toBeUndefined()
    expect(fresh?.details).toEqual([
      { label: 'Twitch', value: '1.2k', platform: 'twitch' },
      { label: 'Peak', value: '1.2k' }
    ])
    const stale = find(
      statItems({
        dashboard,
        viewerSample: null,
        messages: [],
        providers: [provider('twitch')],
        nowMs: T0 + 300_000
      }),
      'viewers'
    )
    expect(stale?.tone).toBe('subtle')
    expect(stale?.details.at(-1)).toEqual({ label: 'Updated', value: 'over a minute ago' })
  })

  it('is quiet when healthy: the bitrate, with the rest on hover', () => {
    const health = find(
      statItems({
        dashboard: healthy(),
        viewerSample: null,
        messages: [],
        providers: [],
        nowMs: T0 + 40_000
      }),
      'health'
    )
    expect(health).toMatchObject({
      value: '6,012 kbps',
      tone: 'good',
      description: 'Stream health: 6,012 kbps, 60 fps, no dropped frames'
    })
    expect(health?.details).toEqual([
      { label: 'Bitrate', value: '6,012 kbps' },
      { label: 'Frame rate', value: '60 fps' },
      { label: 'Dropped frames', value: 'None' },
      { label: 'Twitch', value: 'Live', platform: 'twitch', dot: 'good' },
      { label: 'X', value: 'Live', platform: 'x', dot: 'good' }
    ])
  })

  it('names the most urgent problem instead of the bitrate', () => {
    const reading = (dashboard: LiveDashboardState, nowMs = T0 + 40_000) =>
      find(
        statItems({ dashboard, viewerSample: null, messages: [], providers: [], nowMs }),
        'health'
      )
    const dropping = reduceDashboardHealth(
      healthy(),
      { sessionId: 's', bitrateKbps: 5900, fps: 60, droppedFrames: 12, createdAt: at(35) },
      at(35)
    )
    expect(reading(dropping)).toMatchObject({ value: '12 dropped/min', tone: 'warning' })

    let sagging = healthy()
    for (let second = 32; second < 60; second += 2) {
      sagging = reduceDashboardHealth(
        sagging,
        { sessionId: 's', bitrateKbps: 6000, fps: 60, droppedFrames: 0, createdAt: at(second) },
        at(second)
      )
    }
    sagging = reduceDashboardHealth(
      sagging,
      { sessionId: 's', bitrateKbps: 2100, fps: 60, droppedFrames: 0, createdAt: at(60) },
      at(60)
    )
    expect(reading(sagging, T0 + 61_000)).toMatchObject({ value: 'Low bitrate', tone: 'warning' })

    const connecting = withTargets(healthy(), [
      { targetId: 'twitch', platform: 'twitch', label: 'Twitch', state: 'live' },
      { targetId: 'x', platform: 'x', label: 'X', state: 'connecting' }
    ])
    expect(reading(connecting)).toMatchObject({ value: 'Connecting', tone: 'warning' })

    const failed = withTargets(dropping, [
      { targetId: 'twitch', platform: 'twitch', label: 'Twitch', state: 'live' },
      { targetId: 'x', platform: 'x', label: 'X', state: 'failed', message: 'Server closed' }
    ])
    // A failed destination outranks dropped frames.
    expect(reading(failed)).toMatchObject({
      value: 'X failed',
      tone: 'error',
      description: 'Stream health: X failed'
    })
    expect(reading(failed)?.details.at(-1)).toEqual({
      label: 'X',
      value: 'Failed',
      platform: 'x',
      dot: 'error',
      note: 'Server closed'
    })

    const twoFailed = withTargets(healthy(), [
      { targetId: 'twitch', platform: 'twitch', label: 'Twitch', state: 'failed' },
      { targetId: 'x', platform: 'x', label: 'X', state: 'failed' }
    ])
    expect(reading(twoFailed)).toMatchObject({ value: '2 failed', tone: 'error' })
  })

  it('sums followers as a number and a unit, and says why one is missing on hover', () => {
    const dashboard = reduceDashboardAudience(
      live(),
      {
        sessionId: 's',
        updatedAt: at(10),
        platforms: [
          {
            platform: 'twitch',
            metric: 'followers',
            capability: 'available',
            total: 61_942,
            baseline: 61_930,
            delta: 12
          },
          {
            platform: 'x',
            metric: 'followers',
            capability: 'needs-reconnect',
            message: 'Reconnect X to show followers.'
          },
          { platform: 'youtube', metric: 'subscribers', capability: 'unavailable', message: 'Off' }
        ]
      },
      at(10)
    )
    const followers = find(
      statItems({
        dashboard,
        viewerSample: null,
        messages: [],
        providers: [provider('twitch'), provider('x')],
        nowMs: T0
      }),
      'followers'
    )
    expect(followers).toMatchObject({
      value: '61,942',
      unit: 'followers',
      delta: '+12',
      description: '61,942 followers, +12 this stream'
    })
    expect(followers?.details.map((row) => [row.label, row.value, row.note])).toEqual([
      ['Twitch followers', '61,942', '+12 this stream'],
      ['X followers', '–', 'Reconnect X to show followers.'],
      ['YouTube subscribers', '–', 'Off']
    ])

    const onlyBlocked = reduceDashboardAudience(
      live(),
      {
        sessionId: 's',
        updatedAt: at(10),
        platforms: [
          {
            platform: 'x',
            metric: 'followers',
            capability: 'needs-reconnect',
            message: 'Reconnect X to show followers.'
          }
        ]
      },
      at(10)
    )
    expect(
      find(
        statItems({
          dashboard: onlyBlocked,
          viewerSample: null,
          messages: [],
          providers: [],
          nowMs: T0
        }),
        'followers'
      )
    ).toMatchObject({
      value: '–',
      unit: 'followers',
      tone: 'subtle',
      description: 'Followers: Reconnect X to show followers.'
    })
  })

  it('counts Kick follows as new followers, never a total (plan 063)', () => {
    const kickOnly = reduceDashboardAudience(
      live(),
      {
        sessionId: 's',
        updatedAt: at(10),
        platforms: [{ platform: 'kick', metric: 'followers', capability: 'delta-only', delta: 3 }]
      },
      at(10)
    )
    const followers = find(
      statItems({
        dashboard: kickOnly,
        viewerSample: null,
        messages: [],
        providers: [provider('kick')],
        nowMs: T0
      }),
      'followers'
    )
    expect(followers).toMatchObject({
      value: '3',
      unit: 'new followers',
      description: '3 new followers this stream'
    })
    expect(followers?.details.map((row) => [row.label, row.value, row.note])).toEqual([
      ['Kick followers', '–', 'New follows only: 3 new followers this stream']
    ])

    const withTwitch = reduceDashboardAudience(
      live(),
      {
        sessionId: 's',
        updatedAt: at(10),
        platforms: [
          {
            platform: 'twitch',
            metric: 'followers',
            capability: 'available',
            total: 100,
            baseline: 98,
            delta: 2
          },
          { platform: 'kick', metric: 'followers', capability: 'delta-only', delta: 1 }
        ]
      },
      at(10)
    )
    expect(
      find(
        statItems({
          dashboard: withTwitch,
          viewerSample: null,
          messages: [],
          providers: [provider('twitch'), provider('kick')],
          nowMs: T0
        }),
        'followers'
      )
    ).toMatchObject({ value: '100', delta: '+3' })
  })

  it('counts subs, tips and chat pace as short numbers', () => {
    const messages = [
      message({ id: 'a', authorId: 'a', receivedAt: at(20) }),
      message({ id: 'b', authorId: 'b', receivedAt: at(50) }),
      message({
        id: 'c',
        authorId: 'c',
        eventType: 'paid',
        receivedAt: at(55),
        details: { kind: 'cheer', bits: 600 }
      }),
      message({
        id: 'd',
        platform: 'youtube',
        authorId: 'd',
        eventType: 'paid',
        receivedAt: at(56),
        details: {
          kind: 'super-chat',
          amountMicros: 20_000_000,
          currency: 'USD',
          amountDisplay: '$20.00'
        }
      }),
      message({
        id: 'e',
        authorId: 'e',
        eventType: 'system',
        receivedAt: at(57),
        details: { kind: 'subscription', subscription: 'sub', tier: '1000', isPrime: false }
      })
    ]
    const items = statItems({
      dashboard: live(),
      viewerSample: null,
      messages,
      providers: [provider('twitch'), provider('youtube')],
      nowMs: T0 + 60_000
    })
    expect(find(items, 'supporters')).toMatchObject({ value: '1', unit: 'supporter' })
    expect(find(items, 'tips')?.value).toMatch(/^\$20 · 600 bits$/)
    expect(find(items, 'chat')).toMatchObject({ value: '4', unit: 'msg/min' })
    expect(find(items, 'chat')?.details).toContainEqual({ label: 'Chatters', value: '4' })
  })

  it('names supporters by the platforms in the session', () => {
    expect(supportersUnit(new Set(['twitch']), 8)).toBe('subs')
    expect(supportersUnit(new Set(['youtube']), 1)).toBe('member')
    expect(supportersUnit(new Set(['twitch', 'youtube']), 3)).toBe('supporters')
    expect(formatMoneyShort(4_990_000, 'USD')).toMatch(/4\.99/)
    expect(formatMoneyShort(20_000_000, 'USD')).not.toMatch(/\.00/)
  })

  it('shows zero tips as a subtle measured zero', () => {
    const tips = find(
      statItems({
        dashboard: live(),
        viewerSample: null,
        messages: [],
        providers: [provider('twitch')],
        nowMs: T0
      }),
      'tips'
    )
    expect(tips).toMatchObject({ value: '0', unit: 'tips', tone: 'subtle' })
  })

  it('shows a recording-only session as a clock without viewers or health', () => {
    const recording = reduceDashboardRecording(
      emptyLiveDashboardState(at(0)),
      { state: 'recording', sessionId: 's', startedAt: at(0) },
      at(0)
    )
    const items = statItems({
      dashboard: recording,
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: T0 + 723_000
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ value: '12:03', badge: 'recording' })
  })

  it('summarises a finished session in History', () => {
    const items = statItems({
      dashboard: null,
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: T0,
      history: {
        startedAt: '2026-09-23T18:00:00Z',
        title: 'Friday launch',
        stats: { viewers: [sample(0, 10), sample(30, 30), sample(60, 20)], audience: null }
      }
    })
    expect(find(items, 'session')).toMatchObject({
      badge: 'history',
      details: [{ label: 'Title', value: 'Friday launch' }]
    })
    expect(find(items, 'viewers')).toMatchObject({
      value: '30',
      unit: 'peak',
      description: 'Peak 30 viewers, average 20'
    })
    expect(ids(items)).not.toContain('health')
  })
})
