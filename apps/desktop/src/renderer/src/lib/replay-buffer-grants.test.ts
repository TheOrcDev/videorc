import { describe, expect, it } from 'vitest'

import {
  REPLAY_WAITS_FOR_SCREEN,
  replayStartWaitsForGrant,
  replayStartWaitsForScreen
} from './replay-buffer-grants'

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
})
