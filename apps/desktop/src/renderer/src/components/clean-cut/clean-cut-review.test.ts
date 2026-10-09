// @vitest-environment happy-dom
import { act, createElement, useImperativeHandle, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CleanCutReviewTarget } from '@/components/clean-cut/clean-cut-card'
import type { CleanCutClient } from '@/hooks/use-clean-cut'
import type { CleanCutEdl, CleanCutJob, CleanCutRemoval, CleanCutRemovalKind } from '@/lib/backend'
import type { CleanCutTranscriptWord } from '@/lib/clean-cut-view'

import { CleanCutReview } from './clean-cut-review'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { recording: { state: 'idle' } } as Record<string, unknown>,
  report: { payload: null, loading: false, error: null, reload: () => undefined } as Record<
    string,
    unknown
  >,
  skipRanges: [] as Array<unknown>,
  player: {
    togglePlayback: vi.fn(),
    seekTo: vi.fn((_ms: number) => undefined),
    seekBy: vi.fn((_ms: number) => undefined)
  },
  scrollToIndex: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => mocked.recording
}))
vi.mock('@/hooks/use-golem-report', () => ({ useGolemReport: () => mocked.report }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: {
    count: number
    getItemKey?: (index: number) => string | number
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey?.(index) ?? index,
        start: index * 100,
        size: 100,
        end: (index + 1) * 100,
        lane: 0
      })),
    getTotalSize: () => options.count * 100,
    measureElement: () => undefined,
    scrollToIndex: mocked.scrollToIndex
  })
}))
vi.mock('@/components/media/session-player', () => ({
  SessionPlayer: ({
    handleRef,
    skipRanges
  }: {
    handleRef?: Ref<unknown>
    skipRanges?: Array<unknown>
  }) => {
    useImperativeHandle(handleRef, () => mocked.player, [])
    mocked.skipRanges = skipRanges ?? []
    return createElement('div', { 'data-slot': 'player-stub' })
  }
}))

const MIN = 60_000

function removal(
  id: string,
  kind: CleanCutRemovalKind,
  startMs: number,
  endMs: number,
  enabled = true
): CleanCutRemoval {
  return {
    id,
    kind,
    startMs,
    endMs,
    startFrame: Math.round(startMs * 0.03),
    endFrame: Math.round(endMs * 0.03),
    reason: `${kind} reason`,
    enabled
  }
}

function speak(text: string, startMs: number): CleanCutTranscriptWord[] {
  return text.split(' ').map((word, index) => ({
    text: word,
    startMs: startMs + index * 400,
    endMs: startMs + index * 400 + 300
  }))
}

const WORDS = [...speak('So today um we build it.', 1_000), ...speak('We build it again.', 6_300)]
const SEGMENTS = [
  { id: 's1', startMs: 1_000, endMs: 3_300 },
  { id: 's2', startMs: 6_300, endMs: 7_800 }
]
const REMOVALS = [
  removal('r1', 'head', 0, 700),
  removal('r2', 'filler', 1_770, 2_130),
  removal('r3', 'silence', 3_700, 5_900),
  removal('r4', 'retake', 1_000, 3_300, false),
  removal('r5', 'tail', 8_200, 9_000)
]

function edl(removals: CleanCutRemoval[] = REMOVALS): CleanCutEdl {
  return {
    version: 1,
    sourceIdentity: { path: '/videos/rust-cli.mp4', sizeBytes: 1_000 },
    frameRate: { num: 30, den: 1 },
    durationMs: 42 * MIN + 10_000,
    removals,
    stats: { byKind: [], keptMs: 31 * MIN + 5_000 }
  }
}

function job(overrides: Partial<CleanCutJob> = {}): CleanCutJob {
  return {
    id: 'job-1',
    sourceSessionId: 'rec-1',
    mode: 'clean',
    state: 'completed',
    progress: 1,
    edlRevision: 3,
    edlSummary: {
      durationMs: 42 * MIN + 10_000,
      keptMs: 31 * MIN + 5_000,
      removalCount: 5,
      byKind: []
    },
    outputSessionId: 'out-1',
    createdAt: '2026-10-03T15:00:00Z',
    updatedAt: '2026-10-03T15:10:00Z',
    ...overrides
  }
}

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const onOpenLibrarySession = vi.fn()
let statusListener: ((job: CleanCutJob) => void) | null = null

function client(overrides: Partial<CleanCutClient> = {}): CleanCutClient {
  return {
    connected: true,
    jobs: [job()],
    jobsLoaded: true,
    capabilities: null,
    start: vi.fn(),
    cancel: vi.fn(),
    render: vi.fn(async () => job({ state: 'queued', step: 'render', edlRevision: 4 })),
    get: vi.fn(async () => ({ sessionId: 'rec-1', jobs: [{ job: job(), edl: edl() }] })),
    updateEdl: vi.fn(async (params: { revision: number }) => ({
      job: job({ edlRevision: params.revision + 1 }),
      edl: edl()
    })),
    transcript: vi.fn(async () => ({
      jobId: 'job-1',
      language: 'en',
      words: WORDS,
      segments: SEGMENTS
    })),
    subscribe: vi.fn((listener: (job: CleanCutJob) => void) => {
      statusListener = listener
      return () => {
        statusListener = null
      }
    }),
    ...overrides
  } as CleanCutClient
}

let current: CleanCutClient

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

async function render(
  cut: CleanCutClient = client(),
  target: CleanCutReviewTarget = { sessionId: 'rec-1', mode: 'clean', jobId: 'job-1' }
): Promise<void> {
  current = cut
  await act(async () =>
    root.render(
      createElement(CleanCutReview, { client: cut, target, onClose, onOpenLibrarySession })
    )
  )
  await settle()
}

function review(): HTMLElement {
  return document.querySelector('[data-slot="clean-cut-review"]') as HTMLElement
}

function cut(id: string): HTMLElement {
  const element = document.querySelector(`[data-removal-id="${id}"]`) as HTMLElement | null
  expect(element, id).toBeTruthy()
  return element!
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim().startsWith(label)
  )
  expect(match, label).toBeTruthy()
  return match as HTMLButtonElement
}

function footer(): string {
  return document.querySelector('[data-slot="clean-cut-review-status"]')?.textContent ?? ''
}

async function key(keyName: string, init: KeyboardEventInit = {}): Promise<void> {
  const transcript = document.querySelector('[data-slot="clean-cut-paragraph"]') as HTMLElement
  await act(async () => {
    transcript.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...init }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onClose.mockClear()
  onOpenLibrarySession.mockClear()
  mocked.player.togglePlayback.mockClear()
  mocked.player.seekTo.mockClear()
  mocked.player.seekBy.mockClear()
  mocked.scrollToIndex.mockClear()
  mocked.core = {
    sessions: [
      {
        id: 'rec-1',
        title: 'Building a Rust CLI',
        startedAt: '2026-10-03T14:02:00Z',
        durationMs: 42 * MIN + 10_000,
        status: 'completed',
        mode: 'record',
        mp4Path: '/videos/rust-cli.mp4',
        finalizationState: 'finalized'
      }
    ],
    runtimeInfo: { platform: 'darwin' }
  }
  mocked.report = {
    payload: {
      sessionId: 'rec-1',
      report: null,
      moments: [
        {
          startMs: 6_300,
          endMs: 6_300,
          reason: '',
          excerpt: 'We build it again.',
          source: 'manual'
        }
      ],
      chat: { messages: 0, byPlatform: [] }
    },
    loading: false,
    error: null,
    reload: () => undefined
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Clean cut review (plan 119 S14)', () => {
  it('loads the cut list and the transcript, and shows original → cut', async () => {
    await render()
    expect(current.get).toHaveBeenCalledWith('rec-1')
    expect(current.transcript).toHaveBeenCalledWith('job-1')
    expect(document.querySelector('[data-slot="clean-cut-stats"]')?.textContent).toContain(
      '42:10 → 31:05'
    )
    expect(document.querySelector('[data-slot="clean-cut-stats"]')?.textContent).toContain(
      '11:05 shorter'
    )
    expect(review().textContent).toContain('So today')
    // It opens ready for the keys.
    expect(document.activeElement).toBe(review())
    expect(cut('r2').getAttribute('data-cut')).toBe('on')
    expect(cut('r4').getAttribute('data-cut')).toBe('off')
    // The chips count every kind, suggestions included.
    const chips = [...document.querySelectorAll('[data-chip]')].map((chip) => [
      chip.getAttribute('data-chip'),
      chip.getAttribute('data-state-kind')
    ])
    expect(chips).toEqual([
      ['silences', 'on'],
      ['fillers', 'on'],
      ['retakes', 'off'],
      ['false-starts', 'empty'],
      ['start-end', 'on']
    ])
    // The moment is a pin, and a click on it seeks there.
    const pin = document.querySelector('[data-pin="manual"]') as HTMLElement
    expect(pin.textContent).toContain('Marked')
    await act(async () => pin.click())
    expect(mocked.player.seekTo).toHaveBeenCalledWith(6_300)
  })

  it('previews the cut by skipping what is cut, or plays the original', async () => {
    await render()
    expect(mocked.skipRanges).toEqual([
      { startMs: 0, endMs: 700 },
      { startMs: 1_770, endMs: 2_130 },
      { startMs: 3_700, endMs: 5_900 },
      { startMs: 8_200, endMs: 9_000 }
    ])
    const original = [...document.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === 'Original'
    ) as HTMLElement
    await act(async () => {
      original.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    expect(mocked.skipRanges).toEqual([])
  })

  it('toggles a cut with a click, and saves it as one updateEdl, then cuts again', async () => {
    await render()
    await act(async () => cut('r2').click())
    expect(cut('r2').getAttribute('data-cut')).toBe('off')
    expect(footer()).toBe('1 unsaved change')
    expect(mocked.skipRanges).not.toContainEqual({ startMs: 1_770, endMs: 2_130 })

    await act(async () => button('Save changes').click())
    await settle()
    expect(current.updateEdl).toHaveBeenCalledExactlyOnceWith({
      jobId: 'job-1',
      revision: 3,
      removals: [{ id: 'r2', enabled: false }]
    })
    expect(current.render).toHaveBeenCalledExactlyOnceWith('job-1')
    expect(footer()).toBe('Waiting to cut')

    // Render progress arrives as status events.
    await act(async () => statusListener?.(job({ state: 'rendering', progress: 0.63 })))
    expect(footer()).toBe('Cutting 63%')
  })

  it('cuts or keeps a whole kind from its chip', async () => {
    await render()
    const retakes = document.querySelector('[data-chip="retakes"]') as HTMLElement
    await act(async () => retakes.click())
    expect(cut('r4').getAttribute('data-cut')).toBe('on')
    await act(async () => button('Save changes').click())
    await settle()
    expect(current.updateEdl).toHaveBeenCalledWith({
      jobId: 'job-1',
      revision: 3,
      removals: [{ id: 'r4', enabled: true }]
    })
  })

  it('reloads after a revision conflict and keeps the draft on the newest list', async () => {
    const conflict = Object.assign(new Error('The cut list changed.'), {
      code: 'edl-revision-conflict'
    })
    const updateEdl = vi.fn().mockRejectedValueOnce(conflict)
    const get = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'rec-1', jobs: [{ job: job(), edl: edl() }] })
      .mockResolvedValueOnce({
        sessionId: 'rec-1',
        jobs: [{ job: job({ edlRevision: 5 }), edl: edl() }]
      })
    await render(client({ updateEdl, get }))
    await act(async () => cut('r2').click())
    await act(async () => button('Save changes').click())
    await settle()
    expect(get).toHaveBeenCalledTimes(2)
    expect(current.render).not.toHaveBeenCalled()
    expect(footer()).toContain('The cut list changed while you edited')
    expect(cut('r2').getAttribute('data-cut')).toBe('off')

    updateEdl.mockResolvedValueOnce({ job: job({ edlRevision: 6 }), edl: edl() })
    await act(async () => button('Save changes').click())
    await settle()
    expect(updateEdl).toHaveBeenLastCalledWith({
      jobId: 'job-1',
      revision: 5,
      removals: [{ id: 'r2', enabled: false }]
    })
  })

  it('waits for a cut in progress before saving', async () => {
    await render(
      client({
        get: vi.fn(async () => ({
          sessionId: 'rec-1',
          jobs: [{ job: job({ state: 'rendering', progress: 0.2 }), edl: edl() }]
        }))
      })
    )
    await act(async () => cut('r2').click())
    expect(button('Save changes').disabled).toBe(true)
    await key('s', { metaKey: true })
    expect(current.updateEdl).not.toHaveBeenCalled()
    expect(footer()).toBe('You can save when this cut finishes.')
  })

  it('is keyboard-first: arrows walk the cuts, Enter toggles, Space plays, ⌘S saves', async () => {
    await render()
    await key('ArrowDown')
    // From the playhead (0): the start cut, with the playhead a moment before it.
    expect(cut('r1').getAttribute('data-selected')).toBe('true')
    expect(mocked.player.seekTo).toHaveBeenLastCalledWith(0)
    await key('ArrowDown')
    await key('ArrowDown')
    expect(cut('r2').getAttribute('data-selected')).toBe('true')
    expect(mocked.scrollToIndex).toHaveBeenCalled()
    await key('Enter')
    expect(cut('r2').getAttribute('data-cut')).toBe('off')
    await key(' ')
    expect(mocked.player.togglePlayback).toHaveBeenCalledTimes(1)
    await key('ArrowRight')
    expect(mocked.player.seekBy).toHaveBeenLastCalledWith(5_000)
    await key('ArrowLeft')
    expect(mocked.player.seekBy).toHaveBeenLastCalledWith(-5_000)
    await key('s', { metaKey: true })
    await settle()
    expect(current.updateEdl).toHaveBeenCalledWith({
      jobId: 'job-1',
      revision: 3,
      removals: [{ id: 'r2', enabled: false }]
    })
  })

  it('seeks to a word on click', async () => {
    await render()
    const word = [...document.querySelectorAll('[data-seek-ms]')].find(
      (element) => element.textContent === 'again.'
    ) as HTMLElement
    await act(async () => word.click())
    expect(mocked.player.seekTo).toHaveBeenCalledWith(Number(word.dataset.seekMs))
  })

  it('asks before leaving unsaved changes, and discards on request', async () => {
    await render()
    await act(async () => button('Golem').click())
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    await act(async () => cut('r2').click())
    await act(async () => button('Golem').click())
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Leave without saving?'
    )
    await act(async () => button('Discard changes').click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('waits for the cut list when there is none yet', async () => {
    await render(
      client({
        get: vi.fn(async () => ({
          sessionId: 'rec-1',
          jobs: [{ job: job({ state: 'transcribing', progress: 0.4, edlSummary: undefined }) }]
        }))
      })
    )
    expect(
      document.querySelector('[data-testid="clean-cut-review-waiting"]')?.textContent
    ).toContain('Transcribing 40%')
    expect(current.transcript).not.toHaveBeenCalled()
  })
})

describe('Condensed review (plan 119 S19)', () => {
  const keeps = [
    { startMs: 0, endMs: 2 * MIN, title: 'Intro' },
    { startMs: 10 * MIN, endMs: 14 * MIN, title: 'Deploying to Vercel' }
  ]
  const words = [
    ...speak('Welcome back everyone.', 1_000),
    ...speak('This part is left out.', 5 * MIN),
    ...speak('Now we deploy.', 10 * MIN + 500)
  ]
  const removals = [
    removal('c1', 'condensed', 2 * MIN, 10 * MIN),
    removal('c2', 'condensed', 14 * MIN, 20 * MIN)
  ]
  const condensedJob = job({ id: 'job-c', mode: 'condensed' })

  beforeEach(() => {
    mocked.report = { payload: null, loading: false, error: null, reload: () => undefined }
  })

  function condensedClient(): CleanCutClient {
    return client({
      jobs: [condensedJob],
      get: vi.fn(async () => ({
        sessionId: 'rec-1',
        jobs: [
          {
            job: condensedJob,
            edl: {
              ...edl(removals),
              durationMs: 20 * MIN,
              stats: { byKind: [], keptMs: 6 * MIN }
            },
            condensedKeeps: keeps
          }
        ]
      })),
      transcript: vi.fn(async () => ({ jobId: 'job-c', language: 'en', words, segments: [] }))
    })
  }

  function paragraphs(): string[] {
    return [...document.querySelectorAll('[data-slot="clean-cut-paragraph"]')].map(
      (paragraph) => paragraph.textContent?.trim() ?? ''
    )
  }

  function blockTexts(): string[] {
    return [...document.querySelectorAll('[data-slot="clean-cut-block"]')].map(
      (block) => block.textContent ?? ''
    )
  }

  function blocks(): Array<[string | null, string | null]> {
    return [...document.querySelectorAll('[data-slot="clean-cut-block"]')].map((block) => [
      block.getAttribute('data-block'),
      block.getAttribute('data-removed')
    ])
  }

  it('shows the kept parts with their titles and the parts left out as single rows', async () => {
    await render(condensedClient(), { sessionId: 'rec-1', mode: 'condensed', jobId: 'job-c' })
    expect(blocks()).toEqual([
      ['kept', null],
      ['left-out', 'true'],
      ['kept', null],
      ['left-out', 'true']
    ])
    const text = review().textContent ?? ''
    expect(text).toContain('Intro')
    expect(text).toContain('Deploying to Vercel')
    expect(paragraphs()).toEqual(['Welcome back everyone.', 'Now we deploy.'])
    // A left-out part is one row with its first words, not ten thousand struck ones.
    expect(blockTexts()[1]).toContain('This part is left out.')
    expect(document.querySelector('[data-slot="clean-cut-stats"]')?.textContent).toContain(
      '20:00 → 6:00'
    )
  })

  it('brings a part back and drops a kept one, saved as one updateEdl', async () => {
    await render(condensedClient(), { sessionId: 'rec-1', mode: 'condensed', jobId: 'job-c' })
    await act(async () => button('Bring back').click())
    expect(blocks()[1]).toEqual(['left-out', null])
    expect(paragraphs()).toContain('This part is left out.')
    const drop = [...document.querySelectorAll('button')].filter(
      (candidate) => candidate.textContent === 'Drop'
    )[0] as HTMLButtonElement
    await act(async () => drop.click())
    expect(blocks()[0]).toEqual(['kept', 'true'])
    await act(async () => button('Save changes').click())
    await settle()
    expect(current.updateEdl).toHaveBeenCalledExactlyOnceWith({
      jobId: 'job-c',
      revision: 3,
      removals: [{ id: 'c1', enabled: false }],
      addManual: [{ startMs: 0, endMs: 2 * MIN }]
    })
  })
})
