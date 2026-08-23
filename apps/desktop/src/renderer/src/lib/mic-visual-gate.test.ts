import { afterEach, describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS, defaultSettings, loadJson } from './capture'
import {
  audioMixerMonitorLabel,
  audioMixerMonitorWhenIdle,
  micVisualAnalyserEnabled,
  withAudioMixerMonitorWhenIdle,
  type MicVisualGateInput
} from './mic-visual-gate'

const ON_SCREEN: MicVisualGateInput = {
  workspaceVisible: true,
  documentVisible: true,
  microphoneSelected: true,
  muted: false,
  sessionActive: false,
  monitorWhenIdle: false
}

describe('micVisualAnalyserEnabled', () => {
  it('keeps the microphone closed in an idle Studio with monitoring off', () => {
    // The owner's complaint: bars reacting while not recording. Default OFF.
    expect(micVisualAnalyserEnabled(ON_SCREEN)).toBe(false)
  })

  it('arms the analyser for the whole session without touching the toggle', () => {
    expect(micVisualAnalyserEnabled({ ...ON_SCREEN, sessionActive: true })).toBe(true)
  })

  it('opens the analyser while idle only when the user asked to monitor input', () => {
    expect(micVisualAnalyserEnabled({ ...ON_SCREEN, monitorWhenIdle: true })).toBe(true)
  })

  it.each<[string, Partial<MicVisualGateInput>]>([
    ['the workspace tab is elsewhere', { workspaceVisible: false }],
    ['the document is hidden', { documentVisible: false }],
    ['no microphone is selected', { microphoneSelected: false }],
    ['the microphone is muted', { muted: true }]
  ])('stays closed when %s even if armed', (_label, overrides) => {
    const armed = { ...ON_SCREEN, sessionActive: true, monitorWhenIdle: true }
    expect(micVisualAnalyserEnabled({ ...armed, ...overrides })).toBe(false)
  })
})

describe('audioMixerMonitorLabel', () => {
  it('says Live only for a running session with a live signal path', () => {
    expect(audioMixerMonitorLabel({ sessionActive: true, signalLive: true })).toBe('Live')
  })

  it('says Monitoring for idle input monitoring that is actually delivering', () => {
    expect(audioMixerMonitorLabel({ sessionActive: false, signalLive: true })).toBe('Monitoring')
  })

  it('says Idle whenever nothing is being read, armed or not', () => {
    expect(audioMixerMonitorLabel({ sessionActive: false, signalLive: false })).toBe('Idle')
    // Muted mid-session: the path is not live, and the label must not claim it.
    expect(audioMixerMonitorLabel({ sessionActive: true, signalLive: false })).toBe('Idle')
  })
})

describe('audioMixer.monitorWhenIdle persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to off, including for settings persisted before the key existed', () => {
    expect(audioMixerMonitorWhenIdle(defaultSettings)).toBe(false)
    expect(audioMixerMonitorWhenIdle(undefined)).toBe(false)
    expect(audioMixerMonitorWhenIdle({ audioMixer: {} })).toBe(false)
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ outputDirectory: '/tmp/out', keepOriginalRecording: true }),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    expect(audioMixerMonitorWhenIdle(loadJson(STORAGE_KEYS.settings, defaultSettings))).toBe(false)
  })

  it('round-trips the toggle through the settings storage path', () => {
    const updated = withAudioMixerMonitorWhenIdle(defaultSettings, true)
    expect(updated).not.toBe(defaultSettings)
    expect(defaultSettings.audioMixer?.monitorWhenIdle).toBe(false)

    const stored = new Map<string, string>([[STORAGE_KEYS.settings, JSON.stringify(updated)]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key)
    })
    const reloaded = loadJson(STORAGE_KEYS.settings, defaultSettings)
    expect(audioMixerMonitorWhenIdle(reloaded)).toBe(true)
    expect(audioMixerMonitorWhenIdle(withAudioMixerMonitorWhenIdle(reloaded, false))).toBe(false)
  })
})
