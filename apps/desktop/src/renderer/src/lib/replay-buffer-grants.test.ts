import { describe, expect, it } from 'vitest'

import {
  nextPortalShareGrant,
  REPLAY_WAITS_FOR_PORTAL_SHARE,
  REPLAY_WAITS_FOR_PREVIEW,
  REPLAY_WAITS_FOR_SCREEN,
  REPLAY_WAITS_FOR_SHARE_DIALOG,
  replayStartWaitsForGrant,
  replayStartWaitsForScreen,
  SCREEN_SHARE_GRANTED_MESSAGE
} from './replay-buffer-grants'
import { SCREEN_SHARE_DIALOG_PENDING_MESSAGE } from './source-status'

const sources = {
  screenId: 'screen:screencapturekit:1',
  windowId: undefined,
  captureOff: undefined,
  cameraId: 'camera:1',
  cameraOff: undefined,
  microphoneId: 'microphone:coreaudio:1',
  microphoneOff: undefined
}
const granted = { camera: 'granted', microphone: 'granted', screen: 'granted' } as const

describe('replayStartWaitsForGrant (plan 203 S2)', () => {
  it('lets a granted, denied, or grant-free scene start as before', () => {
    expect(
      replayStartWaitsForGrant({ mediaAccess: granted, sources, layoutPreset: 'side-by-side' })
    ).toBeNull()
    expect(
      replayStartWaitsForGrant({
        mediaAccess: { camera: 'denied', microphone: 'denied', screen: 'denied' },
        sources,
        layoutPreset: 'side-by-side'
      })
    ).toBeNull()
    expect(
      replayStartWaitsForGrant({
        mediaAccess: {
          camera: 'not-applicable',
          microphone: 'not-applicable',
          screen: 'not-applicable'
        },
        sources,
        layoutPreset: 'side-by-side'
      })
    ).toBeNull()
  })

  it('waits while a device the scene uses has never been asked for', () => {
    expect(
      replayStartWaitsForGrant({
        mediaAccess: { ...granted, screen: 'not-determined' },
        sources,
        layoutPreset: 'side-by-side'
      })
    ).toBe('Screen Recording has not been allowed yet.')
    expect(
      replayStartWaitsForGrant({
        mediaAccess: { ...granted, camera: 'not-determined' },
        sources,
        layoutPreset: 'side-by-side'
      })
    ).toBe('Camera access has not been allowed yet.')
    expect(
      replayStartWaitsForGrant({
        mediaAccess: { ...granted, microphone: 'not-determined' },
        sources,
        layoutPreset: 'side-by-side'
      })
    ).toBe('Microphone access has not been allowed yet.')
  })

  it('ignores devices the scene does not use', () => {
    const neverAsked = {
      camera: 'not-determined',
      microphone: 'not-determined',
      screen: 'not-determined'
    } as const
    expect(
      replayStartWaitsForGrant({
        mediaAccess: neverAsked,
        sources: {
          ...sources,
          captureOff: true,
          screenId: undefined,
          microphoneOff: true,
          microphoneId: undefined
        },
        layoutPreset: 'screen-only'
      })
    ).toBeNull()
    expect(
      replayStartWaitsForGrant({
        mediaAccess: neverAsked,
        sources: {
          ...sources,
          cameraOff: true,
          cameraId: undefined,
          microphoneOff: true,
          microphoneId: undefined
        },
        layoutPreset: 'side-by-side'
      })
    ).toBe('Screen Recording has not been allowed yet.')
  })

  it('waits for the snapshot itself when a device is in use', () => {
    expect(
      replayStartWaitsForGrant({ mediaAccess: null, sources, layoutPreset: 'side-by-side' })
    ).toBe('Waiting for the permission state.')
    expect(
      replayStartWaitsForGrant({
        mediaAccess: null,
        sources: {
          ...sources,
          captureOff: true,
          screenId: undefined,
          cameraOff: true,
          cameraId: undefined,
          microphoneOff: true,
          microphoneId: undefined
        },
        layoutPreset: 'side-by-side'
      })
    ).toBeNull()
  })

  it('never waits on a synthetic smoke device', () => {
    expect(
      replayStartWaitsForGrant({
        mediaAccess: { camera: 'not-determined', microphone: 'granted', screen: 'granted' },
        sources: { ...sources, cameraId: 'camera:synthetic-preview-smoke' },
        layoutPreset: 'side-by-side'
      })
    ).toBeNull()
  })
})

describe('replayStartWaitsForScreen (plan 207 S2)', () => {
  const preset = { layoutPreset: 'screen-camera', arrangementMode: 'preset' } as const
  const noScreen = { screenId: undefined, windowId: undefined, captureOff: undefined }

  it('waits while the layout shows a screen and none is chosen', () => {
    expect(replayStartWaitsForScreen({ sources: noScreen, layout: preset })).toBe(
      REPLAY_WAITS_FOR_SCREEN
    )
    expect(
      replayStartWaitsForScreen({
        sources: noScreen,
        layout: { layoutPreset: 'vertical-screen-only', arrangementMode: 'preset' }
      })
    ).toBe(REPLAY_WAITS_FOR_SCREEN)
  })

  it('never waits for a layout without a screen', () => {
    expect(
      replayStartWaitsForScreen({
        sources: noScreen,
        layout: { layoutPreset: 'camera-only', arrangementMode: 'preset' }
      })
    ).toBeNull()
    expect(
      replayStartWaitsForScreen({
        sources: noScreen,
        layout: { layoutPreset: 'vertical-camera-only', arrangementMode: 'preset' }
      })
    ).toBeNull()
    // Freeform shows what it has.
    expect(
      replayStartWaitsForScreen({
        sources: noScreen,
        layout: { layoutPreset: 'screen-camera', arrangementMode: 'freeform' }
      })
    ).toBeNull()
  })

  it('clears once a screen, a window, or the test pattern stands in', () => {
    expect(
      replayStartWaitsForScreen({
        sources: { ...noScreen, screenId: 'screen:screencapturekit:1' },
        layout: preset
      })
    ).toBeNull()
    expect(
      replayStartWaitsForScreen({
        sources: { ...noScreen, windowId: 'window:screencapturekit:7' },
        layout: preset
      })
    ).toBeNull()
    expect(
      replayStartWaitsForScreen({ sources: { ...noScreen, testPattern: true }, layout: preset })
    ).toBeNull()
  })

  it('leaves Screen set to None to the record block', () => {
    expect(
      replayStartWaitsForScreen({ sources: { ...noScreen, captureOff: true }, layout: preset })
    ).toBeNull()
  })

  it('waits for a chosen screen whose preview has not started yet (setup just closed)', () => {
    const chosen = { ...noScreen, screenId: 'screen:screencapturekit:1' }
    // The backend's idle status names no source (never started, or stopped).
    const idle = { state: 'source-missing', sourceId: undefined } as const
    expect(
      replayStartWaitsForScreen({
        sources: chosen,
        layout: preset,
        previewScreen: idle,
        previewStarts: true
      })
    ).toBe(REPLAY_WAITS_FOR_PREVIEW)
    // Once the preview names the source, a screen without frames fails as today.
    for (const state of ['starting', 'live', 'failed', 'source-missing'] as const) {
      expect(
        replayStartWaitsForScreen({
          sources: chosen,
          layout: preset,
          previewScreen: { state, sourceId: 'screen:screencapturekit:1' },
          previewStarts: true
        })
      ).toBeNull()
    }
    // Smokes and auto-preview opt-outs never start that preview: no wait.
    expect(
      replayStartWaitsForScreen({ sources: chosen, layout: preset, previewScreen: idle })
    ).toBeNull()
    // A layout without a screen never waits for its preview.
    expect(
      replayStartWaitsForScreen({
        sources: chosen,
        layout: { layoutPreset: 'camera-only', arrangementMode: 'preset' },
        previewScreen: idle,
        previewStarts: true
      })
    ).toBeNull()
  })
})

describe('Linux portal share (retest 153)', () => {
  const preset = { layoutPreset: 'screen-camera', arrangementMode: 'preset' } as const
  const portal = {
    screenId: 'screen:portal:monitor',
    windowId: undefined,
    captureOff: undefined
  }
  const status = (
    state: 'starting' | 'live' | 'permission-needed' | 'source-missing' | 'failed',
    extra: { sourceId?: string; message?: string; framesCaptured?: number } = {}
  ) => ({
    state,
    sourceId: 'screen:portal:monitor',
    framesCaptured: 0,
    ...extra
  })

  it('waits on the placeholder until this run shares a screen', () => {
    // A fresh profile: the placeholder from the device list, no share yet.
    expect(replayStartWaitsForScreen({ sources: portal, layout: preset })).toBe(
      REPLAY_WAITS_FOR_PORTAL_SHARE
    )
    expect(
      replayStartWaitsForScreen({
        sources: { ...portal, screenId: undefined, windowId: 'window:portal:window' },
        layout: preset
      })
    ).toBe(REPLAY_WAITS_FOR_PORTAL_SHARE)
    // The preview's share dialog is up: say so.
    expect(
      replayStartWaitsForScreen({
        sources: portal,
        layout: preset,
        previewScreen: { state: 'starting', message: SCREEN_SHARE_DIALOG_PENDING_MESSAGE }
      })
    ).toBe(REPLAY_WAITS_FOR_SHARE_DIALOG)
    expect(
      replayStartWaitsForScreen({
        sources: portal,
        layout: preset,
        portalShareGrantedSourceId: 'screen:portal:monitor'
      })
    ).toBeNull()
    // A granted window share does not stand in for a screen share.
    expect(
      replayStartWaitsForScreen({
        sources: portal,
        layout: preset,
        portalShareGrantedSourceId: 'window:portal:window'
      })
    ).toBe(REPLAY_WAITS_FOR_PORTAL_SHARE)
  })

  it('never waits on the placeholder when the layout needs no screen', () => {
    expect(
      replayStartWaitsForScreen({
        sources: portal,
        layout: { layoutPreset: 'camera-only', arrangementMode: 'preset' }
      })
    ).toBeNull()
    expect(
      replayStartWaitsForScreen({ sources: { ...portal, captureOff: true }, layout: preset })
    ).toBeNull()
    expect(
      replayStartWaitsForScreen({ sources: { ...portal, testPattern: true }, layout: preset })
    ).toBeNull()
  })

  it('latches a grant from the first frame or the granted phase', () => {
    // Idle (the preview's `source-missing`) is no grant.
    expect(nextPortalShareGrant(null, status('source-missing'))).toBeNull()
    expect(nextPortalShareGrant(null, status('starting'))).toBeNull()
    expect(
      nextPortalShareGrant(
        null,
        status('starting', { message: SCREEN_SHARE_DIALOG_PENDING_MESSAGE })
      )
    ).toBeNull()
    expect(
      nextPortalShareGrant(null, status('starting', { message: SCREEN_SHARE_GRANTED_MESSAGE }))
    ).toBe('screen:portal:monitor')
    expect(nextPortalShareGrant(null, status('live', { framesCaptured: 1 }))).toBe(
      'screen:portal:monitor'
    )
  })

  it('keeps a grant whose share later produces no frames, so that still fails', () => {
    const granted = 'screen:portal:monitor'
    expect(nextPortalShareGrant(granted, status('source-missing'))).toBe(granted)
    expect(nextPortalShareGrant(granted, status('failed'))).toBe(granted)
    expect(
      replayStartWaitsForScreen({
        sources: portal,
        layout: preset,
        portalShareGrantedSourceId: granted,
        previewScreen: { state: 'source-missing' }
      })
    ).toBeNull()
  })

  it('drops the grant when a new share dialog opens or is cancelled', () => {
    const granted = 'screen:portal:monitor'
    expect(nextPortalShareGrant(granted, status('permission-needed'))).toBeNull()
    expect(
      nextPortalShareGrant(
        granted,
        status('starting', { message: SCREEN_SHARE_DIALOG_PENDING_MESSAGE })
      )
    ).toBeNull()
    // Another source's dialog leaves this grant alone.
    expect(
      nextPortalShareGrant(
        granted,
        status('permission-needed', { sourceId: 'window:portal:window' })
      )
    ).toBe(granted)
  })

  it('ignores every non-portal source', () => {
    expect(
      nextPortalShareGrant(null, status('live', { sourceId: 'screen:screencapturekit:1' }))
    ).toBeNull()
    expect(
      replayStartWaitsForScreen({
        sources: { ...portal, screenId: 'screen:screencapturekit:1' },
        layout: preset
      })
    ).toBeNull()
  })
})
