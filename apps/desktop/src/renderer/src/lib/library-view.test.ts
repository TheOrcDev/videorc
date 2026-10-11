import { describe, expect, it } from 'vitest'

import type { CleanCutJob, SessionSummary } from '@/lib/backend'
import {
  CLEAN_CUT_HOLD_REASON,
  activeCleanCutJobsBySource,
  filterLibrarySessions,
  isLiveSession,
  libraryCleanCutChip,
  libraryCleanCutReviews,
  libraryClearLabel,
  libraryDeleteNames,
  libraryKeyCommand,
  libraryListState,
  libraryPartialNotice,
  libraryPickModifier,
  libraryQualityChip,
  libraryRowAfterMove,
  librarySelectAllState,
  libraryStorageLabel,
  libraryTitle,
  pickLibraryRow,
  pruneLibrarySelection,
  revealsFinishedCleanup,
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

describe('libraryStorageLabel', () => {
  it('states real totals and free space, no invented quota', () => {
    expect(
      libraryStorageLabel({ count: 32, totalBytes: 175 * 1024 ** 3, freeBytes: 500 * 1024 ** 3 })
    ).toBe('32 recordings · 175 GB · 500 GB free')
    expect(libraryStorageLabel({ count: 1, totalBytes: 0, freeBytes: null })).toBe(
      '1 recording · 0 B'
    )
  })
})

// Plan 174 S3.11: the Library as a desktop list.
describe('what the list shows (J2-8, E-17)', () => {
  it('never claims "No recordings yet" before the first page or while reconnecting', () => {
    expect(libraryListState({ count: 0, loaded: false, online: true })).toBe('loading')
    expect(libraryListState({ count: 0, loaded: false, online: false })).toBe('offline')
    expect(libraryListState({ count: 0, loaded: true, online: false })).toBe('offline')
    expect(libraryListState({ count: 0, loaded: true, online: true })).toBe('empty')
    expect(libraryListState({ count: 3, loaded: false, online: false })).toBe('rows')
  })

  it('says a search, a filter or the oldest-first sort only saw the loaded pages', () => {
    const base = {
      loadedCount: 50,
      hasMore: true,
      filter: 'all' as const,
      query: '',
      sort: 'newest' as const
    }
    expect(libraryPartialNotice(base)).toBeNull()
    expect(libraryPartialNotice({ ...base, query: 'rust' })).toBe(
      'Searched the 50 newest recordings.'
    )
    expect(libraryPartialNotice({ ...base, filter: 'streams' })).toBe(
      'Filtered the 50 newest recordings.'
    )
    expect(libraryPartialNotice({ ...base, sort: 'oldest' })).toBe(
      'Sorted the 50 newest recordings.'
    )
    expect(libraryPartialNotice({ ...base, query: 'rust', hasMore: false })).toBeNull()
    expect(libraryPartialNotice({ ...base, query: '   ' })).toBeNull()
  })

  it('names what the no-results button clears', () => {
    expect(libraryClearLabel('all', 'rust')).toBe('Clear search')
    expect(libraryClearLabel('streams', '')).toBe('Clear filter')
    expect(libraryClearLabel('streams', 'rust')).toBe('Clear search and filter')
  })

  it('shows a finished noise cleanup only when that keeps the search and filter (E-19)', () => {
    expect(revealsFinishedCleanup('all', '')).toBe(true)
    expect(revealsFinishedCleanup('all', 'rust')).toBe(false)
    expect(revealsFinishedCleanup('recordings', '')).toBe(false)
  })

  it('names an untitled recording as a recording, never a session', () => {
    expect(libraryTitle({ title: '  ' })).toBe('Untitled recording')
    expect(libraryTitle({ title: 'Rust tutorial' })).toBe('Rust tutorial')
  })
})

describe('desktop selection (E-16, E-18)', () => {
  const ordered = ['a', 'b', 'c', 'd', 'e']
  const selectable = new Set(['a', 'b', 'd', 'e'])
  const pick = (
    current: { selected: string[]; anchor: string | null },
    id: string,
    modifier: 'replace' | 'toggle' | 'range'
  ) => pickLibraryRow(current, { id, modifier, orderedIds: ordered, selectable })

  it('a plain click selects only that row and sets the anchor', () => {
    expect(pick({ selected: ['a', 'b'], anchor: 'a' }, 'd', 'replace')).toEqual({
      selected: ['d'],
      anchor: 'd'
    })
    // A row that can't be selected clears the selection but still anchors.
    expect(pick({ selected: ['a'], anchor: 'a' }, 'c', 'replace')).toEqual({
      selected: [],
      anchor: 'c'
    })
  })

  it('⌘-click toggles one row; ⇧-click selects the range from the anchor, skipping locked rows', () => {
    expect(pick({ selected: ['a'], anchor: 'a' }, 'd', 'toggle')).toEqual({
      selected: ['a', 'd'],
      anchor: 'd'
    })
    expect(pick({ selected: ['a', 'd'], anchor: 'd' }, 'a', 'toggle').selected).toEqual(['d'])
    expect(pick({ selected: ['a'], anchor: 'a' }, 'c', 'toggle').selected).toEqual(['a'])
    expect(pick({ selected: ['a'], anchor: 'a' }, 'e', 'range')).toEqual({
      selected: ['a', 'b', 'd', 'e'],
      anchor: 'a'
    })
    expect(pick({ selected: [], anchor: 'e' }, 'b', 'range').selected).toEqual(['b', 'd', 'e'])
    // No anchor yet: a range is a plain pick.
    expect(pick({ selected: [], anchor: null }, 'b', 'range')).toEqual({
      selected: ['b'],
      anchor: 'b'
    })
  })

  it('reads the click modifier per platform', () => {
    const click = { shiftKey: false, metaKey: false, ctrlKey: false }
    expect(libraryPickModifier(click, 'darwin')).toBe('replace')
    expect(libraryPickModifier({ ...click, metaKey: true }, 'darwin')).toBe('toggle')
    expect(libraryPickModifier({ ...click, ctrlKey: true }, 'win32')).toBe('toggle')
    expect(libraryPickModifier({ ...click, shiftKey: true, metaKey: true }, 'darwin')).toBe('range')
  })

  it('moves with the arrows, Home and End, and stops at the ends', () => {
    expect(libraryRowAfterMove(ordered, 'b', 'next')).toBe('c')
    expect(libraryRowAfterMove(ordered, 'b', 'previous')).toBe('a')
    expect(libraryRowAfterMove(ordered, 'a', 'previous')).toBe('a')
    expect(libraryRowAfterMove(ordered, 'e', 'next')).toBe('e')
    expect(libraryRowAfterMove(ordered, 'c', 'first')).toBe('a')
    expect(libraryRowAfterMove(ordered, 'c', 'last')).toBe('e')
    expect(libraryRowAfterMove(ordered, null, 'next')).toBe('a')
    expect(libraryRowAfterMove([], 'a', 'next')).toBeNull()
  })

  it('maps the row keys, with ⌘ on macOS and Ctrl elsewhere', () => {
    const key = (
      value: string,
      extra: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}
    ) => ({
      key: value,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...extra
    })
    expect(libraryKeyCommand(key('ArrowDown'), 'darwin')).toEqual({
      kind: 'move',
      move: 'next',
      extend: false
    })
    expect(libraryKeyCommand(key('ArrowUp', { shiftKey: true }), 'darwin')).toEqual({
      kind: 'move',
      move: 'previous',
      extend: true
    })
    expect(libraryKeyCommand(key('End'), 'darwin')).toEqual({
      kind: 'move',
      move: 'last',
      extend: false
    })
    expect(libraryKeyCommand(key(' '), 'darwin')).toEqual({ kind: 'toggle' })
    expect(libraryKeyCommand(key('Enter'), 'darwin')).toEqual({ kind: 'rename' })
    expect(libraryKeyCommand(key('Escape'), 'darwin')).toEqual({ kind: 'clear' })
    expect(libraryKeyCommand(key('Backspace', { metaKey: true }), 'darwin')).toEqual({
      kind: 'delete'
    })
    expect(libraryKeyCommand(key('Backspace', { ctrlKey: true }), 'win32')).toEqual({
      kind: 'delete'
    })
    expect(libraryKeyCommand(key('Delete'), 'win32')).toEqual({ kind: 'delete' })
    expect(libraryKeyCommand(key('Backspace'), 'darwin')).toBeNull()
    expect(libraryKeyCommand(key('a', { metaKey: true }), 'darwin')).toEqual({
      kind: 'select-all'
    })
    expect(libraryKeyCommand(key('a', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(libraryKeyCommand(key('ArrowDown', { altKey: true }), 'darwin')).toBeNull()
    expect(libraryKeyCommand(key('k'), 'darwin')).toBeNull()
  })

  it('prunes rows the view hides, and reads the header checkbox state', () => {
    expect(pruneLibrarySelection(['a', 'x', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b'])
    expect(librarySelectAllState([], ['a', 'b'])).toBe(false)
    expect(librarySelectAllState(['a'], ['a', 'b'])).toBe('indeterminate')
    expect(librarySelectAllState(['b', 'a'], ['a', 'b'])).toBe(true)
    expect(librarySelectAllState(['x'], ['a', 'b'])).toBe(false)
  })

  it('names up to five recordings a bulk delete takes, then counts the rest', () => {
    const titles = ['One', 'Two', '', 'Four', 'Five', 'Six', 'Seven'].map((title) => ({ title }))
    expect(libraryDeleteNames(titles)).toEqual({
      names: ['One', 'Two', 'Untitled recording', 'Four', 'Five'],
      more: 2
    })
    expect(libraryDeleteNames(titles.slice(0, 2))).toEqual({ names: ['One', 'Two'], more: 0 })
  })
})

describe('quality chip (E-OD: problem states only)', () => {
  it('is quiet when fine and says so when not', () => {
    expect(libraryQualityChip(null)).toBeNull()
    expect(libraryQualityChip({ status: 'ready', path: '/x.mp4' })).toBeNull()
    expect(
      libraryQualityChip({ status: 'repaired', path: '/x.mp4', interpolated: false })
    ).toBeNull()
    expect(
      libraryQualityChip({ status: 'not-hundred-percent', path: '/x.mp4', reasons: ['frames'] })
        ?.label
    ).toBe('Quality issues')
    expect(
      libraryQualityChip({ status: 'failed', path: '/x.mp4', reason: 'ffprobe: EOF' })
    ).toEqual(expect.objectContaining({ label: 'Not checked' }))
    // Raw backend text never reaches the chip.
    expect(
      libraryQualityChip({ status: 'failed', path: '/x.mp4', reason: 'ffprobe: EOF' })?.detail
    ).not.toContain('ffprobe')
  })
})

describe('Clean cut in the Library (E-4)', () => {
  const job = (overrides: Partial<CleanCutJob>): CleanCutJob => ({
    id: 'job',
    sourceSessionId: 'tutorial',
    mode: 'clean',
    state: 'rendering',
    progress: 0.4,
    edlRevision: 1,
    createdAt: '2026-10-03T10:00:00Z',
    updatedAt: '2026-10-03T10:01:00Z',
    ...overrides
  })

  it('holds the recordings a worker owns, keeping the newest job per source', () => {
    const held = activeCleanCutJobsBySource([
      job({ id: 'old', state: 'transcribing', createdAt: '2026-10-03T09:00:00Z' }),
      job({ id: 'new', state: 'rendering' }),
      job({ id: 'done', sourceSessionId: 'stream', state: 'completed' }),
      job({ id: 'ready', sourceSessionId: 'talk', state: 'ready' })
    ])
    expect(held.get('tutorial')?.id).toBe('new')
    expect(held.has('stream')).toBe(false)
    expect(held.get('talk')?.id).toBe('ready')
    expect(CLEAN_CUT_HOLD_REASON).toBe('Cancel or finish Clean cut first.')
  })

  it('reads "Cut queued" before it starts and "Cutting 40%" after', () => {
    expect(libraryCleanCutChip({ state: 'queued', progress: 0 })).toEqual({
      label: 'Cut queued',
      working: false
    })
    expect(libraryCleanCutChip({ state: 'rendering', progress: 0.4 })).toEqual({
      label: 'Cutting 40%',
      working: true
    })
    expect(libraryCleanCutChip({ state: 'validating', progress: 1 }).label).toBe('Cutting 99%')
  })

  it('offers the review once a cut exists, from its job or its copy in the Library', () => {
    const sessions = [
      {
        cleanCutOfSessionId: 'stream',
        cleanCutMode: 'condensed' as const,
        startedAt: '2026-10-02T21:00:00Z'
      },
      {
        cleanCutOfSessionId: 'tutorial',
        cleanCutMode: undefined,
        startedAt: '2026-10-03T11:00:00Z'
      }
    ]
    expect(libraryCleanCutReviews({ jobs: [job({})], sessions: [] }).size).toBe(0)
    const reviews = libraryCleanCutReviews({
      jobs: [job({ state: 'completed', mode: 'condensed' })],
      sessions
    })
    // The finished job wins over the copy's mode; a copy alone is enough.
    expect(reviews.get('tutorial')).toBe('condensed')
    expect(reviews.get('stream')).toBe('condensed')
    expect(libraryCleanCutReviews({ jobs: [], sessions }).get('tutorial')).toBe('clean')
  })
})
