import { describe, expect, it } from 'vitest'

import {
  openPermissionSettingsLabel,
  showHelperLabel,
  sourcePermissionAlerts,
  type MediaPermissionInput
} from '@/lib/source-permissions'

// Plan 174 S3.8 (C-8, C-14): one curated alert per missing permission.

const granted: MediaPermissionInput = { state: 'granted', action: null, chosen: true }

function alerts(overrides: Partial<Parameters<typeof sourcePermissionAlerts>[0]> = {}) {
  return sourcePermissionAlerts({
    platform: 'darwin',
    targetName: 'Videorc',
    screenRecording: false,
    camera: granted,
    microphone: granted,
    ...overrides
  })
}

describe('sourcePermissionAlerts', () => {
  it('says nothing while every grant is there', () => {
    expect(alerts()).toEqual([])
  })

  it('gives Screen Recording its pane, the helper and the relaunch', () => {
    const [screen] = alerts({ screenRecording: true, targetName: 'videorc-backend' })
    expect(screen).toEqual({
      id: 'screen-recording',
      title: 'Screen Recording permission is required for videorc-backend.',
      description:
        'Turn on videorc-backend in System Settings → Privacy & Security → Screen Recording, then quit and reopen Videorc.',
      actionLabel: 'Open Screen Recording settings',
      revealLabel: 'Show helper in Finder'
    })
  })

  it('never alerts for a camera or microphone nobody chose', () => {
    const denied: MediaPermissionInput = {
      state: 'not-granted',
      action: 'open-settings',
      chosen: false
    }
    expect(alerts({ camera: denied, microphone: denied })).toEqual([])
  })

  it('alerts for a chosen microphone, with the settings pane it opens (C-14)', () => {
    const [microphone] = alerts({
      microphone: { state: 'not-granted', action: 'open-settings', chosen: true }
    })
    expect(microphone?.id).toBe('microphone')
    expect(microphone?.title).toBe('Microphone permission is required for Videorc.')
    expect(microphone?.description).toBe(
      'Turn on Videorc in System Settings → Privacy & Security → Microphone.'
    )
    expect(microphone?.actionLabel).toBe('Open Microphone settings')
    expect(microphone?.revealLabel).toBeNull()
  })

  it('asks through the OS prompt when macOS has not asked yet', () => {
    const [camera] = alerts({
      camera: { state: 'first-use', action: 'request-media-access', chosen: true }
    })
    expect(camera?.actionLabel).toBe('Allow access…')
    expect(camera?.description).toBe('macOS asks once. Choose Allow.')
  })

  it('names the Windows switch, never a list Videorc is not in', () => {
    const [camera] = alerts({
      platform: 'win32',
      camera: { state: 'not-granted', action: 'open-settings', chosen: true }
    })
    expect(camera?.description).toBe(
      'In Windows Settings → Privacy & security → Camera, turn on access and “Let desktop apps access your camera”.'
    )
    expect(camera?.description).not.toContain('Mac')
  })

  it('stays quiet when nothing is left to do or the state is unknown', () => {
    expect(alerts({ camera: { state: 'not-granted', action: null, chosen: true } })).toEqual([])
    expect(alerts({ camera: { state: undefined, action: 'open-settings', chosen: true } })).toEqual(
      []
    )
  })

  it('keeps page order: Screen Recording, Camera, Microphone', () => {
    const missing: MediaPermissionInput = {
      state: 'not-granted',
      action: 'open-settings',
      chosen: true
    }
    expect(
      alerts({ screenRecording: true, camera: missing, microphone: missing }).map(({ id }) => id)
    ).toEqual(['screen-recording', 'camera', 'microphone'])
  })
})

describe('permission labels', () => {
  it('names the pane and the file manager', () => {
    expect(openPermissionSettingsLabel('camera')).toBe('Open Camera settings')
    expect(showHelperLabel('darwin')).toBe('Show helper in Finder')
    expect(showHelperLabel('win32')).toBe('Show helper in Explorer')
    expect(showHelperLabel('linux')).toBe('Show helper in folder')
  })
})
