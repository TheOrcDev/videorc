import { describe, expect, it } from 'vitest'

import type { AudioMeterResult, DeviceList } from '@/lib/backend'

import {
  cameraAccessState,
  isMediaAccessSnapshotReady,
  mediaAccessToState,
  microphoneAccessState,
  screenAccessState,
  mediaAccessStatusForPane,
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
    expect(
      isMediaAccessSnapshotReady({
        camera: 'unknown',
        microphone: 'not-determined',
        screen: 'not-determined'
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
      /Granted, but no camera is connected/i
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

  it('renders four rows with purposes and honest details', () => {
    const rows = systemAccessRows({
      deviceList: devices([
        { id: 'screen:screencapturekit:1', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'permission-required' }
      ]),
      audioMeter: null,
      platform: 'darwin'
    })
    expect(rows.map((row) => row.id)).toEqual([
      'screen-recording',
      'system-audio',
      'microphone',
      'camera'
    ])
    expect(rows[0].state).toBe('granted')
    expect(rows[3].state).toBe('not-granted')
    expect(rows[3].detail).toMatch(/System Settings/)
    expect(rows[2].state).toBe('first-use')
    expect(rows[2].detail).toBe('')
  })

  it('shows screen and system audio facts on Windows', () => {
    const rows = systemAccessRows({
      deviceList: devices([
        { id: 'screen:gdigrab:desktop', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'available' }
      ]),
      audioMeter: { status: 'ready' },
      platform: 'win32'
    })
    expect(rows.map((row) => row.id)).toEqual([
      'screen-recording',
      'system-audio',
      'microphone',
      'camera'
    ])
    expect(rows.slice(0, 2).map((row) => row.state)).toEqual(['not-required', 'not-required'])
    // No "macOS" / "System Settings" wording leaks to Windows users.
    for (const row of rows) {
      expect(row.detail).not.toMatch(/macOS|System Settings/)
    }
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

  it('hides every permission chip on Linux, where the OS has no grant to report', () => {
    // main answers 'not-applicable' on Linux (Electron has no
    // getMediaAccessStatus there); a row that could only ever read first-use
    // would push onboarding open on every launch, so no row is rendered.
    const rows = systemAccessRows({
      deviceList: devices([
        { id: 'screen:pipewire:portal', kind: 'screen', status: 'available' },
        { kind: 'camera', status: 'available' }
      ]),
      audioMeter: null,
      platform: 'linux',
      mediaAccess: { camera: 'not-applicable', microphone: 'not-applicable' }
    })
    expect(rows).toEqual([])
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

  it('asks for a never-asked screen in place on macOS (plan 203 S2), Settings otherwise', () => {
    expect(
      systemAccessAction({
        pane: 'screen-recording',
        state: 'not-granted',
        platform: 'darwin',
        mediaAccessStatus: 'not-determined'
      })
    ).toBe('request-media-access')
    expect(
      systemAccessAction({
        pane: 'screen-recording',
        state: 'not-granted',
        platform: 'darwin',
        mediaAccessStatus: 'denied'
      })
    ).toBe('open-settings')
    expect(
      systemAccessAction({
        pane: 'screen-recording',
        state: 'granted',
        platform: 'darwin',
        mediaAccessStatus: 'granted'
      })
    ).toBeNull()
    expect(
      systemAccessAction({
        pane: 'screen-recording',
        state: 'not-granted',
        platform: 'win32',
        mediaAccessStatus: 'not-determined'
      })
    ).toBe('open-settings')
  })
})

describe('mediaAccessStatusForPane', () => {
  it('reads each row its own grant, the screen row the Screen Recording grant, privacy none', () => {
    const snapshot = {
      camera: 'granted',
      microphone: 'denied',
      screen: 'not-determined'
    } as const
    expect(mediaAccessStatusForPane(snapshot, 'camera')).toBe('granted')
    expect(mediaAccessStatusForPane(snapshot, 'microphone')).toBe('denied')
    expect(mediaAccessStatusForPane(snapshot, 'screen-recording')).toBe('not-determined')
    expect(mediaAccessStatusForPane(snapshot, 'privacy')).toBeUndefined()
    expect(mediaAccessStatusForPane(null, 'screen-recording')).toBeUndefined()
    expect(
      mediaAccessStatusForPane({ camera: 'granted', microphone: 'granted' }, 'screen-recording')
    ).toBeUndefined()
  })
})

describe('first-run permission state matrix (plan 203 S3)', () => {
  const blocked: DeviceList = {
    devices: [
      {
        id: 'screen:screencapturekit',
        kind: 'screen',
        name: 'Screen',
        status: 'permission-required'
      },
      {
        id: 'system-audio',
        kind: 'system-audio',
        name: 'System audio',
        status: 'permission-required',
        detail: 'System audio needs the Screen Recording permission.'
      }
    ],
    warnings: []
  }
  const healthy: DeviceList = {
    devices: [
      { id: 'screen:screencapturekit:1', kind: 'screen', name: 'Display', status: 'available' },
      { id: 'system-audio', kind: 'system-audio', name: 'System audio', status: 'available' },
      { id: 'mic', kind: 'microphone', name: 'Microphone', status: 'available' },
      { id: 'camera', kind: 'camera', name: 'FaceTime HD Camera', status: 'available' }
    ],
    warnings: []
  }
  function rows(overrides: Partial<Parameters<typeof systemAccessRows>[0]> = {}) {
    return systemAccessRows({
      platform: 'darwin',
      deviceList: blocked,
      audioMeter: null,
      mediaAccess: {
        screen: 'not-determined',
        camera: 'not-determined',
        microphone: 'not-determined'
      },
      ...overrides
    })
  }
  const granted = { screen: 'granted', camera: 'granted', microphone: 'granted' } as const
  const action = (
    row: ReturnType<typeof rows>[number],
    status: 'restricted' | 'granted' | 'not-determined' = 'not-determined'
  ) =>
    systemAccessAction({
      pane: row.id,
      state: row.state,
      checking: row.checking,
      platform: 'darwin',
      mediaAccessStatus: status
    })

  it.each([
    ['23.6.0', 'Screen Recording'],
    ['24.0.0', 'Screen & System Audio Recording'],
    ['26.1.0', 'Screen & System Audio Recording']
  ])('names the real pane on Darwin %s', (osRelease, pane) => {
    const screen = rows({
      osRelease,
      pendingPane: 'screen-recording',
      permissionTargetName: 'Electron'
    })[0]
    expect(screen.state).toBe('waiting')
    expect(screen.detail).toBe(
      `Turn on Electron in System Settings → Privacy & Security → ${pane}, then come back here.`
    )
    expect(rows({ osRelease, mediaAccess: { screen: 'denied' } })[0].detail).toContain(pane)
  })

  it('moves from never asked through waiting and checking to the replacement grant', () => {
    const initial = rows()
    expect(initial.map((row) => row.id)).toEqual([
      'screen-recording',
      'system-audio',
      'microphone',
      'camera'
    ])
    expect(initial.map((row) => row.required)).toEqual([true, false, true, false])
    expect(initial[0].state).toBe('first-use')
    expect(action(initial[0])).toBe('request-media-access')
    const waiting = rows({ pendingPane: 'screen-recording' })
    expect(waiting[0].state).toBe('waiting')
    expect(waiting[1].state).toBe('waiting')
    expect(waiting[1].detail).toBe('Comes with Screen Recording.')
    expect(action(waiting[0])).toBe('open-settings')
    const checking = rows({
      mediaAccess: granted,
      captureRestarting: true,
      screenGrantStale: true,
      lastKnownStates: { 'screen-recording': 'waiting', 'system-audio': 'waiting' }
    })
    expect(checking[0]).toMatchObject({ state: 'waiting', checking: true, detail: '' })
    expect(action(checking[0], 'granted')).toBeNull()
    const ready = rows({ mediaAccess: granted, deviceList: healthy })
    expect(ready.every((row) => row.state === 'granted' && !row.checking)).toBe(true)
    expect(ready[3].detail).toBe('FaceTime HD Camera')
  })

  it.each([
    'first-use',
    'waiting',
    'granted',
    'not-granted',
    'device-issue',
    'needs-relaunch'
  ] as const)(
    'checking preserves a usable chip from %s and never reads not-granted',
    (previous) => {
      const checking = rows({
        mediaAccess: granted,
        captureRestarting: true,
        lastKnownStates: { 'screen-recording': previous, microphone: previous, camera: previous }
      })
      expect(
        checking.every((row) => row.checking && row.state !== 'not-granted' && row.detail === '')
      ).toBe(true)
      if (previous === 'granted' || previous === 'waiting' || previous === 'first-use')
        expect(checking[0].state).toBe(previous)
    }
  )

  it('requires a fresh replacement device list before showing Reopen', () => {
    expect(rows({ mediaAccess: granted, screenGrantStale: true })[0]).toMatchObject({
      checking: true,
      state: 'first-use'
    })
    const screen = rows({ mediaAccess: granted, screenGrantStale: false })[0]
    expect(screen).toMatchObject({
      checking: false,
      state: 'needs-relaunch',
      detail: 'macOS turns this on after Videorc reopens.'
    })
    expect(action(screen, 'granted')).toBe('relaunch')
  })

  it.each(['denied', 'restricted'] as const)(
    'shows an exact %s decision, even against healthy devices',
    (status) => {
      const result = rows({
        deviceList: healthy,
        mediaAccess: { screen: status, camera: status, microphone: status }
      })
      expect(result.every((row) => row.state === 'not-granted')).toBe(true)
      expect(result[1].detail).toBe('Comes with Screen Recording.')
      if (status === 'restricted') {
        expect(result[0].detail).toBe('Restricted by macOS policy and may not be changeable here.')
        expect(action(result[0], 'restricted')).toBeNull()
      } else expect(result[0].detail).toContain('Turn on Videorc')
    }
  )

  it('reports missing cameras after a real grant without another permission action', () => {
    const camera = rows({ deviceList: { devices: [], warnings: [] }, mediaAccess: granted })[3]
    expect(camera).toMatchObject({
      state: 'device-issue',
      detail: 'Granted, but no camera is connected.'
    })
    expect(action(camera, 'granted')).toBeNull()
  })

  it('refines system audio only after the screen grant and never offers it an action', () => {
    const unsupported: DeviceList = {
      devices: [
        {
          id: 'system-audio',
          kind: 'system-audio',
          name: 'System audio',
          status: 'unavailable',
          detail: 'System audio is not supported on this Mac.'
        }
      ],
      warnings: []
    }
    expect(rows({ deviceList: unsupported })[1]).toMatchObject({
      state: 'first-use',
      detail: 'Comes with Screen Recording.'
    })
    const audio = rows({ deviceList: unsupported, mediaAccess: granted })[1]
    expect(audio).toMatchObject({ state: 'unavailable', detail: unsupported.devices[0].detail })
    for (const state of [
      'first-use',
      'waiting',
      'needs-relaunch',
      'unavailable',
      'granted'
    ] as const) {
      expect(action({ ...audio, state })).toBeNull()
    }
  })

  it.each([true, false])('Windows loopback supported: %s', (supported) => {
    const result = rows({
      platform: 'win32',
      mediaAccess: { screen: 'not-applicable', camera: 'denied', microphone: 'denied' },
      deviceList: {
        devices: [
          {
            id: 'system-audio',
            kind: 'system-audio',
            name: 'System audio',
            status: supported ? 'available' : 'unavailable',
            detail: 'System audio needs a newer Windows build.'
          }
        ],
        warnings: []
      }
    })
    expect(result.map((row) => row.required)).toEqual([false, false, true, false])
    expect(result[0]).toMatchObject({
      state: 'not-required',
      detail: "Windows doesn't ask for this."
    })
    expect(result[1]).toMatchObject(
      supported
        ? { state: 'not-required', detail: "Windows doesn't ask for this." }
        : { state: 'unavailable', detail: 'System audio needs a newer Windows build.' }
    )
    expect(result[2].detail).toContain('Let desktop apps access your microphone')
    expect(result[3].detail).toContain('Let desktop apps access your camera')
  })

  it('Linux has no standing grant rows, even before the exact snapshot loads', () => {
    expect(rows({ platform: 'linux', mediaAccess: null })).toEqual([])
  })
})
