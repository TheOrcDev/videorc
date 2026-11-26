// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PH-12 (perf hunt 11-20): a room snapshot (a guest starts talking, a track
// arrives) replaces the cloud context's value. Only the Studio page's cloud
// readers may re-render with it: the transport, never the page root and the
// whole inspector under it.

type TransportProps = {
  talkShowOutputs?: { recording: boolean; live: boolean; onStopRecording: () => void }
}

const page = vi.hoisted(() => {
  const renders = { transport: 0, session: 0, quickSettings: 0, takeover: 0 }
  let lastTransport: TransportProps | null = null
  let cloud: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  return {
    renders,
    lastTransport: () => lastTransport,
    noteTransport: (props: TransportProps) => {
      renders.transport += 1
      lastTransport = props
    },
    cloud: () => cloud,
    setCloud: (next: Record<string, unknown>) => {
      cloud = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})

const core = {
  settings: {},
  canStop: false,
  startRequestPending: false,
  stopRequestPending: false,
  goLiveConfirmationPending: false,
  visibleStartBlockedReason: null,
  recordBlockedReason: null,
  liveStreamBlockedReason: null,
  sessionStartIntent: null,
  sessionStopOverrun: false,
  startRecording: async () => {},
  startLivestream: async () => {},
  requestStopSession: async () => {},
  noteRecordClick: () => {},
  captureConfig: { streamEnabled: false },
  sessionStartFailure: null,
  dismissSessionStartFailure: () => {},
  sessionRuntimeNotice: null,
  dismissSessionRuntimeNotice: () => {},
  retrySessionStart: () => {},
  // Waiting for the engine: no blocker banner to compute.
  wsStatus: 'waiting',
  nativePreviewSurfaceEnabled: false,
  previewWindow: { open: false, mode: 'docked' },
  handleSystemPermission: async () => {},
  refreshPreview: () => {},
  runtimeInfo: null
}

vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => core,
  useStudioRecordingState: () => ({ recording: { state: 'idle' } }),
  useStudioPreview: () => ({ previewLiveStatus: null }),
  useStudioDiagnostics: () => ({
    diagnosticStats: null,
    previewSurfaceStatus: { nativePreviewHostKind: null }
  }),
  useStudioCloud: () => useSyncExternalStore(page.subscribe, page.cloud)
}))

const none = (): null => null
vi.mock('@/components/studio/session-panel', () => ({
  SessionTransport: (props: TransportProps) => {
    page.noteTransport(props)
    return null
  },
  SessionPanel: () => {
    page.renders.session += 1
    return null
  },
  TakeoverSection: () => {
    page.renders.takeover += 1
    return null
  }
}))
vi.mock('@/components/studio/quick-settings', () => ({
  QuickSettings: () => {
    page.renders.quickSettings += 1
    return null
  }
}))
vi.mock('@/components/preview-stage', () => ({ PreviewStage: none }))
vi.mock('@/lib/studio-health', () => ({ studioHealth: () => ({ tone: 'ok' }) }))
vi.mock('@/components/studio/show-stage', () => ({ default: none }))
vi.mock('@/components/studio/studio-dashboard-bottom-row', () => ({
  StudioDashboardBottomRow: none
}))
vi.mock('@/components/studio/audio-section', () => ({ AudioSection: none }))
vi.mock('@/components/studio/studio-chat', () => ({ StudioChatSection: none }))
vi.mock('@/components/studio/cloud-resume-notice', () => ({ CloudResumeNotice: none }))

const { StudioTab } = await import('./studio-tab')

const stopCloudRecording = vi.fn(async () => {})
const roomCloud = (people: number): Record<string, unknown> => ({
  cloudStatus: { room: { phase: 'open', live: false }, recording: { active: true } },
  resumeCloudShow: async () => {},
  // A fresh talk-show value per snapshot, as the room controller makes one.
  talkShow: {
    previewReplaced: true,
    rejoining: false,
    room: { people: Array.from({ length: people }, (_, index) => ({ speaking: index === 0 })) },
    stopCloudRecording,
    resumeRoom: async () => {}
  }
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  page.setCloud(roomCloud(1))
  for (const key of Object.keys(page.renders) as (keyof typeof page.renders)[])
    page.renders[key] = 0
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Studio page with a talk-show room open (PH-12)', () => {
  it('re-renders only the transport when the room publishes a snapshot', async () => {
    await act(async () => root.render(createElement(StudioTab)))
    const before = { ...page.renders }
    expect(before.session).toBeGreaterThan(0)

    for (let update = 2; update <= 6; update += 1) {
      await act(async () => page.setCloud(roomCloud(update)))
    }

    expect(page.renders.transport).toBe(before.transport + 5)
    expect(page.renders.session).toBe(before.session)
    expect(page.renders.quickSettings).toBe(before.quickSettings)
    expect(page.renders.takeover).toBe(before.takeover)
  })

  it("still gives the transport the room's own outputs", async () => {
    await act(async () => root.render(createElement(StudioTab)))
    const outputs = page.lastTransport()?.talkShowOutputs
    expect(outputs).toMatchObject({ recording: true, live: false })
    outputs?.onStopRecording()
    expect(stopCloudRecording).toHaveBeenCalledTimes(1)

    await act(async () =>
      page.setCloud({ ...roomCloud(1), cloudStatus: { room: { phase: 'closed' } } })
    )
    expect(page.lastTransport()?.talkShowOutputs).toBeUndefined()
  })
})
