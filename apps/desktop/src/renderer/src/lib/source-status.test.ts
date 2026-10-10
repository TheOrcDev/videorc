import { describe, expect, it } from 'vitest'

import {
  microphoneStatus,
  selectedDeviceStatus,
  systemAudioStatus,
  uncoveredDeviceWarnings,
  videoSourceStatus
} from '@/lib/source-status'

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
      label: 'Live',
      tone: 'good'
    })
  })

  it('reports a stale camera, never a stale screen', () => {
    expect(videoSourceStatus({ ...base, preview: { state: 'live', frameAgeMs: 4200 } })).toEqual({
      label: 'Stale 4s',
      tone: 'warn',
      hint: 'No fresh frames. Re-select the source to restart it.'
    })
    expect(
      videoSourceStatus({ ...base, kind: 'screen', preview: { state: 'live', frameAgeMs: 60000 } })
    ).toEqual({ label: 'Live', tone: 'good' })
  })

  it('trusts a live preview over a lagging device list', () => {
    expect(videoSourceStatus({ ...base, device: 'missing', preview: { state: 'live' } })).toEqual({
      label: 'Live',
      tone: 'good'
    })
  })

  it('says Needs permission from either the preview or the device list', () => {
    expect(
      videoSourceStatus({ ...base, preview: { state: 'permission-needed', message: 'Grant it.' } })
    ).toEqual({ label: 'Needs permission', tone: 'warn', hint: 'Grant it.' })
    expect(videoSourceStatus({ ...base, device: 'permission-required' })?.label).toBe(
      'Needs permission'
    )
  })

  it('says Not found when the device list lost the source, where the old chip said nothing', () => {
    expect(videoSourceStatus({ ...base, device: 'missing' })).toEqual({
      label: 'Not found',
      tone: 'warn',
      hint: 'It is not connected. Reconnect it, or pick another.'
    })
    expect(videoSourceStatus({ ...base, kind: 'screen', device: 'missing' })).toEqual({
      label: 'Not found',
      tone: 'warn',
      hint: 'That screen or window is gone. Pick another.'
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

  it('says Starting, then Failed with the backend message or a retry hint', () => {
    expect(videoSourceStatus({ ...base, preview: { state: 'starting' } })).toEqual({
      label: 'Starting',
      tone: 'warn'
    })
    expect(videoSourceStatus({ ...base, preview: { state: 'failed', message: 'Busy.' } })).toEqual({
      label: 'Failed',
      tone: 'error',
      hint: 'Busy.'
    })
    expect(videoSourceStatus({ ...base, preview: { state: 'failed' } })?.hint).toBe(
      'Re-select the source to retry.'
    )
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
      label: 'Live',
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
      label: 'Live',
      tone: 'good'
    })
  })

  it('names the pending direction, a pause by the echo guard and other stops', () => {
    expect(systemAudioStatus({ ...off, checked: true, pending: 'on' }, true)?.label).toBe(
      'Turning on…'
    )
    expect(systemAudioStatus({ ...off, pending: 'off' }, true)?.label).toBe('Turning off…')
    expect(systemAudioStatus({ ...off, checked: true, issue: 'echo' }, true)).toEqual({
      label: 'Paused',
      tone: 'warn',
      hint: 'Your stream came back as an echo.'
    })
    expect(systemAudioStatus({ ...off, checked: true, issue: 'lost' }, true)?.label).toBe('Stopped')
  })

  it('says Needs permission without Screen Recording', () => {
    expect(systemAudioStatus({ ...off, permissionRequired: true }, false)?.label).toBe(
      'Needs permission'
    )
  })
})

describe('uncoveredDeviceWarnings', () => {
  const warnings = [
    'Camera permission has not been granted yet. Open Camera privacy settings if preview shows black frames.',
    'macOS Screen Recording permission is not granted for /x/videorc-backend. Grant Screen Recording permission to this capture helper, then quit and relaunch Videorc.',
    'MediaFoundation camera discovery failed: busy'
  ]

  it('drops only the permission warnings a column alert already covers', () => {
    expect(uncoveredDeviceWarnings(warnings, { camera: true, screen: false })).toEqual([
      warnings[1],
      warnings[2]
    ])
    expect(uncoveredDeviceWarnings(warnings, { camera: true, screen: true })).toEqual([warnings[2]])
    expect(uncoveredDeviceWarnings(warnings, { camera: false, screen: false })).toEqual(warnings)
  })
})
