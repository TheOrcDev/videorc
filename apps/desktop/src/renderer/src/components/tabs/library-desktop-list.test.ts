// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CleanCutJob, SessionSummary } from '@/lib/backend'
import { OPEN_CLEAN_CUT_EVENT } from '@/lib/clean-cut-events'

import { LibraryTab } from './library-tab'

// Plan 174 S3.11: the Library is a desktop list (E-16, J1-21), knows Clean cut
// (E-4), says when a search is partial (E-17), deletes only what is in view
// (E-18), keeps the streamer's search (E-19), and never claims "No recordings
// yet" early (J2-8).

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => ({ recording: mocked.recording }),
  useStudioRecording: () => ({ recording: mocked.recording })
}))

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id[0].toUpperCase() + id.slice(1),
    startedAt: '2026-10-03T10:00:00Z',
    durationMs: 600_000,
    status: 'completed',
    mode: 'record',
    mp4Path: `/videos/${id}.mp4`,
    finalizationState: 'finalized',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

// Newest first: alpha is the top row.
const SESSIONS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map(
  (id, index) =>
    session(id, {
      startedAt: `2026-10-0${9 - index}T10:00:00Z`,
      mode: index % 2 === 0 ? 'record' : 'record+stream'
    })
)

let root: Root
let container: HTMLDivElement
const openSession = vi.fn(async (_id: string) => '')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.platform = 'darwin'
  openSession.mockClear()
  ;(window as unknown as { videorc: unknown }).videorc = { openSession }
  mocked.recording = { state: 'idle' }
  mocked.core = {
    sessions: SESSIONS,
    sessionsNextCursor: null,
    sessionsLoadingMore: false,
    loadMoreSessions: vi.fn(async () => undefined),
    sessionStorageTotals: { count: SESSIONS.length, totalBytes: 0 },
    settings: {},
    importRecording: vi.fn(),
    deleteSessions: vi.fn(async () => undefined),
    renameSession: vi.fn(),
    noiseCleanupJobs: [],
    cleanCutJobs: [],
    connection: null,
    ensureSessionPoster: vi.fn(async () => false),
    assessRecording: vi.fn(),
    repairRecording: vi.fn(),
    restoreRecording: vi.fn(),
    wsStatus: 'connected',
    remuxSession: vi.fn(),
    openSessionCommentsWindow: vi.fn(),
    duplicateSession: vi.fn(),
    entitlements: null,
    startNoiseCleanup: vi.fn(),
    cancelNoiseCleanup: vi.fn()
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.platform
  delete (window as unknown as { videorc?: unknown }).videorc
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(LibraryTab, { onOpenBuddyReport: vi.fn(), onOpenCleanCut: vi.fn() })
      )
    )
  )
}

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-videorc-library-row="${id}"]`)
  expect(element, id).toBeTruthy()
  return element!
}

function selectedIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="row"][aria-selected="true"]')].map(
    (element) => element.dataset.videorcLibraryRow ?? ''
  )
}

async function click(element: HTMLElement, init: MouseEventInit = {}): Promise<void> {
  await act(async () =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  )
}

async function key(
  element: HTMLElement,
  value: string,
  init: KeyboardEventInit = {}
): Promise<void> {
  await act(async () =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })
    )
  )
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function labels(items: Element[]): string[] {
  return items.map((item) => item.textContent?.trim() ?? '')
}

describe('Library as a desktop list (E-16, J1-21)', () => {
  it('is a grid of rows with one tab stop, and only the active row keeps its controls in the tab order', async () => {
    await render()
    const grid = document.querySelector('[role="grid"]')
    expect(grid?.getAttribute('aria-multiselectable')).toBe('true')
    expect(grid?.querySelectorAll('[role="columnheader"]')).toHaveLength(7)
    expect(labels([...grid!.querySelectorAll('[role="columnheader"]')]).slice(1, 6)).toEqual([
      'Name',
      'Scene',
      'Duration',
      'Size',
      'File'
    ])
    const rows = [...document.querySelectorAll<HTMLElement>('[data-videorc-library-row]')]
    expect(rows.map((element) => element.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
    expect(rows[0].querySelectorAll('[role="gridcell"]')).toHaveLength(7)
    const firstPlay = rows[0].querySelector<HTMLButtonElement>(
      'button[aria-label="Play recording"]'
    )
    const otherPlay = rows[1].querySelector<HTMLButtonElement>(
      'button[aria-label="Play recording"]'
    )
    expect(firstPlay?.tabIndex).toBe(0)
    expect(otherPlay?.tabIndex).toBe(-1)
    expect(
      rows[1].querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')?.tabIndex
    ).toBe(-1)
    // The checkbox is the row's Space, never its own tab stop.
    expect(rows[0].querySelector<HTMLElement>('[role="checkbox"]')?.tabIndex).toBe(-1)
  })

  it('selects on click, toggles with ⌘ and extends a range with ⇧', async () => {
    await render()
    await click(row('bravo'))
    expect(selectedIds()).toEqual(['bravo'])
    expect(document.body.textContent).toContain('1 selected')
    await click(row('delta'), { metaKey: true })
    expect(selectedIds()).toEqual(['bravo', 'delta'])
    await click(row('echo'), { shiftKey: true })
    expect(selectedIds()).toEqual(['delta', 'echo'])
    await click(row('alpha'))
    expect(selectedIds()).toEqual(['alpha'])
  })

  it('moves with the arrows, selecting as it goes; ⇧ extends; Space toggles; Escape clears', async () => {
    await render()
    await act(async () => row('alpha').focus())
    await key(row('alpha'), 'ArrowDown')
    expect(document.activeElement).toBe(row('bravo'))
    expect(row('bravo').tabIndex).toBe(0)
    expect(selectedIds()).toEqual(['bravo'])
    await key(row('bravo'), 'ArrowDown', { shiftKey: true })
    expect(selectedIds()).toEqual(['bravo', 'charlie'])
    await key(row('charlie'), ' ')
    expect(selectedIds()).toEqual(['bravo'])
    await key(row('charlie'), 'End')
    expect(document.activeElement).toBe(row('golf'))
    await key(row('golf'), 'a', { metaKey: true })
    expect(selectedIds()).toHaveLength(SESSIONS.length)
    await key(row('golf'), 'Escape')
    expect(selectedIds()).toEqual([])
  })

  it('plays on double-click and renames on Return', async () => {
    await render()
    await act(async () =>
      row('charlie').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    )
    expect(openSession).toHaveBeenCalledExactlyOnceWith('charlie')
    await act(async () => row('charlie').focus())
    await key(row('charlie'), 'Enter')
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Recording name"]')
    expect(name?.value).toBe('Charlie')
  })

  it('asks before ⌘⌫ deletes: the row, or the selection it belongs to, named', async () => {
    await render()
    await act(async () => row('bravo').focus())
    await key(row('bravo'), 'Backspace', { metaKey: true })
    expect(byTestId('library-delete-dialog')?.textContent).toMatch(
      /Move this recording to the (Trash|Recycle Bin)\?/
    )
    await act(async () => byTestId('library-delete-cancel')!.click())
    expect(mocked.core.deleteSessions).not.toHaveBeenCalled()

    // Select all seven: the confirm names five and counts the rest.
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Select all recordings in view"]')!.click()
    )
    await key(row('bravo'), 'Backspace', { metaKey: true })
    const names = byTestId('library-delete-names')
    expect(labels([...(names?.querySelectorAll('li') ?? [])])).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'and 2 more'
    ])
    expect(byTestId('library-delete-dialog')?.textContent).toMatch(/Move 7 recordings to the/)
  })

  it('opens the same menu on right-click as on ⋯', async () => {
    await render()
    await act(async () =>
      row('bravo').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    )
    const contextItems = labels([...document.querySelectorAll('[role="menuitem"]')])
    expect(contextItems.some((item) => item.startsWith('Rename…'))).toBe(true)
    expect(contextItems.at(-1)).toMatch(/^Delete/)
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await act(async () =>
      row('bravo')
        .querySelector('button[aria-label="Session actions"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(labels([...document.querySelectorAll('[role="menuitem"]')])).toEqual(contextItems)
  })
})

describe('selection in view (E-18)', () => {
  it('drops hidden rows from the selection and marks a partial header checkbox', async () => {
    await render()
    await click(row('alpha'))
    await click(row('bravo'), { metaKey: true })
    const header = document.querySelector<HTMLElement>(
      '[aria-label="Select all recordings in view"]'
    )!
    expect(header.getAttribute('data-state')).toBe('indeterminate')
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search recordings"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'bra')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(selectedIds()).toEqual(['bravo'])
    expect(document.body.textContent).toContain('1 selected')
  })
})

describe('status and file chips (E-21, E-OD)', () => {
  it('tags MP4 as a fact and flags only a quality problem', async () => {
    mocked.core.sessions = [
      session('alpha'),
      session('bravo', {
        qualityStatus: { status: 'not-hundred-percent', path: '/videos/bravo.mp4', reasons: ['x'] }
      }),
      session('charlie', {
        qualityStatus: { status: 'repaired', path: '/videos/charlie.mp4', interpolated: false }
      })
    ]
    await render()
    const mp4 = [...row('alpha').querySelectorAll('[data-slot="badge"]')].find(
      (badge) => badge.textContent === 'MP4'
    )
    expect(mp4?.getAttribute('data-variant')).toBe('outline')
    expect(row('bravo').querySelector('[data-library-quality]')?.textContent).toBe('Quality issues')
    expect(row('charlie').querySelector('[data-library-quality]')).toBeNull()
    expect(row('alpha').querySelector('[data-library-quality]')).toBeNull()
  })
})

describe('Clean cut in the Library (E-4)', () => {
  const job = (overrides: Partial<CleanCutJob>): CleanCutJob => ({
    id: 'job-1',
    sourceSessionId: 'bravo',
    mode: 'clean',
    state: 'rendering',
    progress: 0.4,
    edlRevision: 1,
    createdAt: '2026-10-03T10:00:00Z',
    updatedAt: '2026-10-03T10:01:00Z',
    ...overrides
  })

  it('shows the job, holds file actions with a reason, and keeps the row out of bulk delete', async () => {
    mocked.core.cleanCutJobs = [job({})]
    await render()
    expect(row('bravo').querySelector('[data-library-clean-cut]')?.textContent).toBe('Cutting 40%')
    expect(
      row('bravo').querySelector<HTMLElement>('[role="checkbox"]')?.hasAttribute('disabled')
    ).toBe(true)
    await act(async () =>
      row('bravo')
        .querySelector('button[aria-label="Session actions"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const remove = items.find((item) => item.textContent?.startsWith('Delete'))!
    const duplicate = items.find((item) => item.textContent === 'Duplicate')!
    expect(remove.hasAttribute('data-disabled')).toBe(true)
    expect(duplicate.hasAttribute('data-disabled')).toBe(true)
    const reason = document.getElementById(remove.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('Cancel or finish Clean cut first.')
    // ⌘⌫ asks nothing for a held row.
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    await act(async () => row('bravo').focus())
    await key(row('bravo'), 'Backspace', { metaKey: true })
    expect(byTestId('library-delete-dialog')).toBeNull()
  })

  it('opens a finished cut in its review', async () => {
    mocked.core.cleanCutJobs = [job({ state: 'completed', progress: 1, mode: 'condensed' })]
    const opened = vi.fn()
    window.addEventListener(OPEN_CLEAN_CUT_EVENT, opened)
    try {
      await render()
      expect(row('bravo').querySelector('[data-library-clean-cut]')).toBeNull()
      await act(async () =>
        row('bravo')
          .querySelector('button[aria-label="Session actions"]')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      )
      const review = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === 'Review clean cut'
      )!
      await act(async () => review.click())
      expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        sessionId: 'bravo',
        mode: 'condensed',
        review: true,
        // Plan 174 S3.13: the review goes back to this row.
        origin: 'library'
      })
    } finally {
      window.removeEventListener(OPEN_CLEAN_CUT_EVENT, opened)
    }
  })
})

describe('partial results and list states (E-17, J2-8)', () => {
  it('says a search only saw the loaded page, and Load all fetches the rest', async () => {
    mocked.core.sessionsNextCursor = 'page-2'
    await render()
    expect(byTestId('library-partial-notice')).toBeNull()
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search recordings"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'zzz')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(byTestId('library-partial-notice')?.textContent).toContain(
      'Searched the 7 newest recordings.'
    )
    expect(document.body.textContent).toContain('No recordings match')
    const loadAll = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load all'
    )!
    await act(async () => loadAll.click())
    expect(mocked.core.loadMoreSessions).toHaveBeenCalled()
    const clear = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear search'
    )!
    await act(async () => clear.click())
    expect(search.value).toBe('')
  })

  it('loads, then reconnects, before it ever says there are no recordings', async () => {
    mocked.core.sessions = []
    mocked.core.sessionStorageTotals = null
    await render()
    expect(document.body.textContent).toContain('Loading recordings…')
    expect(document.body.textContent).not.toContain('No recordings yet')
    mocked.core.wsStatus = 'closed'
    await render()
    expect(document.body.textContent).toContain('Videorc is reconnecting')
    expect(document.body.textContent).not.toContain('No recordings yet')
    mocked.core.wsStatus = 'connected'
    mocked.core.sessionStorageTotals = { count: 0, totalBytes: 0 }
    await render()
    expect(document.body.textContent).toContain('No recordings yet')
  })
})

describe('a finished noise cleanup keeps the search (E-19)', () => {
  it('leaves the streamer’s search alone when the cleaned copy lands', async () => {
    mocked.core.noiseCleanupJobs = [
      { id: 'n1', sourceSessionId: 'alpha', status: 'running', progress: 50, updatedAt: '1' }
    ]
    await render()
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search recordings"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'bra')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocked.core.sessions = [...SESSIONS, session('cleaned', { processingKind: 'noise-cleanup' })]
    mocked.core.noiseCleanupJobs = [
      {
        id: 'n1',
        sourceSessionId: 'alpha',
        status: 'completed',
        progress: 100,
        outputSessionId: 'cleaned',
        updatedAt: '2'
      }
    ]
    await render()
    expect(search.value).toBe('bra')
  })
})
