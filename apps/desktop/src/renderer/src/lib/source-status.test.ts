import { describe, expect, it } from 'vitest'

import {
  microphoneStatus,
  selectedDeviceStatus,
  systemAudioStatus,
  unknownDeviceWarnings,
  SCREEN_SHARE_DIALOG_LOST_MESSAGE,
  SCREEN_SHARE_DIALOG_PENDING_MESSAGE,
  screenShareNeedsAsking,
  videoSourceStatus
} from '@/lib/source-status'
import type { PreviewScreenState } from '@/lib/backend'

// Plan 173: one status vocabulary for the four Sources rows.

describe('selectedDeviceStatus', () => {
  const devices = [
    { id: 'cam-a', status: 'available' as const },
    { id: 'cam-b', status: 'unavailable' as const }
  ]

  it('is undefined with nothing selected, missing when the id is not listed', () => {
    expect(selectedDeviceStatus(devices, undefined)).toBeUndefined()
    expect(selectedDeviceStatus(devices, 'cam-z')).toBe('missing')
    expect(selectedDeviceStatus(devices, 'cam-b')).toBe('unavailable')
    expect(selectedDeviceStatus(devices, 'cam-a')).toBe('available')
  })
})

describe('videoSourceStatus', () => {
  const base = { kind: 'camera' as const, selected: true, switching: false }

  it('says Switching while a live switch is in flight, even with nothing selected', () => {
    expect(videoSourceStatus({ ...base, selected: false, switching: true })).toEqual({
      label: 'Switching',
      tone: 'warn'
    })
  })

  it('shows no chip with nothing selected: the picker says None or Off', () => {
    expect(videoSourceStatus({ ...base, selected: false, preview: { state: 'live' } })).toBeNull()
  })

  it('says Live for a delivering source', () => {
    expect(videoSourceStatus({ ...base, preview: { state: 'live', frameAgeMs: 40 } })).toEqual({
      label: 'Receiving',
      tone: 'good'
    })
  })

  it('reports a stale camera, never a stale screen', () => {
    expect(videoSourceStatus({ ...base, preview: { state: 'live', frameAgeMs: 4200 } })).toEqual({
      label: 'Stale 4s',
      tone: 'warn',
      hint: 'No fresh frames. Choose it again to restart it.'
    })
    expect(
      videoSourceStatus({ ...base, kind: 'screen', preview: { state: 'live', frameAgeMs: 60000 } })
    ).toEqual({ label: 'Receiving', tone: 'good' })
  })

  it('trusts a live preview over a lagging device list', () => {
    expect(videoSourceStatus({ ...base, device: 'missing', preview: { state: 'live' } })).toEqual({
      label: 'Receiving',
      tone: 'good'
    })
  })

  it('says Needs permission from either the preview or the device list, leaving the fix to the page alert', () => {
    expect(
      videoSourceStatus({ ...base, preview: { state: 'permission-needed', message: 'Grant it.' } })
    ).toEqual({ label: 'Needs permission', tone: 'warn' })
    expect(videoSourceStatus({ ...base, device: 'permission-required' })?.label).toBe(
      'Needs permission'
    )
  })

  it('says Not found when the device list lost the source, where the old chip said nothing', () => {
    expect(videoSourceStatus({ ...base, device: 'missing' })).toEqual({
      label: 'Not found',
      tone: 'warn',
      hint: "It isn't connected. Reconnect it, or choose another."
    })
    expect(videoSourceStatus({ ...base, kind: 'screen', device: 'missing' })).toEqual({
      label: 'Not found',
      tone: 'warn',
      hint: 'That screen or window is gone. Choose another.'
    })
    expect(videoSourceStatus({ ...base, device: 'unavailable' })?.label).toBe('Not found')
  })

  it("never reads the preview's idle state as Not found (found by eye, 2026-10-10)", () => {
    // The backend's idle screen status is `source-missing`, and the camera's is
    // `device-missing`: a connected display whose preview is not running.
    expect(
      videoSourceStatus({
        ...base,
        kind: 'screen',
        device: 'available',
        preview: { state: 'source-missing' }
      })
    ).toBeNull()
    expect(
      videoSourceStatus({ ...base, device: 'available', preview: { state: 'device-missing' } })
    ).toBeNull()
  })

  it('says who a Linux share dialog is waiting on (plan 0010)', () => {
    expect(
      videoSourceStatus({
        ...base,
        kind: 'screen',
        preview: { state: 'starting', message: SCREEN_SHARE_DIALOG_PENDING_MESSAGE }
      })
    ).toEqual({
      label: 'Waiting for you',
      tone: 'warn',
      hint: 'Choose a screen in the share dialog. It may be behind this window.'
    })
    expect(
      videoSourceStatus({
        ...base,
        preview: { state: 'starting', message: 'Starting screen capture.' }
      })
    ).toEqual({ label: 'Starting', tone: 'warn' })
  })

  it('says a Linux share dialog closed unexpectedly, and how to ask again', () => {
    expect(
      videoSourceStatus({
        ...base,
        kind: 'screen',
        preview: { state: 'permission-needed', message: SCREEN_SHARE_DIALOG_LOST_MESSAGE }
      })
    ).toEqual({
      label: 'Not shared',
      tone: 'warn',
      hint: 'The share dialog closed unexpectedly. Select Refresh to choose your screen again.'
    })
    expect(
      videoSourceStatus({ ...base, kind: 'screen', preview: { state: 'permission-needed' } })
    ).toEqual({ label: 'Needs permission', tone: 'warn' })
  })

  it('has Refresh ask again only for a portal share that is not live or waiting', () => {
    const portal = (state: PreviewScreenState | undefined, selectedId = 'screen:portal:monitor') =>
      screenShareNeedsAsking({ selectedId, state })
    expect(portal('permission-needed')).toBe(true)
    expect(portal('source-missing')).toBe(true)
    expect(portal('failed')).toBe(true)
    expect(portal('permission-needed', 'window:portal:window')).toBe(true)
    expect(portal('live')).toBe(false)
    expect(portal('starting')).toBe(false)
    // macOS and Windows permission prompts are the OS's, never re-asked here.
    expect(portal('permission-needed', 'screen:screencapturekit:1')).toBe(false)
    expect(screenShareNeedsAsking({ selectedId: undefined, state: 'source-missing' })).toBe(false)
  })

  it('says Starting, then Failed with a retry hint, never the raw backend message', () => {
    expect(videoSourceStatus({ ...base, preview: { state: 'starting' } })).toEqual({
      label: 'Starting',
      tone: 'warn'
    })
    expect(videoSourceStatus({ ...base, preview: { state: 'failed', message: 'Busy.' } })).toEqual({
      label: 'Failed',
      tone: 'error',
      hint: "Couldn't start it. Choose it again to retry."
    })
  })

  it('shows no chip before the preview reports', () => {
    expect(videoSourceStatus({ ...base, device: 'available' })).toBeNull()
  })
})

describe('microphoneStatus', () => {
  const base = { selected: true, switching: false, muted: false, sessionActive: false }

  it('says nothing for a working idle microphone: its meter moves', () => {
    expect(microphoneStatus({ ...base, device: 'available' })).toBeNull()
  })

  it('says Live during a session and Muted while muted', () => {
    expect(microphoneStatus({ ...base, sessionActive: true })).toEqual({
      label: 'Receiving',
      tone: 'good'
    })
    expect(microphoneStatus({ ...base, sessionActive: true, muted: true })).toEqual({
      label: 'Muted',
      tone: 'neutral'
    })
  })

  it('puts Switching, permission and a missing device ahead of mute', () => {
    expect(microphoneStatus({ ...base, muted: true, switching: true })?.label).toBe('Switching')
    expect(microphoneStatus({ ...base, muted: true, device: 'permission-required' })?.label).toBe(
      'Needs permission'
    )
    expect(microphoneStatus({ ...base, muted: true, device: 'missing' })?.label).toBe('Not found')
  })

  it('shows no chip with no microphone selected', () => {
    expect(microphoneStatus({ ...base, selected: false, muted: true })).toBeNull()
  })
})

describe('systemAudioStatus', () => {
  const off = {
    permissionRequired: false,
    checked: false,
    pending: null,
    issue: null,
    meter: false
  }

  it('shows no chip while off: the switch says it', () => {
    expect(systemAudioStatus(off, false)).toBeNull()
  })

  it('says On outside a session and Live once a session mixes it', () => {
    expect(systemAudioStatus({ ...off, checked: true }, false)).toEqual({
      label: 'On',
      tone: 'neutral'
    })
    expect(systemAudioStatus({ ...off, checked: true, meter: true }, true)).toEqual({
      label: 'Receiving',
      tone: 'good'
    })
  })

  it('names the pending direction, a pause by the echo guard and other stops', () => {
    expect(systemAudioStatus({ ...off, checked: true, pending: 'on' }, true)?.label).toBe(
      'Turning on…'
    )
    expect(systemAudioStatus({ ...off, pending: 'off' }, true)?.label).toBe('Turning off…')
    // The row's own issue alert says what happened, so the chip has no hint.
    expect(systemAudioStatus({ ...off, checked: true, issue: 'echo' }, true)).toEqual({
      label: 'Paused',
      tone: 'warn'
    })
    expect(systemAudioStatus({ ...off, checked: true, issue: 'lost' }, true)?.label).toBe('Stopped')
  })

  it('says Needs permission without Screen Recording, and points at the page alert', () => {
    expect(systemAudioStatus({ ...off, permissionRequired: true }, false)).toEqual({
      label: 'Needs permission',
      tone: 'warn',
      hint: 'Uses the Screen Recording permission. Turn it on above.'
    })
  })
})

describe('unknownDeviceWarnings', () => {
  const warnings = [
    'Camera permission has not been granted yet. Open Camera privacy settings if preview shows black frames.',
    'macOS Screen Recording permission is not granted for /x/videorc-backend. Grant Screen Recording permission to this capture helper, then quit and relaunch Videorc.',
    'AVFoundation did not return cameras. Camera permission may be missing.',
    'MediaFoundation camera discovery failed: busy'
  ]

  it('drops every permission warning: the curated alerts own those (C-8)', () => {
    expect(unknownDeviceWarnings(warnings)).toEqual([warnings[3]])
    expect(unknownDeviceWarnings([])).toEqual([])
  })
})
