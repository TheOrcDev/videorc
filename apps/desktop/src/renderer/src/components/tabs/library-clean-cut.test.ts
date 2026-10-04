// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceNavContext } from '@/components/workspace-nav'
import type { CleanCutSession } from '@/lib/clean-cut-view'

import { LibraryTab } from './library-tab'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => ({ recording: mocked.recording }),
  useStudioRecording: () => ({ recording: mocked.recording })
}))

let root: Root
let container: HTMLDivElement
const onOpenOrcleReport = vi.fn((_sessionId: string) => undefined)
const onOpenCleanCut = vi.fn((_sessionId: string) => undefined)

function session(overrides: Partial<CleanCutSession>): CleanCutSession {
  return {
    id: 'tutorial',
    title: 'Rust tutorial',
    startedAt: '2026-10-03T10:00:00Z',
    durationMs: 600_000,
    status: 'completed',
    mode: 'record',
    mp4Path: '/videos/tutorial.mp4',
    finalizationState: 'finalized',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

const SESSIONS: CleanCutSession[] = [
  session({}),
  session({
    id: 'stream',
    title: 'Friday stream',
    mode: 'record+stream',
    startedAt: '2026-10-02T18:00:00Z'
  }),
  session({
    id: 'stream-only',
    title: 'Q&A',
    mode: 'stream',
    mp4Path: undefined,
    startedAt: '2026-10-02T10:00:00Z'
  }),
  session({
    id: 'short',
    title: 'Mic check',
    durationMs: 4_000,
    startedAt: '2026-10-01T10:00:00Z'
  }),
  session({
    id: 'imported',
    title: 'Old video',
    mode: 'imported',
    startedAt: '2026-09-30T10:00:00Z'
  }),
  session({
    id: 'cut',
    title: 'Rust tutorial (Clean cut)',
    startedAt: '2026-10-03T11:00:00Z',
    derivedFromSessionId: 'tutorial',
    sourceTitle: 'Rust tutorial',
    cleanCutOfSessionId: 'tutorial',
    cleanCutMode: 'clean'
  }),
  session({
    id: 'condensed',
    title: 'Friday stream (Condensed)',
    startedAt: '2026-10-02T21:00:00Z',
    mode: 'record+stream',
    derivedFromSessionId: 'stream',
    sourceTitle: 'Friday stream',
    cleanCutOfSessionId: 'stream',
    cleanCutMode: 'condensed'
  })
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onOpenOrcleReport.mockClear()
  onOpenCleanCut.mockClear()
  mocked.recording = { state: 'idle' }
  mocked.core = {
    sessions: SESSIONS,
    sessionsNextCursor: null,
    sessionsLoadingMore: false,
    loadMoreSessions: vi.fn(),
    sessionStorageTotals: null,
    settings: {},
    importRecording: vi.fn(),
    deleteSessions: vi.fn(),
    renameSession: vi.fn(),
    noiseCleanupJobs: [],
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
  vi.unstubAllGlobals()
})

async function render(focusSessionId: string | null = null): Promise<void> {
  const nav = {
    active: 'library' as const,
    setActive: vi.fn(),
    activeStudioPanel: null,
    openStudioPanel: vi.fn(),
    closeStudioPanel: vi.fn(),
    openSettings: vi.fn()
  }
  await act(async () =>
    root.render(
      createElement(
        WorkspaceNavContext.Provider,
        { value: nav },
        createElement(
          TooltipProvider,
          null,
          createElement(LibraryTab, { onOpenOrcleReport, onOpenCleanCut, focusSessionId })
        )
      )
    )
  )
}

function row(sessionId: string): HTMLElement {
  const element = document.querySelector(`[data-videorc-library-row="${sessionId}"]`) as HTMLElement
  expect(element, sessionId).toBeTruthy()
  return element
}

async function openMenu(sessionId: string): Promise<HTMLElement[]> {
  const trigger = row(sessionId).querySelector(
    'button[aria-label="Session actions"]'
  ) as HTMLElement
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
}

async function closeMenu(): Promise<void> {
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
}

function labels(items: HTMLElement[]): string[] {
  return items.map((item) => item.textContent?.trim() ?? '')
}

describe('Library → Clean cut (plan 119 S14)', () => {
  it('opens the Orcle tab on an eligible recording, right after Play and the report', async () => {
    await render()
    const recording = await openMenu('tutorial')
    expect(labels(recording).slice(0, 2)).toEqual(['Play', 'Clean cut'])
    await act(async () => recording[1].click())
    expect(onOpenCleanCut).toHaveBeenCalledExactlyOnceWith('tutorial')

    const streamed = await openMenu('stream')
    expect(labels(streamed).slice(0, 3)).toEqual(['Play', 'Orcle report', 'Clean cut'])
    await closeMenu()
  })

  it('offers no Clean cut where the backend would refuse one', async () => {
    await render()
    for (const id of ['stream-only', 'short', 'imported', 'cut', 'condensed']) {
      expect(labels(await openMenu(id)), id).not.toContain('Clean cut')
      await closeMenu()
    }
  })

  it('labels a cut copy and says what it was cut from', async () => {
    await render()
    expect(row('cut').querySelector('[data-clean-cut="clean"]')?.textContent).toBe('Clean cut')
    expect(row('cut').textContent).toContain('· cut from Rust tutorial')
    expect(row('condensed').querySelector('[data-clean-cut="condensed"]')?.textContent).toBe(
      'Condensed'
    )
    expect(row('condensed').textContent).toContain('· cut from Friday stream')
    expect(row('tutorial').textContent).not.toContain('cut from')
  })

  it('shows the source of a cut copy, and never cleans it again', async () => {
    await render()
    const items = await openMenu('cut')
    expect(labels(items)).toContain('Show source recording')
    expect(labels(items)).not.toContain('Clean noise')
    await act(async () =>
      items.find((item) => item.textContent?.trim() === 'Show source recording')!.click()
    )
    await closeMenu()
    expect(row('tutorial').className).toContain('ring-1')
  })

  it('focuses the row Clean cut asked for', async () => {
    await render('condensed')
    expect(row('condensed').className).toContain('ring-1')
  })
})
