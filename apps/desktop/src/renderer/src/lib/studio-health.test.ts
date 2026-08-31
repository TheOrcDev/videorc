import { describe, expect, it } from 'vitest'

import {
  SESSION_START_FAILED_TOAST_ID,
  SESSION_START_FAILED_TOAST_TITLE,
  sessionStartFailureToastOptions
} from './session-start-failure'
import {
  RECORDING_STARTUP_BARRIER_TIMEOUT_CODE,
  RECORDING_STARTUP_CADENCE_UNSTEADY_CODE,
  RECORDING_STARTUP_UNSTEADY_TOAST_ID,
  recordingStartupHealthToast,
  studioHealth,
  type StudioHealthInput
} from './studio-health'

function stats(overrides: Partial<StudioHealthInput> = {}): StudioHealthInput {
  return {
    compositorBackend: 'metal',
    compositorCpuFallbackFrames: 0,
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    ...overrides
  }
}

describe('studioHealth', () => {
  it('reports Live on a healthy Metal session while active', () => {
    expect(studioHealth(stats(), true)).toMatchObject({ tone: 'good', value: 'Live' })
  })

  it('reports Ready on a healthy Metal session while idle', () => {
    expect(studioHealth(stats(), false)).toMatchObject({ tone: 'good', value: 'Ready' })
  })

  it('degrades to "Preview may not match recording" on CPU fallback', () => {
    const result = studioHealth(stats({ compositorBackend: 'cpu-fallback' }), false)
    expect(result.tone).toBe('error')
    expect(result.value).toBe('Degraded')
    expect(result.detail).toContain('Preview may not match recording')
  })

  it('includes the fallback reason in the degraded detail when known', () => {
    const result = studioHealth(
      stats({ compositorBackend: 'cpu-fallback', compositorFallbackReason: 'Metal disabled' }),
      true
    )
    expect(result.detail).toBe('Preview may not match recording — Metal disabled')
  })

  it('degrades when CPU fallback frames appear mid-recording even if the backend label is metal', () => {
    expect(studioHealth(stats({ compositorCpuFallbackFrames: 5 }), true).tone).toBe('error')
  })

  it('does not degrade on stale CPU fallback frames while idle', () => {
    expect(studioHealth(stats({ compositorCpuFallbackFrames: 5 }), false)).toMatchObject({
      tone: 'good',
      value: 'Ready'
    })
  })

  it('warns when preview present latency exceeds the live budget', () => {
    expect(studioHealth(stats({ previewInputToPresentLatencyP95Ms: 120 }), true)).toMatchObject({
      tone: 'warn',
      value: 'Lagging'
    })
  })

  // The red "requires native CAMetalLayer" Blocked state is GONE (owner,
  // 2026-07-07): it fired for transient startup states and read as jargon.
  // Non-native transports warn with a readable message; absent transports are
  // not a health problem — the preview window's presenting watch (plan 021 F1)
  // owns preview-path health.
  it('warns when image polling is the active transport', () => {
    expect(studioHealth(stats({ previewTransport: 'latest-jpeg-polling' }), true)).toMatchObject({
      tone: 'warn',
      value: 'Fallback'
    })
  })

  it('warns when the Electron proof surface is the active transport', () => {
    expect(
      studioHealth(
        stats({
          previewTransport: 'electron-proof-surface',
          previewSurfaceBacking: 'electron-browser-window'
        }),
        false
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('never reds an active session whose preview has no transport yet', () => {
    expect(
      studioHealth(stats({ previewTransport: 'unavailable', previewSurfaceBacking: 'none' }), true)
    ).toMatchObject({ tone: 'good', value: 'Live' })
  })

  it('keeps showing Fallback over Lagging when polling with high latency (no flapping)', () => {
    expect(
      studioHealth(
        stats({ previewTransport: 'latest-jpeg-polling', previewInputToPresentLatencyP95Ms: 200 }),
        true
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('is neutral when no compositor has reported yet', () => {
    expect(studioHealth(stats({ compositorBackend: undefined }), false)).toMatchObject({
      tone: 'neutral',
      value: 'Idle'
    })
  })

  it('reports the retained CPU/proof Windows path as a named fallback', () => {
    expect(
      studioHealth(
        stats({
          compositorBackend: 'cpu',
          compositorCpuFallbackFrames: 0,
          previewTransport: 'electron-proof-surface',
          previewSurfaceBacking: 'electron-browser-window'
        }),
        true,
        'win32',
        'proof-surface'
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('warns on image polling / proof surface on Windows', () => {
    expect(
      studioHealth(stats({ previewTransport: 'latest-jpeg-polling' }), true, 'win32')
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
    expect(
      studioHealth(stats({ previewTransport: 'electron-proof-surface' }), true, 'win32')
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('reads healthy only for the canonical Windows D3D11 presenter', () => {
    expect(
      studioHealth(
        stats({
          compositorBackend: 'd3d11',
          previewTransport: 'd3d11-shared-texture',
          previewSurfaceBacking: 'directcomposition-swapchain'
        }),
        true,
        'win32',
        'backend-d3d11-presenter'
      )
    ).toMatchObject({ tone: 'good', value: 'Live' })
    expect(
      studioHealth(
        stats({
          compositorBackend: 'd3d11',
          previewTransport: 'd3d11-shared-texture',
          previewSurfaceBacking: 'directcomposition-swapchain'
        }),
        true,
        'win32',
        'proof-surface'
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('still degrades on a genuine macOS Metal fallback', () => {
    expect(studioHealth(stats({ compositorBackend: 'cpu-fallback' }), true, 'darwin').tone).toBe(
      'error'
    )
  })
})

describe('recordingStartupHealthToast', () => {
  const UNSTEADY_MESSAGE =
    'Recording started with an unsteady compositor at start: gaps 166/120/98 ms vs 300 ms budget (5 fresh 1920x1080 frame(s) in 5000ms); check the first seconds of the file.'
  const REFUSED_MESSAGE =
    'Recording startup blocked before encoding: waiting for compositor frame (recent gaps none ms; 0 fresh frame(s) in 2500ms); cadence budget 200ms.'

  it('maps the unsteady-start WARN to a keyed warning toast carrying the backend copy', () => {
    const result = recordingStartupHealthToast({
      code: RECORDING_STARTUP_CADENCE_UNSTEADY_CODE,
      level: 'warn',
      message: UNSTEADY_MESSAGE
    })
    expect(result).toEqual({
      variant: 'warning',
      id: RECORDING_STARTUP_UNSTEADY_TOAST_ID,
      title: 'Recording started on an unsteady compositor',
      description: UNSTEADY_MESSAGE,
      duration: 15000
    })
    expect(result?.id).toBe('recording-startup-cadence-unsteady')
  })

  it('maps the barrier refusal to a persistent error toast on the start-failure key', () => {
    const result = recordingStartupHealthToast({
      code: RECORDING_STARTUP_BARRIER_TIMEOUT_CODE,
      level: 'error',
      message: REFUSED_MESSAGE
    })
    // Same title + description shape as the RPC-rejection toast: sonner merges
    // an update over the existing toast by id, so this is what lets the
    // rejection add Retry in place instead of stacking a second red toast.
    expect(result).toEqual({
      variant: 'error',
      id: SESSION_START_FAILED_TOAST_ID,
      title: SESSION_START_FAILED_TOAST_TITLE,
      description: REFUSED_MESSAGE,
      duration: Infinity
    })
    expect(result).toMatchObject({
      title: 'Could not start',
      description: sessionStartFailureToastOptions(
        REFUSED_MESSAGE,
        () => {},
        () => {}
      ).description
    })
  })

  it('ignores every other health event, including non-error barrier levels', () => {
    expect(
      recordingStartupHealthToast({
        code: 'recording-startup-barrier-ready',
        level: 'info',
        message: 'Recording startup waited 120ms for 3 fresh compositor frame(s).'
      })
    ).toBeNull()
    expect(
      recordingStartupHealthToast({
        code: 'recording-startup-cadence-retry',
        level: 'info',
        message: 'retrying the startup barrier once with a 300ms budget.'
      })
    ).toBeNull()
    expect(
      recordingStartupHealthToast({
        code: RECORDING_STARTUP_BARRIER_TIMEOUT_CODE,
        level: 'warn',
        message: REFUSED_MESSAGE
      })
    ).toBeNull()
    expect(
      recordingStartupHealthToast({ code: 'mic-silent', level: 'warn', message: 'quiet' })
    ).toBeNull()
  })
})
