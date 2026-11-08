// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceNavContext } from '@/components/workspace-nav'
import type { SessionSummary } from '@/lib/backend'

import { LibraryTab } from './library-tab'

// Plan 174 S0.3 (E-2, J2-1): the delete confirm names where the file goes and
// what cannot come back, and no longer promises a restore from "the
// DeleteIcon".

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => ({ recording: mocked.recording }),
  useStudioRecording: () => ({ recording: mocked.recording })
}))

const session: SessionSummary = {
  id: 'tutorial',
  title: 'Rust tutorial',
  startedAt: '2026-10-03T10:00:00Z',
  durationMs: 600_000,
  status: 'completed',
  mode: 'record',
  mp4Path: '/videos/tutorial.mp4',
  healthEventCount: 0,
  sessionLogCount: 0,
  aiArtifactCount: 0,
  commentCount: 0
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocked.recording = { state: 'idle' }
  mocked.core = {
    sessions: [session],
    sessionsNextCursor: null,
    sessionsLoadingMore: false,
    sessionDetails: {},
    loadSessionDetails: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(),
    sessionStorageTotals: null,
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
  vi.unstubAllGlobals()
})

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

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
          createElement(LibraryTab, {
            onOpenBuddyReport: vi.fn(),
            onOpenCleanCut: vi.fn(),
            focusSessionId: null
          })
        )
      )
    )
  )
}

describe('Library delete confirm', () => {
  it('says the file goes to the OS trash and what is deleted for good, then deletes on confirm', async () => {
    await render()
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Select Rust tutorial"]')!.click()
    )
    const bulkDelete = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )!
    expect(bulkDelete).toBeTruthy()
    await act(async () => bulkDelete.click())
    const dialog = byTestId('library-delete-dialog')
    expect(dialog?.textContent).toMatch(/Move this recording to the (Trash|Recycle Bin)\?/)
    expect(dialog?.textContent).toMatch(
      /The video file goes to the (Trash|Recycle Bin)\. Its Library entry, markers, Buddy report and chat history are deleted and can't be restored\./
    )
    expect(dialog?.textContent).not.toContain('Icon')
    expect(byTestId('library-delete-confirm')?.textContent).toMatch(/^Move to (Trash|Recycle Bin)$/)
    await act(async () => byTestId('library-delete-cancel')!.click())
    expect(mocked.core.deleteSessions).not.toHaveBeenCalled()
    await act(async () => bulkDelete.click())
    await act(async () => byTestId('library-delete-confirm')!.click())
    expect(mocked.core.deleteSessions).toHaveBeenCalledExactlyOnceWith([session])
  })
})
