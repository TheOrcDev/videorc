// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionSummary } from '@/lib/backend'

import { LibraryTab } from './library-tab'

// The Library's Local | Cloud tabs (2026-11-19): Local is the recordings
// table, Cloud loads only when opened, "Open in Library" from Cloud lands on
// the Local row, and the Library reopens on the tab used last.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  cloudOpenLocal: null as ((sessionId: string) => void) | null,
  cloudMounts: 0
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => ({ recording: { state: 'idle' } }),
  useStudioRecording: () => ({ recording: { state: 'idle' } }),
  useStudioDiagnostics: () => ({ client: null }),
  useStudioCloud: () => ({ cloudStatus: null })
}))
// The Cloud tab's own behaviour has its suite (library-cloud-recordings.test.ts);
// here it is a stand-in that says it mounted and hands back its link.
vi.mock('@/components/tabs/library-cloud-recordings', async () => {
  const { createElement: h, useEffect } = await import('react')
  return {
    LibraryCloudRecordings: ({ onOpenLocal }: { onOpenLocal: (id: string) => void }) => {
      mocked.cloudOpenLocal = onOpenLocal
      useEffect(() => {
        mocked.cloudMounts += 1
      }, [])
      return h('div', { 'data-testid': 'cloud-stand-in' }, 'Cloud recordings')
    }
  }
})

function session(id: string, startedAt: string): SessionSummary {
  return {
    id,
    title: id[0].toUpperCase() + id.slice(1),
    startedAt,
    durationMs: 600_000,
    status: 'completed',
    mode: 'record',
    mp4Path: `/videos/${id}.mp4`,
    finalizationState: 'finalized',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0
  }
}

const SESSIONS = [
  session('alpha', '2026-11-09T10:00:00Z'),
  session('bravo', '2026-11-08T10:00:00Z')
]

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.platform = 'darwin'
  ;(window as unknown as { videorc: unknown }).videorc = {}
  mocked.cloudOpenLocal = null
  mocked.cloudMounts = 0
  mocked.core = {
    sessions: SESSIONS,
    sessionsNextCursor: null,
    sessionsLoadingMore: false,
    sessionDetails: {},
    loadSessionDetails: vi.fn(async () => undefined),
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
    wsStatus: 'connected',
    entitlements: null
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

async function render(focusSessionId: string | null = null): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(LibraryTab, {
          onOpenBuddyReport: vi.fn(),
          onOpenCleanCut: vi.fn(),
          focusSessionId
        })
      )
    )
  )
}

function tab(name: 'local' | 'cloud'): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[role="tab"][data-library-view="${name}"]`)
  expect(element, name).toBeTruthy()
  return element!
}

async function choose(name: 'local' | 'cloud'): Promise<void> {
  await act(async () => tab(name).click())
  // The Cloud tab's module is a lazy import: let it resolve.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function localRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-videorc-library-row]')]
}

function cloud(): HTMLElement | null {
  return document.querySelector('[data-testid="cloud-stand-in"]')
}

describe('Library → Local | Cloud tabs', () => {
  it('opens on Local, with the Cloud tab not loaded until it is chosen', async () => {
    await render()
    expect(tab('local').getAttribute('aria-selected')).toBe('true')
    expect(tab('cloud').textContent).toBe('Cloud')
    expect(localRows()).toHaveLength(2)
    expect(cloud()).toBeNull()
    expect(mocked.cloudMounts).toBe(0)

    await choose('cloud')
    expect(tab('cloud').getAttribute('aria-selected')).toBe('true')
    expect(cloud()).not.toBeNull()
    expect(localRows()).toHaveLength(0)

    await choose('local')
    expect(localRows()).toHaveLength(2)
    expect(cloud()).toBeNull()
  })

  it("lands Cloud's Open in Library on the Local row", async () => {
    await render()
    await choose('cloud')
    expect(mocked.cloudOpenLocal).toBeTypeOf('function')
    await act(async () => mocked.cloudOpenLocal?.('bravo'))
    expect(tab('local').getAttribute('aria-selected')).toBe('true')
    const bravo = document.querySelector<HTMLElement>('[data-videorc-library-row="bravo"]')
    expect(bravo?.hasAttribute('data-revealed')).toBe(true)
  })

  it('reopens on the tab used last, and a recording to show opens Local', async () => {
    await render()
    await choose('cloud')
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(tab('cloud').getAttribute('aria-selected')).toBe('true')

    await render('alpha')
    expect(tab('local').getAttribute('aria-selected')).toBe('true')
    expect(
      document.querySelector('[data-videorc-library-row="alpha"]')?.hasAttribute('data-revealed')
    ).toBe(true)
  })
})
