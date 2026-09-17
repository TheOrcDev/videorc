import { describe, expect, it } from 'vitest'

import {
  audioMixerMonitorLabel,
  micVisualAnalyserEnabled,
  type MicVisualGateInput
} from './mic-visual-gate'

const ON_SCREEN: MicVisualGateInput = {
  workspaceVisible: true,
  documentVisible: true,
  microphoneSelected: true,
  muted: false,
  sessionActive: false
}

describe('micVisualAnalyserEnabled', () => {
  it('meters an idle mixer, because that is when people check the microphone', () => {
    // This used to be false until a session started or a toggle was flipped,
    // so the bars sat at the floor and looked identical to a dead microphone.
    expect(micVisualAnalyserEnabled(ON_SCREEN)).toBe(true)
  })

  it('meters a running session too', () => {
    expect(micVisualAnalyserEnabled({ ...ON_SCREEN, sessionActive: true })).toBe(true)
  })

  it.each<[string, Partial<MicVisualGateInput>]>([
    ['the workspace tab is elsewhere', { workspaceVisible: false }],
    ['the document is hidden', { documentVisible: false }],
    ['no microphone is selected', { microphoneSelected: false }],
    ['the microphone is muted', { muted: true }]
  ])('stays closed when %s, session or not', (_label, overrides) => {
    // The microphone is genuinely open while the meter runs, so every one of
    // these must still close it — this is what keeps the OS indicator honest.
    for (const sessionActive of [false, true]) {
      expect(micVisualAnalyserEnabled({ ...ON_SCREEN, sessionActive, ...overrides })).toBe(false)
    }
  })
})

describe('audioMixerMonitorLabel', () => {
  it('says Live only for a running session with a live signal path', () => {
    expect(audioMixerMonitorLabel({ sessionActive: true, signalLive: true })).toBe('Live')
  })

  it('says Monitoring for an idle meter that is actually delivering', () => {
    expect(audioMixerMonitorLabel({ sessionActive: false, signalLive: true })).toBe('Monitoring')
  })

  it('says Idle whenever nothing is being read, armed or not', () => {
    expect(audioMixerMonitorLabel({ sessionActive: false, signalLive: false })).toBe('Idle')
    // Muted mid-session: the path is not live, and the label must not claim it.
    expect(audioMixerMonitorLabel({ sessionActive: true, signalLive: false })).toBe('Idle')
  })
})
