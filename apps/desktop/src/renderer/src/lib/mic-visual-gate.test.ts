import { describe, expect, it } from 'vitest'

import {
  audioMixerMonitorState,
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

describe('audioMixerMonitorState', () => {
  it('is live only for a running session with a live signal path', () => {
    expect(audioMixerMonitorState({ sessionActive: true, signalLive: true })).toBe('live')
  })

  it('is monitoring for an idle meter that is actually delivering', () => {
    expect(audioMixerMonitorState({ sessionActive: false, signalLive: true })).toBe('monitoring')
  })

  it('is idle whenever nothing is being read, armed or not', () => {
    expect(audioMixerMonitorState({ sessionActive: false, signalLive: false })).toBe('idle')
    // No signal mid-session: the path is not live, and the label must not claim it.
    expect(audioMixerMonitorState({ sessionActive: true, signalLive: false })).toBe('idle')
  })

  it('is muted for a muted microphone, so flat bars never read as a dead one', () => {
    expect(audioMixerMonitorState({ sessionActive: false, signalLive: false, muted: true })).toBe(
      'muted'
    )
    expect(audioMixerMonitorState({ sessionActive: true, signalLive: false, muted: true })).toBe(
      'muted'
    )
  })
})
