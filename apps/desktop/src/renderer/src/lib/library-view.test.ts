import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '@/lib/backend'
import {
  filterLibrarySessions,
  isLiveSession,
  libraryStorageLabel,
  liveSessionLabel,
  sessionFormatLabel,
  sessionPosterUrl,
  sortLibrarySessions,
  toggleAllLibrarySelection,
  toggleLibrarySelection
} from './library-view'

const session = (overrides: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 'id',
    title: 'Weekly Dev Update',
    startedAt: '2026-07-01T10:00:00Z',
    status: 'completed',
    mode: 'record',
    layout: {},
    sources: {},
    healthEvents: [],
    sessionLogs: [],
    aiArtifacts: [],
    commentCount: 0,
    ...overrides
  }) as unknown as SessionSummary

describe('filter + search + sort', () => {
  // The modes the backend writes (`output_mode` in recording.rs), plus an
  // imported file (plan 174, E-1: the old fixtures used modes it never wrote).
  const sessions = [
    session({ id: 'a', mode: 'record', title: 'Weekly Dev Update' }),
    session({ id: 'b', mode: 'stream', title: 'Community Q&A' }),
    session({ id: 'c', mode: 'record+stream', title: 'Behind the Build' }),
    session({ id: 'd', mode: 'imported', title: 'Conference Talk' })
  ]

  it('filters by mode family', () => {
    expect(filterLibrarySessions(sessions, 'recordings', '').map((s) => s.id)).toEqual([
      'a',
      'c',
      'd'
    ])
    expect(filterLibrarySessions(sessions, 'streams', '').map((s) => s.id)).toEqual(['b', 'c'])
    expect(filterLibrarySessions(sessions, 'all', '')).toHaveLength(4)
  })

  it('still files older rows by their old spelling', () => {
    const older = [
      session({ id: 'old-recording', mode: 'recording' }),
      session({ id: 'old-stream', mode: 'streaming' })
    ]
    expect(filterLibrarySessions(older, 'recordings', '').map((s) => s.id)).toEqual([
      'old-recording'
    ])
    expect(filterLibrarySessions(older, 'streams', '').map((s) => s.id)).toEqual(['old-stream'])
  })

  it('searches titles case-insensitively', () => {
    expect(filterLibrarySessions(sessions, 'all', 'community').map((s) => s.id)).toEqual(['b'])
    expect(filterLibrarySessions(sessions, 'recordings', 'BUILD').map((s) => s.id)).toEqual(['c'])
  })

  it('sorts by startedAt both ways without mutating', () => {
    const shuffled = [
      session({ id: 'old', startedAt: '2026-06-01T00:00:00Z' }),
      session({ id: 'new', startedAt: '2026-07-01T00:00:00Z' })
    ]
    expect(sortLibrarySessions(shuffled, 'newest')[0]!.id).toBe('new')
    expect(sortLibrarySessions(shuffled, 'oldest')[0]!.id).toBe('old')
    expect(shuffled[0]!.id).toBe('old')
  })
})

describe('sessionFormatLabel', () => {
  it('names the visible file honestly', () => {
    expect(sessionFormatLabel(session({ mp4Path: '/x.mp4' }))).toBe('MP4')
    expect(sessionFormatLabel(session({ container: 'mkv' as never }))).toBe('MKV')
    expect(sessionFormatLabel(session({ container: 'tee' as never }))).toBe('MKV + stream')
    expect(sessionFormatLabel(session({}))).toBeNull()
  })
})

describe('sessionPosterUrl', () => {
  it('builds the token-authenticated backend URL with a cache buster', () => {
    const url = sessionPosterUrl({ port: 4620, token: 'tok' }, { id: 'ab/12', durationMs: 9000 })!
    expect(url).toContain('http://127.0.0.1:4620/sessions/ab%2F12/poster?')
    expect(url).toContain('token=tok')
    expect(url).toContain('v=9000')
    expect(sessionPosterUrl(null, { id: 'x', durationMs: 1 })).toBeNull()
  })
})

describe('selection', () => {
  it('toggles one id and select-all over the VISIBLE set', () => {
    expect(toggleLibrarySelection([], 'a')).toEqual(['a'])
    expect(toggleLibrarySelection(['a'], 'a')).toEqual([])
    expect(toggleAllLibrarySelection([], ['a', 'b'])).toEqual(['a', 'b'])
    expect(toggleAllLibrarySelection(['a', 'b'], ['a', 'b'])).toEqual([])
    expect(toggleAllLibrarySelection(['a'], ['a', 'b'])).toEqual(['a', 'b'])
    expect(toggleAllLibrarySelection(['a'], [])).toEqual([])
  })
})

describe('isLiveSession', () => {
  it('is live only for the running row that matches the active capture', () => {
    const row = { id: 'live-1', status: 'running' }
    expect(isLiveSession(row, { state: 'recording', sessionId: 'live-1' })).toBe(true)
    expect(isLiveSession(row, { state: 'streaming', sessionId: 'live-1' })).toBe(true)
    expect(isLiveSession(row, { state: 'stopping', sessionId: 'live-1' })).toBe(true)
    // Stale 'running' row from a dead backend: no matching active capture.
    expect(isLiveSession(row, { state: 'recording', sessionId: 'other' })).toBe(false)
    expect(isLiveSession(row, { state: 'idle', sessionId: 'live-1' })).toBe(false)
    expect(isLiveSession(row, { state: 'idle', sessionId: undefined })).toBe(false)
    expect(
      isLiveSession(
        { id: 'live-1', status: 'completed' },
        { state: 'recording', sessionId: 'live-1' }
      )
    ).toBe(false)
    expect(
      isLiveSession({ id: 'live-1', status: 'failed' }, { state: 'recording', sessionId: 'live-1' })
    ).toBe(false)
  })
})

describe('liveSessionLabel', () => {
  it('labels the capture state for the live row', () => {
    expect(liveSessionLabel({ state: 'recording' })).toBe('Recording')
    expect(liveSessionLabel({ state: 'starting' })).toBe('Recording')
    expect(liveSessionLabel({ state: 'streaming' })).toBe('Streaming')
    expect(liveSessionLabel({ state: 'stopping' })).toBe('Finishing')
  })

  it('labels Go Live (record+stream, reported as recording) as Streaming (plan 095 S5)', () => {
    expect(
      liveSessionLabel({ state: 'recording', streamUrl: 'rtmp://live.twitch.tv/app/***' })
    ).toBe('Streaming')
  })
})

describe('libraryStorageLabel', () => {
  it('states real totals and free space, no invented quota', () => {
    expect(
      libraryStorageLabel({ count: 32, totalBytes: 175 * 1024 ** 3, freeBytes: 500 * 1024 ** 3 })
    ).toBe('32 sessions · 175 GB of recordings · 500 GB free')
    expect(libraryStorageLabel({ count: 1, totalBytes: 0, freeBytes: null })).toBe(
      '1 session · 0 B of recordings'
    )
  })
})
