import { describe, expect, it } from 'vitest'

import type { LiveChatProviderState, StreamPlatform, ViewerSample } from '@/lib/backend'

import {
  emptyLiveDashboardState,
  reduceDashboardAudience,
  reduceDashboardHealth,
  reduceDashboardRecording,
  reduceDashboardTargets,
  reduceDashboardViewers,
  type LiveDashboardState
} from '../../../shared/live-dashboard'
import { formatClock, statTiles, type StatTileId } from './stream-manager-stats'

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

const ids = (tiles: { id: StatTileId }[]): StatTileId[] => tiles.map((tile) => tile.id)

describe('stats strip tiles', () => {
  it('shows only the session when nothing is running', () => {
    const tiles = statTiles({
      dashboard: null,
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: T0
    })
    expect(tiles).toEqual([
      { id: 'session', label: 'Session', value: 'Off air', tone: 'subtle', badge: 'off-air' }
    ])
  })

  it('runs the on-air clock and hides tiles with no source', () => {
    const tiles = statTiles({
      dashboard: live(),
      viewerSample: null,
      messages: [],
      providers: [provider('x')],
      nowMs: T0 + 3_725_000
    })
    // X shares no tips or subs: no Supporters or Tips tile, never a fake 0.
    expect(ids(tiles)).toEqual(['session', 'chat'])
    expect(tiles[0]).toMatchObject({ value: '1:02:05', badge: 'live' })
    expect(formatClock(59_000)).toBe('0:59')
  })

  it('reports viewers with peak and sparkline, greyed once stale', () => {
    let dashboard = reduceDashboardViewers(live(), sample(30, 900), at(30))
    dashboard = reduceDashboardViewers(dashboard, sample(60, 1234), at(60))
    const fresh = statTiles({
      dashboard,
      viewerSample: null,
      messages: [],
      providers: [provider('twitch')],
      nowMs: T0 + 70_000
    }).find((tile) => tile.id === 'viewers')
    expect(fresh).toMatchObject({
      value: '1.2k',
      detail: 'Peak 1.2k',
      tone: 'neutral',
      spark: [900, 1234]
    })
    expect(fresh?.split).toEqual([{ platform: 'twitch', label: 'Twitch', value: '1.2k' }])
    const stale = statTiles({
      dashboard,
      viewerSample: null,
      messages: [],
      providers: [provider('twitch')],
      nowMs: T0 + 300_000
    }).find((tile) => tile.id === 'viewers')
    expect(stale?.tone).toBe('subtle')
  })

  it('sums followers across platforms and says why one is missing', () => {
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
    const followers = statTiles({
      dashboard,
      viewerSample: null,
      messages: [],
      providers: [provider('twitch'), provider('x')],
      nowMs: T0
    }).find((tile) => tile.id === 'followers')
    expect(followers).toMatchObject({ value: '61,942', detail: '+12 this stream' })
    expect(followers?.split?.map((row) => [row.label, row.value, row.note])).toEqual([
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
      statTiles({
        dashboard: onlyBlocked,
        viewerSample: null,
        messages: [],
        providers: [],
        nowMs: T0
      }).find((tile) => tile.id === 'followers')
    ).toMatchObject({ value: '–', detail: 'Reconnect X to show followers.', tone: 'subtle' })
  })

  it('warns on dropped frames in the last minute and lists destinations', () => {
    let dashboard = reduceDashboardHealth(
      live(),
      { sessionId: 's', bitrateKbps: 6000, fps: 30, droppedFrames: 0, createdAt: at(0) },
      at(0)
    )
    dashboard = reduceDashboardHealth(
      dashboard,
      { sessionId: 's', bitrateKbps: 5900, fps: 30, droppedFrames: 12, createdAt: at(30) },
      at(30)
    )
    dashboard = reduceDashboardTargets(
      dashboard,
      {
        sessionId: 's',
        targets: [{ targetId: 'twitch', platform: 'twitch', label: 'Twitch', state: 'live' }]
      },
      at(30)
    )
    const health = statTiles({
      dashboard,
      viewerSample: null,
      messages: [],
      providers: [],
      nowMs: T0 + 40_000
    }).find((tile) => tile.id === 'health')
    expect(health).toMatchObject({
      value: '5,900 kbps',
      detail: '30 fps · 12 dropped/min',
      tone: 'warning'
    })
    expect(health?.destinations).toEqual([{ targetId: 'twitch', label: 'Twitch', state: 'live' }])
  })

  it('summarises a finished session in History', () => {
    const tiles = statTiles({
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
    expect(tiles.find((tile) => tile.id === 'session')).toMatchObject({
      badge: 'history',
      detail: 'Friday launch'
    })
    expect(tiles.find((tile) => tile.id === 'viewers')).toMatchObject({
      label: 'Peak viewers',
      value: '30',
      detail: 'Average 20'
    })
    expect(ids(tiles)).not.toContain('health')
  })
})
