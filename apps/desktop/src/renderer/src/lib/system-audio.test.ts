import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AudioTrack, Device } from '@/lib/backend'
import {
  SYSTEM_AUDIO_RESUME_EVENT,
  confirmedSystemAudioMix,
  systemAudioDevice,
  systemAudioIdleReason,
  systemAudioIssueCopy,
  systemAudioIssueFromHealthEvent,
  systemAudioSwitchView,
  systemAudioTarget,
  type SystemAudioSwitchInput
} from './system-audio'

const available: Pick<Device, 'status'> = { status: 'available' }

function view(overrides: Partial<SystemAudioSwitchInput>) {
  return systemAudioSwitchView({
    device: available,
    requested: false,
    sessionActive: false,
    audioBusActive: false,
    confirmed: null,
    issue: null,
    ...overrides
  })
}

function track(mixSources?: AudioTrack['mixSources']): AudioTrack {
  return {
    id: 'microphone',
    label: 'Microphone',
    source: 'microphone',
    ...(mixSources ? { mixSources } : {})
  }
}

describe('systemAudioDevice', () => {
  it('finds the one system-audio device by id, then by kind', () => {
    const device: Device = {
      id: 'system-audio:default',
      name: 'System audio',
      kind: 'system-audio',
      status: 'available'
    }
    const mic: Device = { id: 'mic:1', name: 'Mic', kind: 'microphone', status: 'available' }
    expect(systemAudioDevice({ devices: [mic, device], warnings: [] })).toBe(device)
    const legacy = { ...device, id: 'system-audio:native-adapter-pending' }
    expect(systemAudioDevice({ devices: [mic, legacy], warnings: [] })).toBe(legacy)
    expect(systemAudioDevice({ devices: [mic], warnings: [] })).toBeUndefined()
  })
})

describe('confirmedSystemAudioMix', () => {
  it('is null until a track reports its mix, then says whether system audio is in it', () => {
    expect(confirmedSystemAudioMix(undefined)).toBeNull()
    expect(confirmedSystemAudioMix([])).toBeNull()
    expect(confirmedSystemAudioMix([track()])).toBeNull()
    expect(confirmedSystemAudioMix([track(['microphone'])])).toBe(false)
    expect(confirmedSystemAudioMix([track(['microphone', 'system-audio'])])).toBe(true)
    expect(confirmedSystemAudioMix([track(), track(['system-audio'])])).toBe(true)
  })
})

describe('systemAudioIssueFromHealthEvent', () => {
  it('maps only the system-audio codes', () => {
    expect(systemAudioIssueFromHealthEvent({ code: 'system-audio-lost' })).toBe('lost')
    expect(systemAudioIssueFromHealthEvent({ code: 'system-audio-unavailable' })).toBe(
      'unavailable'
    )
    // Windows (plan 069 S8): the mic fell back to a direct input.
    expect(systemAudioIssueFromHealthEvent({ code: 'system-audio-mic-fallback-bypass' })).toBe(
      'bypassed'
    )
    expect(systemAudioIssueCopy('bypassed')).toBe(
      'System audio is off until you stop, because the microphone is on a fallback input.'
    )
    expect(systemAudioIssueFromHealthEvent({ code: 'microphone-input-lost' })).toBeNull()
  })

  it('maps the echo guard pause, and a recovery is not an issue (plan 076)', () => {
    expect(systemAudioIssueFromHealthEvent({ code: 'system-audio-echo-paused' })).toBe('echo')
    expect(systemAudioIssueFromHealthEvent({ code: 'system-audio-recovered' })).toBeNull()
    expect(systemAudioIssueCopy('echo', 'darwin')).toBe(
      'Paused: your stream is playing on this Mac and coming back as an echo. Mute that tab, then resume.'
    )
    // Plan 174 C-30: a Windows PC is never "this Mac".
    expect(systemAudioIssueCopy('echo', 'win32')).toContain('playing on this PC')
    expect(systemAudioIssueCopy('echo', 'linux')).toContain('playing on this computer')
  })

  it('names the event the Studio listens to for Resume', () => {
    const studio = readFileSync(
      fileURLToPath(new URL('../hooks/use-studio.tsx', import.meta.url)),
      'utf8'
    )
    expect(studio).toContain(`window.addEventListener('${SYSTEM_AUDIO_RESUME_EVENT}', resume)`)
  })
})

describe('systemAudioSwitchView', () => {
  it('uses the Clips bus confirmation, pending and issue states without owning transport', () => {
    const clips = { audioBusActive: true, sessionActive: false }
    expect(view({ ...clips, requested: true, confirmed: true })).toMatchObject({
      checked: true,
      meter: true,
      pending: null,
      issue: null,
      stateLabel: 'On'
    })
    expect(view({ ...clips, requested: true, confirmed: false })).toMatchObject({
      checked: false,
      meter: false,
      pending: 'on',
      stateLabel: 'Turning on…'
    })
    expect(view({ ...clips, requested: false, confirmed: true })).toMatchObject({
      checked: true,
      meter: false,
      pending: 'off',
      stateLabel: 'Turning off…'
    })
    expect(view({ ...clips, requested: true, confirmed: false, issue: 'echo' })).toMatchObject({
      checked: true,
      meter: false,
      pending: null,
      issue: 'echo',
      stateLabel: 'Paused'
    })
    expect(view({ ...clips, requested: true, confirmed: false, issue: 'lost' })).toMatchObject({
      checked: true,
      meter: false,
      pending: null,
      issue: 'lost'
    })
  })

  it('ignores old confirmation and issues without a running bus, including a transport start', () => {
    for (const sessionActive of [false, true]) {
      expect(
        view({
          audioBusActive: false,
          sessionActive,
          requested: true,
          confirmed: false,
          issue: 'lost'
        })
      ).toMatchObject({
        checked: true,
        pending: null,
        issue: null,
        meter: false,
        stateLabel: 'On'
      })
    }
  })

  it('hides the row when the device is missing or unsupported, never a permanent Unavailable', () => {
    expect(view({ device: undefined }).visible).toBe(false)
    expect(view({ device: { status: 'unavailable' }, requested: true }).visible).toBe(false)
  })

  it('disables the switch and shows it Off while Screen Recording permission is missing', () => {
    expect(view({ device: { status: 'permission-required' }, requested: true })).toMatchObject({
      visible: true,
      permissionRequired: true,
      checked: false,
      disabled: true,
      meter: false
    })
  })

  it('shows the requested state with On/Off text when no session runs', () => {
    expect(view({ requested: false })).toMatchObject({
      checked: false,
      disabled: false,
      stateLabel: 'Off',
      meter: false
    })
    expect(view({ requested: true })).toMatchObject({
      checked: true,
      stateLabel: 'On',
      meter: false
    })
  })

  it('falls back to the requested state until the session reports its mix', () => {
    expect(
      view({ sessionActive: true, audioBusActive: true, requested: true, confirmed: null })
    ).toMatchObject({
      checked: true,
      pending: null,
      meter: true,
      stateLabel: 'On'
    })
  })

  it('shows the confirmed state, not the optimistic click, while a change is in flight', () => {
    expect(
      view({ sessionActive: true, audioBusActive: true, requested: true, confirmed: false })
    ).toMatchObject({
      checked: false,
      pending: 'on',
      meter: false,
      stateLabel: 'Turning on…'
    })
    expect(
      view({ sessionActive: true, audioBusActive: true, requested: false, confirmed: true })
    ).toMatchObject({
      checked: true,
      pending: 'off',
      meter: false,
      stateLabel: 'Turning off…'
    })
    expect(
      view({ sessionActive: true, audioBusActive: true, requested: true, confirmed: true })
    ).toMatchObject({
      checked: true,
      pending: null,
      meter: true,
      stateLabel: 'On'
    })
    expect(
      view({ sessionActive: true, audioBusActive: true, requested: false, confirmed: false })
    ).toMatchObject({
      checked: false,
      meter: false,
      stateLabel: 'Off'
    })
  })

  it('keeps the switch as the user set it when a health issue explains the missing mix', () => {
    expect(
      view({
        sessionActive: true,
        audioBusActive: true,
        requested: true,
        confirmed: false,
        issue: 'lost'
      })
    ).toMatchObject({ checked: true, pending: null, issue: 'lost', meter: false })
    expect(
      view({
        sessionActive: true,
        audioBusActive: true,
        requested: true,
        confirmed: null,
        issue: 'unavailable'
      })
    ).toMatchObject({ checked: true, issue: 'unavailable', meter: false })
    // A later confirmed attach or the user turning it Off retires the issue.
    expect(
      view({
        sessionActive: true,
        audioBusActive: true,
        requested: true,
        confirmed: true,
        issue: 'lost'
      }).issue
    ).toBeNull()
    expect(
      view({
        sessionActive: true,
        audioBusActive: true,
        requested: false,
        confirmed: false,
        issue: 'lost'
      }).issue
    ).toBeNull()
  })

  it('says Paused while the echo guard holds system audio out (plan 076)', () => {
    expect(
      view({
        sessionActive: true,
        audioBusActive: true,
        requested: true,
        confirmed: false,
        issue: 'echo'
      })
    ).toMatchObject({ checked: true, issue: 'echo', meter: false, stateLabel: 'Paused' })
  })
})

describe('systemAudioIdleReason (plan 201)', () => {
  const idle = {
    audioBusActive: false,
    clipsArmed: false,
    clipsState: 'off',
    checked: true
  } as const

  it('explains an enabled source with Clips off, refused or given up', () => {
    expect(systemAudioIdleReason(idle)).toBe('clips-off')
    expect(systemAudioIdleReason({ ...idle, clipsState: 'error' })).toBe('clips-off')
    expect(systemAudioIdleReason({ ...idle, clipsArmed: true, clipsState: 'error' })).toBe(
      'clips-off'
    )
  })

  it('has no idle reason while a bus runs or System audio is Off', () => {
    for (const clipsState of ['off', 'starting', 'on', 'error'] as const) {
      expect(systemAudioIdleReason({ ...idle, clipsState, audioBusActive: true })).toBeNull()
      expect(systemAudioIdleReason({ ...idle, clipsState, checked: false })).toBeNull()
    }
  })

  it('stays quiet while an armed ring starts, restarts or awaits its bus status', () => {
    for (const clipsState of ['off', 'starting', 'on'] as const) {
      expect(systemAudioIdleReason({ ...idle, clipsArmed: true, clipsState })).toBeNull()
    }
    expect(systemAudioIdleReason({ ...idle, clipsState: 'starting' })).toBeNull()
  })
})

describe('systemAudioTarget (plan 069 S6)', () => {
  it('flips the shown state and sets the explicit forms, only while the device can run', () => {
    expect(systemAudioTarget('toggle', 'available', false)).toBe(true)
    expect(systemAudioTarget('toggle', 'available', true)).toBe(false)
    expect(systemAudioTarget('on', 'available', true)).toBe(true)
    expect(systemAudioTarget('off', 'available', false)).toBe(false)
    for (const status of ['permission-required', 'unavailable', undefined] as const) {
      for (const mode of ['on', 'off', 'toggle'] as const) {
        expect(systemAudioTarget(mode, status, false)).toBeNull()
      }
    }
  })
})
