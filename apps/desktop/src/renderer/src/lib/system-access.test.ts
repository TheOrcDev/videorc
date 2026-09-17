import { describe, expect, it } from 'vitest'

import type { AudioMeterResult, DeviceList } from '@/lib/backend'

import {
  cameraAccessState,
  isMediaAccessSnapshotReady,
  mediaAccessToState,
  microphoneAccessState,
  screenAccessState,
  shouldShowPermissionsOnboarding,
  systemAccessAction,
  systemAccessRows
} from './system-access'

function devices(list: Partial<DeviceList['devices'][number]>[]): DeviceList {
  return {
    devices: list.map((device, index) => ({
      id: device.id ?? `device-${index}`,
      name: device.name ?? `Device ${index}`,
      kind: device.kind ?? 'camera',
      status: device.status ?? 'available'
    })),
    warnings: []
  }
}

describe('screenAccessState', () => {
  it('reports not-granted when enumeration hits the permission placeholder', () => {
    expect(
      screenAccessState(
        devices([
          { id: 'screen:screencapturekit-missing', kind: 'screen', status: 'permission-required' }
        ])
      )
    ).toBe('not-granted')
  })
  it('reports granted for an available ScreenCaptureKit display', () => {
    expect(
      screenAccessState(
        devices([{ id: 'screen:screencapturekit:1', kind: 'screen', status: 'available' }])
      )
    ).toBe('granted')
  })
  it('stays honest (first-use) with no signal', () => {
    expect(screenAccessState(devices([]))).toBe('first-use')
  })
})

describe('cameraAccessState', () => {
  it('not-granted beats available (any blocked camera means the grant is missing)', () => {
    expect(
      cameraAccessState(
        devices([
          { kind: 'camera', status: 'permission-required' },
          { kind: 'camera', status: 'available' }
        ])
      )
    ).toBe('not-granted')
  })
  it('granted when cameras enumerate as available', () => {
    expect(cameraAccessState(devices([{ kind: 'camera', status: 'available' }]))).toBe('granted')
  })
})

describe('microphoneAccessState', () => {
  const meter = (status: AudioMeterResult['status']): AudioMeterResult => ({ status })
  it('maps probe results to states, never guessing green', () => {
    expect(microphoneAccessState(null)).toBe('first-use')
    expect(microphoneAccessState(meter('permission-required'))).toBe('not-granted')
    expect(microphoneAccessState(meter('no-frames'))).toBe('device-issue')
    expect(microphoneAccessState(meter('ready'))).toBe('granted')
    expect(microphoneAccessState(meter('silent'))).toBe('granted')
  })
})

describe('isMediaAccessSnapshotReady', () => {
  it('does not let automatic onboarding decide from an unknown OS snapshot', () => {
    expect(isMediaAccessSnapshotReady({ camera: 'unknown', microphone: 'not-determined' })).toBe(
      false
    )
  })
})

describe('shouldShowPermissionsOnboarding', () => {
  const allGranted = systemAccessRows({
    deviceList: devices([
      { id: 'screen:screencapturekit:1', kind: 'screen', status: 'available' },
      { kind: 'camera', status: 'available' }
    ]),
    audioMeter: { status: 'ready' }
  })
  const missingSome = systemAccessRows({
    deviceList: devices([
      { id: 'screen:screencapturekit-missing', kind: 'screen', status: 'permission-required' }
    ]),
    audioMeter: null
  })

  it('shows for a fresh machine with missing grants', () => {
    expect(
      shouldShowPermissionsOnboarding({ rows: missingSome, dismissed: false, backendReady: true })
    ).toBe(true)
  })
  it('never shows when every grant already exists (reinstalls skip onboarding)', () => {
    expect(
      shouldShowPermissionsOnboarding({ rows: allGranted, dismissed: false, backendReady: true })
    ).toBe(false)
  })
  it('first-use counts as missing — that is what drives the native prompts', () => {
    const firstUse = systemAccessRows({ deviceList: devices([]), audioMeter: null })
    expect(
      shouldShowPermissionsOnboarding({ rows: firstUse, dismissed: false, backendReady: true })
    ).toBe(true)
  })
  it('does not show for a mic device issue because permissions are not the fix', () => {
    const noFrames = systemAccessRows({
      deviceList: devices([
        { id: 'screen:screencapturekit:1', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'available' }
      ]),
      audioMeter: {
        status: 'no-frames',
        message: 'This microphone opened but did not send audio frames.'
      }
    })

    expect(
      shouldShowPermissionsOnboarding({ rows: noFrames, dismissed: false, backendReady: true })
    ).toBe(false)
    expect(noFrames[2].state).toBe('device-issue')
    expect(noFrames[2].detail).toMatch(/did not send audio frames/)
  })
  it('a dismissal snoozes it even with grants still missing', () => {
    expect(
      shouldShowPermissionsOnboarding({ rows: missingSome, dismissed: true, backendReady: true })
    ).toBe(false)
  })
  it('never shows before the backend has reported real device state', () => {
    expect(
      shouldShowPermissionsOnboarding({ rows: missingSome, dismissed: false, backendReady: false })
    ).toBe(false)
  })
  it('never evaluates before the exact media-access snapshot has loaded', () => {
    expect(
      shouldShowPermissionsOnboarding({
        rows: missingSome,
        dismissed: false,
        backendReady: true,
        mediaAccessReady: false
      })
    ).toBe(false)
  })
})

describe('systemAccessRows', () => {
  it('keeps a fresh macOS camera requestable when the backend collapses TCC states', () => {
    const rows = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'permission-required' }]),
      audioMeter: null,
      platform: 'darwin',
      mediaAccess: { camera: 'not-determined', microphone: 'not-determined' }
    })

    expect(rows.find((row) => row.id === 'camera')?.state).toBe('first-use')
    expect(rows.find((row) => row.id === 'microphone')?.state).toBe('first-use')
  })

  it.each(['denied', 'restricted'] as const)(
    'uses the exact macOS %s state instead of the lossy backend placeholder',
    (status) => {
      const rows = systemAccessRows({
        deviceList: devices([{ kind: 'camera', status: 'permission-required' }]),
        audioMeter: { status: 'permission-required' },
        platform: 'darwin',
        mediaAccess: { camera: status, microphone: status }
      })

      expect(rows.find((row) => row.id === 'camera')?.state).toBe('not-granted')
      expect(rows.find((row) => row.id === 'microphone')?.state).toBe('not-granted')
      if (status === 'restricted') {
        expect(rows.find((row) => row.id === 'camera')?.detail).toMatch(/restricted/i)
        expect(rows.find((row) => row.id === 'microphone')?.detail).toMatch(/restricted/i)
      }
    }
  )

  it('requires backend device health before a macOS grant is shown as healthy', () => {
    const healthy = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'available' }]),
      audioMeter: { status: 'ready' },
      platform: 'darwin',
      mediaAccess: { camera: 'granted', microphone: 'granted' }
    })
    const unhealthy = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'unavailable' }]),
      audioMeter: { status: 'no-frames' },
      platform: 'darwin',
      mediaAccess: { camera: 'granted', microphone: 'granted' }
    })

    expect(healthy.find((row) => row.id === 'camera')?.state).toBe('granted')
    expect(healthy.find((row) => row.id === 'microphone')?.state).toBe('granted')
    expect(unhealthy.find((row) => row.id === 'camera')?.state).toBe('device-issue')
    expect(unhealthy.find((row) => row.id === 'microphone')?.state).toBe('device-issue')
    expect(unhealthy.find((row) => row.id === 'camera')?.detail).toMatch(
      /permission is granted.*no usable camera/i
    )
  })

  it('accepts an enumerated microphone as healthy before an optional meter check', () => {
    const rows = systemAccessRows({
      deviceList: devices([
        { kind: 'camera', status: 'available' },
        { kind: 'microphone', status: 'available' }
      ]),
      audioMeter: null,
      platform: 'darwin',
      mediaAccess: { camera: 'granted', microphone: 'granted' }
    })

    expect(rows.find((row) => row.id === 'microphone')?.state).toBe('granted')
  })

  it('keeps a proven microphone backend failure visible after permission is granted', () => {
    const rows = systemAccessRows({
      deviceList: devices([{ kind: 'microphone', status: 'available' }]),
      audioMeter: { status: 'unavailable' },
      platform: 'darwin',
      mediaAccess: { camera: 'granted', microphone: 'granted' }
    })

    expect(rows.find((row) => row.id === 'microphone')?.state).toBe('device-issue')
  })

  it('does not repeat stale permission-required meter copy after an exact microphone grant', () => {
    const rows = systemAccessRows({
      deviceList: devices([{ kind: 'microphone', status: 'available' }]),
      audioMeter: {
        status: 'permission-required',
        message: 'Microphone permission is required.'
      },
      platform: 'darwin',
      mediaAccess: { camera: 'granted', microphone: 'granted' }
    })

    const microphone = rows.find((row) => row.id === 'microphone')
    expect(microphone?.state).toBe('device-issue')
    expect(microphone?.detail).toMatch(/permission is granted/i)
    expect(microphone?.detail).not.toMatch(/permission is required/i)
  })

  it('falls back to backend evidence when the exact macOS status is unknown or missing', () => {
    const unknown = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'permission-required' }]),
      audioMeter: { status: 'ready' },
      platform: 'darwin',
      mediaAccess: { camera: 'unknown', microphone: 'unknown' }
    })
    const missing = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'available' }]),
      audioMeter: { status: 'permission-required' },
      platform: 'darwin'
    })

    expect(unknown.find((row) => row.id === 'camera')?.state).toBe('not-granted')
    expect(unknown.find((row) => row.id === 'microphone')?.state).toBe('granted')
    expect(missing.find((row) => row.id === 'camera')?.state).toBe('granted')
    expect(missing.find((row) => row.id === 'microphone')?.state).toBe('not-granted')
  })

  it('renders three rows with purposes and honest details', () => {
    const rows = systemAccessRows({
      deviceList: devices([
        { id: 'screen:screencapturekit:1', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'permission-required' }
      ]),
      audioMeter: null,
      platform: 'darwin'
    })
    expect(rows.map((row) => row.id)).toEqual(['screen-recording', 'camera', 'microphone'])
    expect(rows[0].state).toBe('granted')
    expect(rows[1].state).toBe('not-granted')
    expect(rows[1].detail).toMatch(/System Settings/)
    expect(rows[2].state).toBe('first-use')
    expect(rows[2].detail).toMatch(/mic check/)
  })

  it('omits the Screen Recording row on Windows (no per-app screen permission)', () => {
    const rows = systemAccessRows({
      deviceList: devices([
        { id: 'screen:gdigrab:desktop', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'available' }
      ]),
      audioMeter: { status: 'ready' },
      platform: 'win32'
    })
    expect(rows.map((row) => row.id)).toEqual(['camera', 'microphone'])
    // No "macOS" / "System Settings" wording leaks to Windows users.
    for (const row of rows) {
      expect(row.detail).not.toMatch(/macOS|System Settings/)
    }
  })

  it('does not wedge onboarding open on a healthy Windows machine', () => {
    // Windows: camera available (granted), mic meter ready (granted), no screen
    // row — the dialog must be satisfiable, unlike the old screencapturekit +
    // CoreAudio-only derivation that left it permanently first-use.
    const rows = systemAccessRows({
      deviceList: devices([
        { id: 'screen:gdigrab:desktop', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'available' }
      ]),
      audioMeter: { status: 'ready' },
      platform: 'win32'
    })
    expect(shouldShowPermissionsOnboarding({ rows, dismissed: false, backendReady: true })).toBe(
      false
    )
  })

  it('derives Windows camera/mic from the real OS access status, not the meter', () => {
    // The tester's exact case: mic meter is 'unavailable' (no Windows backend)
    // and the camera enumerates, but the OS says microphone is denied. The chip
    // must reflect the OS, not sit on a misleading "first use".
    const rows = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'available' }]),
      audioMeter: { status: 'unavailable' },
      platform: 'win32',
      mediaAccess: { camera: 'granted', microphone: 'denied' }
    })
    const mic = rows.find((row) => row.id === 'microphone')
    const camera = rows.find((row) => row.id === 'camera')
    expect(camera?.state).toBe('granted')
    expect(mic?.state).toBe('not-granted')
    // Windows guidance points at the umbrella toggle and says the app isn't listed.
    expect(mic?.detail).toMatch(/Let desktop apps access your microphone/)
    expect(mic?.detail).toMatch(/isn.t listed by name/)
  })

  it('falls back to backend evidence when the exact Windows status is unknown', () => {
    const rows = systemAccessRows({
      deviceList: devices([{ kind: 'camera', status: 'available' }]),
      audioMeter: { status: 'permission-required' },
      platform: 'win32',
      mediaAccess: { camera: 'unknown', microphone: 'unknown' }
    })

    expect(rows.find((row) => row.id === 'camera')?.state).toBe('granted')
    expect(rows.find((row) => row.id === 'microphone')?.state).toBe('not-granted')
  })

  it('mediaAccessToState maps OS statuses to chip states', () => {
    expect(mediaAccessToState('granted')).toBe('granted')
    expect(mediaAccessToState('denied')).toBe('not-granted')
    expect(mediaAccessToState('restricted')).toBe('not-granted')
    expect(mediaAccessToState('not-determined')).toBe('first-use')
    expect(mediaAccessToState('unknown')).toBe('first-use')
    expect(mediaAccessToState(undefined)).toBe('first-use')
  })
})

describe('systemAccessAction', () => {
  it('requests native macOS camera and microphone access only on first use', () => {
    expect(
      systemAccessAction({
        pane: 'camera',
        state: 'first-use',
        platform: 'darwin',
        mediaAccessStatus: 'not-determined'
      })
    ).toBe('request-media-access')
    expect(
      systemAccessAction({
        pane: 'microphone',
        state: 'first-use',
        platform: 'darwin',
        mediaAccessStatus: 'not-determined'
      })
    ).toBe('request-media-access')
  })

  it('opens settings for denied media, screen recording, privacy, and Windows', () => {
    expect(systemAccessAction({ pane: 'camera', state: 'not-granted', platform: 'darwin' })).toBe(
      'open-settings'
    )
    expect(
      systemAccessAction({ pane: 'screen-recording', state: 'first-use', platform: 'darwin' })
    ).toBe('open-settings')
    expect(systemAccessAction({ pane: 'privacy', state: 'first-use', platform: 'darwin' })).toBe(
      'open-settings'
    )
    expect(systemAccessAction({ pane: 'camera', state: 'first-use', platform: 'win32' })).toBe(
      'open-settings'
    )
  })

  it('does not offer another permission action after a grant or for a device issue', () => {
    expect(systemAccessAction({ pane: 'camera', state: 'granted', platform: 'darwin' })).toBeNull()
    expect(
      systemAccessAction({ pane: 'microphone', state: 'device-issue', platform: 'darwin' })
    ).toBeNull()
    expect(
      systemAccessAction({
        pane: 'microphone',
        state: 'first-use',
        platform: 'darwin',
        mediaAccessStatus: 'granted'
      })
    ).toBeNull()
  })

  it('never invents a native prompt when the exact macOS status is missing or unknown', () => {
    expect(systemAccessAction({ pane: 'camera', state: 'first-use', platform: 'darwin' })).toBe(
      'open-settings'
    )
    expect(
      systemAccessAction({
        pane: 'microphone',
        state: 'first-use',
        platform: 'darwin',
        mediaAccessStatus: 'unknown'
      })
    ).toBe('open-settings')
  })
})
