// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiagnosticStats, HealthEvent } from '@/lib/backend'

// Plan 174 S3.18 (I-4, I-25, V-7, J2 owner item): Health leads with one
// verdict, shows only the checks that need attention, keeps the support
// bundle on top, and folds the numbers into one closed Technical details.

const mocked = vi.hoisted(() => ({
  stats: {} as Record<string, unknown>,
  healthEvents: [] as unknown[],
  devices: [] as unknown[],
  handleSystemPermission: vi.fn(async () => undefined)
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    handleSystemPermission: mocked.handleSystemPermission,
    sessions: [],
    sessionDetails: {},
    sessionDetailsLoading: new Set(),
    sessionDetailError: null,
    loadSessionDetails: vi.fn(async () => undefined),
    streamTargets: [],
    nativePreviewSurfaceEnabled: true,
    captureConfig: { sources: {} },
    deviceList: { devices: mocked.devices },
    mediaAccess: null,
    runtimeInfo: { platform: 'darwin', backendCrashes: [] },
    exportSupportBundle: vi.fn(async () => undefined),
    supportBundleExportPending: false
  }),
  useStudioAudio: () => ({ audioMeter: null }),
  useStudioRecording: () => ({ recording: { state: 'idle' } }),
  useStudioPreview: () => ({
    previewLiveStatus: { state: 'live' },
    previewCameraStatus: { state: 'source-missing', droppedFrames: 0 },
    previewScreenStatus: { state: 'live', droppedFrames: 0, sourceFps: 30 }
  }),
  useStudioDiagnostics: () => ({
    diagnosticStats: mocked.stats as unknown as DiagnosticStats,
    healthEvents: mocked.healthEvents,
    logs: [],
    previewSurfaceStatus: {
      source: 'capture',
      targetFps: 30,
      state: 'presenting',
      framesRendered: 10,
      backing: 'cametal-layer'
    },
    recordLatency: {},
    streamHealth: null
  })
}))

import { DiagnosticsTab } from './diagnostics-tab'

function healthyStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bottleneck: 'none',
    recordingAtRisk: false,
    recordingRiskReasons: [],
    recordingProtected: false,
    activeOutputMode: undefined,
    droppedFrames: 0,
    skippedFrames: 0,
    encoderSpeed: undefined,
    targetFps: 30,
    previewTargetFps: 30,
    renderFps: 30,
    captureFps: 30,
    deviceDisconnected: false,
    duplicateCaptureSources: [],
    previewCameraDroppedFrames: 0,
    previewScreenDroppedFrames: 0,
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    previewPresentFps: 30,
    previewDroppedFrames: 0,
    previewRepeatedFrames: 0,
    backendRssBytes: 300 * 1024 * 1024,
    ffmpegMaintenanceRunning: false,
    ffmpegMaintenanceCancelRequested: false,
    encoderBridgeQueueDepth: 0,
    encoderBridgeRecordingQueueDepth: 0,
    encoderBridgeRecordingQueueCapacityPressureEvents: 0,
    encoderBridgeRecordingQueueDroppedFrames: 0,
    encoderBridgeStreamQueueDepth: 0,
    encoderBridgeStreamQueueCapacityPressureEvents: 0,
    encoderBridgeStreamQueueDroppedFrames: 0,
    encoderBridgeDroppedFrames: 0,
    ...overrides
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.stats = healthyStats()
  mocked.healthEvents = []
  mocked.devices = []
  mocked.handleSystemPermission.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = async (): Promise<void> =>
  act(async () => root.render(createElement(DiagnosticsTab)))
const verdict = (): HTMLElement => container.querySelector('[data-testid="health-verdict"]')!
const chips = (): string[] =>
  [...container.querySelectorAll('[data-check]')].map((chip) => chip.getAttribute('data-check')!)
const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)

describe('Health page', () => {
  it('says everything looks healthy and keeps the checks folded', async () => {
    await render()
    expect(verdict().textContent).toBe('Everything looks healthy')
    expect(verdict().getAttribute('role')).toBe('status')
    expect(chips()).toEqual([])

    await act(async () => button('Show all checks (13)')!.click())
    expect(chips()).toHaveLength(13)
    // A camera that isn't running is idle, never amber (plan 173, I-4).
    expect(
      container.querySelector('[data-check="camera"] [data-tone]')?.getAttribute('data-tone')
    ).toBe('neutral')
    expect(button('Show fewer checks')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('names what needs attention, says what to do, and shows only those checks', async () => {
    mocked.stats = healthyStats({ bottleneck: 'encoder', droppedFrames: 12 })
    await render()
    expect(verdict().getAttribute('data-variant')).toBe('warning')
    expect(verdict().textContent).toContain('2 things need attention: Slowdown, Encoder')
    expect(verdict().textContent).toContain('Lower the bitrate or the resolution')
    expect(chips()).toEqual(['slowdown', 'encoder'])
    expect(container.textContent).toContain('12 dropped frames')
  })

  it('keeps the support bundle on top and the numbers in one closed Technical details', async () => {
    mocked.stats = healthyStats({ bottleneck: 'encoder' })
    await render()
    expect(container.querySelector('[data-testid="support-bundle-button"]')).not.toBeNull()
    const details = container.querySelector('[data-testid="health-technical-details"]')!
    expect(details.hasAttribute('data-closed')).toBe(true)
    expect(container.textContent).not.toContain('Bridge queue')

    await act(async () => button('Technical details')!.click())
    // An unhealthy group opens itself; a healthy one stays closed.
    const group = (title: string): Element =>
      [...details.querySelectorAll('[data-slot="collapsible"]')].find((entry) =>
        entry.querySelector('h3')?.textContent?.startsWith(title)
      )!
    expect(group('Overview').hasAttribute('data-open')).toBe(true)
    expect(group('Start and stop').hasAttribute('data-closed')).toBe(true)
    expect(container.textContent).toContain('Bridge queue')
    // One Pipeline (V-7).
    expect(
      [...container.querySelectorAll('h2, h3')].filter((heading) =>
        heading.textContent?.startsWith('Pipeline')
      )
    ).toHaveLength(1)
  })

  it('asks once per permission with a labelled fix, and counts it in the verdict', async () => {
    mocked.devices = [
      { id: 'camera-1', kind: 'camera', name: 'Cam', status: 'permission-required' }
    ]
    const event = (id: string): HealthEvent => ({
      id,
      level: 'warn',
      code: 'camera-source-unavailable',
      message: 'camera permission denied',
      permissionPane: 'camera',
      createdAt: '2026-10-11T10:00:00Z'
    })
    mocked.healthEvents = [event('a'), event('b')]
    await render()
    const warnings = container.querySelectorAll('[data-testid="health-permission-warning"]')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].textContent).toContain('Camera needs permission')
    // Raw event codes and messages stay in the logs (I-4).
    expect(warnings[0].textContent).not.toContain('camera-source-unavailable')
    expect(verdict().textContent).toContain('Camera permission')

    await act(async () => button('Open System Settings…')!.click())
    expect(mocked.handleSystemPermission).toHaveBeenCalledWith('camera')

    await act(async () =>
      warnings[0].querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click()
    )
    expect(container.querySelectorAll('[data-testid="health-permission-warning"]')).toHaveLength(0)
  })
})
