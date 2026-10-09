// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceNavContext } from '@/components/workspace-nav'
import type { SessionSummary } from '@/lib/backend'
import { hasBuddyReport } from '@/lib/library-view'

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
const onOpenBuddyReport = vi.fn((_sessionId: string) => undefined)
const onOpenCleanCut = vi.fn((_sessionId: string) => undefined)

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'stream-1',
    title: 'Rust night',
    startedAt: '2026-08-22T10:00:00Z',
    durationMs: 5_400_000,
    status: 'completed',
    mode: 'record+stream',
    mp4Path: '/videos/rust-night.mp4',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

const SESSIONS = [
  session({ id: 'stream-1' }),
  session({ id: 'stream-only', title: 'Q&A', mode: 'stream', mp4Path: undefined }),
  session({ id: 'recording-1', title: 'Tutorial', mode: 'record' }),
  session({ id: 'live-1', title: 'Live now', mode: 'record+stream', status: 'running' })
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onOpenBuddyReport.mockClear()
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

async function render(): Promise<void> {
  const nav = {
    active: 'library' as const,
    setActive: vi.fn(),
    activeStudioPanel: null,
    openStudioPanel: vi.fn(),
    closeStudioPanel: vi.fn(),
    openSettings: vi.fn(),
    openBuddy: vi.fn()
  }
  await act(async () =>
    root.render(
      createElement(
        WorkspaceNavContext.Provider,
        { value: nav },
        createElement(
          TooltipProvider,
          null,
          createElement(LibraryTab, { onOpenBuddyReport, onOpenCleanCut })
        )
      )
    )
  )
}

async function openMenu(sessionId: string): Promise<HTMLElement[]> {
  const trigger = document.querySelector(
    `[data-videorc-library-row="${sessionId}"] button[aria-label="Session actions"]`
  ) as HTMLElement
  expect(trigger, sessionId).toBeTruthy()
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

describe('Library → Buddy report (plan 119 S3)', () => {
  it('says where files live', async () => {
    await render()
    expect(document.querySelector('[data-slot="page-header"]')?.textContent).toContain(
      'Every recording and stream becomes a local session. Files stay on disk.'
    )
  })

  it("opens a stream's report in the Buddy tab from the row menu, right after Play", async () => {
    await render()
    const items = await openMenu('stream-1')
    expect(labels(items).slice(0, 2)).toEqual(['Play', 'Buddy report'])
    await act(async () => items[1].click())
    expect(onOpenBuddyReport).toHaveBeenCalledExactlyOnceWith('stream-1')

    const streamOnly = await openMenu('stream-only')
    expect(labels(streamOnly)).toContain('Buddy report')
  })

  it('offers no report for a recording that never went live', async () => {
    await render()
    expect(labels(await openMenu('recording-1'))).not.toContain('Buddy report')
  })

  it('waits for the live stream to end: its report is saved then', async () => {
    mocked.recording = {
      state: 'recording',
      sessionId: 'live-1',
      streamUrl: 'rtmp://live.example/app',
      startedAt: '2026-08-22T12:00:00Z'
    }
    await render()
    const report = (await openMenu('live-1')).find(
      (item) => item.textContent?.trim() === 'Buddy report'
    )
    expect(report?.hasAttribute('data-disabled')).toBe(true)
    await closeMenu()
  })

  it('knows which sessions went out live', () => {
    expect(hasBuddyReport({ mode: 'stream' })).toBe(true)
    expect(hasBuddyReport({ mode: 'record+stream' })).toBe(true)
    expect(hasBuddyReport({ mode: 'streaming' })).toBe(true)
    expect(hasBuddyReport({ mode: 'record' })).toBe(false)
    expect(hasBuddyReport({ mode: 'imported' })).toBe(false)
  })
})
