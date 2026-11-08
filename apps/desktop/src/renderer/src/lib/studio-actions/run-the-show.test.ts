import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentTool } from '../../../../shared/agent-tools'
import { executeAgentIntent, type AgentIntent } from './agent'
import type { StudioActionContext } from './context'
import { REMOTE_INTENT_COPY } from './copy'
import { RUN_THE_SHOW_COPY } from './run-the-show'
import type { Device, SourceSelection } from '@/lib/backend'

// Plan 209 PR B (S10, S11): the Run the show tools an agent gets beside a
// deck's keys, each through the Studio's own handler, refusing in Videorc's
// own words.

function studioContext(overrides: Partial<StudioActionContext> = {}): StudioActionContext {
  return {
    client: { request: vi.fn(async () => undefined as never) },
    sessionActive: false,
    recordBlockedReason: null,
    liveStreamBlockedReason: null,
    startRecording: vi.fn(async () => true),
    startLivestream: vi.fn(async () => false),
    stopSession: vi.fn(async () => true),
    setMicrophoneMuted: vi.fn(async () => true),
    systemAudio: ['available', true],
    setSystemAudioEnabled: vi.fn(),
    knownLayoutPresets: ['screen-camera', 'screen-only'],
    applyLayoutPreset: vi.fn(async () => true),
    hasTakeover: vi.fn(() => false),
    activateTakeover: vi.fn(async () => true),
    clearTakeover: vi.fn(async () => true),
    openWindow: vi.fn(async () => true),
    showCommentHighlight: vi.fn(async () => ({ ok: true })),
    clearCommentHighlight: vi.fn(async () => ({ ok: true })),
    markClip: vi.fn(async () => ({ ok: true })),
    replayOn: false,
    banners: [],
    ...overrides
  }
}

const call = (tool: string, args: Record<string, unknown> = {}): AgentIntent => ({
  intentId: 'ai-1',
  agentId: 'agent-1',
  agentName: 'Claude Desktop',
  tool,
  args
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('go_live (plan 209 S10, D13)', () => {
  it('goes live through the Studio without the dialog, and says where', async () => {
    const goLive = vi.fn(async () => ({
      ok: true as const,
      destinations: [
        { id: 'youtube', platform: 'youtube' as const, label: 'YouTube' },
        { id: 'twitch', platform: 'twitch' as const, label: 'Twitch' }
      ],
      recording: true
    }))
    const context = studioContext({ goLive })
    expect(
      await executeAgentIntent(
        call('go_live', {
          destinations: ['youtube', 'twitch'],
          title: 'Building an MCP live',
          allowPartial: true
        }),
        context
      )
    ).toEqual({
      ok: true,
      message: "You're live on YouTube, Twitch. Recording too.",
      result: {
        live: true,
        destinations: [
          { id: 'youtube', platform: 'youtube', label: 'YouTube' },
          { id: 'twitch', platform: 'twitch', label: 'Twitch' }
        ],
        recording: true
      }
    })
    expect(goLive).toHaveBeenCalledWith({
      destinations: ['youtube', 'twitch'],
      title: 'Building an MCP live',
      allowPartial: true,
      withoutCaptions: false
    })
    // Never the deck's start, which opens the dialog (D2).
    expect(context.startLivestream).not.toHaveBeenCalled()
  })

  it("refuses with the Studio's sentence, and while something already runs", async () => {
    const refused = studioContext({
      goLive: vi.fn(async () => ({
        ok: false as const,
        message: 'YouTube: Sign in to YouTube in Livestream → Setup, then go live.'
      }))
    })
    expect(await executeAgentIntent(call('go_live'), refused)).toEqual({
      ok: false,
      message: 'YouTube: Sign in to YouTube in Livestream → Setup, then go live.'
    })
    const running = studioContext({ sessionActive: true, goLive: vi.fn() })
    expect(await executeAgentIntent(call('go_live'), running)).toEqual({
      ok: false,
      message: REMOTE_INTENT_COPY.alreadyRunning
    })
    expect(running.goLive).not.toHaveBeenCalled()
    expect(await executeAgentIntent(call('go_live'), studioContext())).toEqual({
      ok: false,
      message: REMOTE_INTENT_COPY.unsupported
    })
  })

  it('is an on-air session tool with its D11 notice', () => {
    const tool = agentTool('go_live')!
    expect(tool.runsIn).toBe('studio')
    expect(tool.rateFamily).toBe('session')
    expect(tool.onAir).toBe(true)
    expect(tool.notice).toBe('{agent} started the livestream.')
    expect(tool.annotations.openWorldHint).toBe(true)
    expect(tool.buddy).toBe(true)
  })
})

function device(
  id: string,
  kind: Device['kind'],
  name: string,
  status: Device['status'] = 'available'
): Device {
  return { id, kind, name, status } as Device
}

const SOURCES = {
  screenId: 'screen:1',
  screenName: 'Built-in Display',
  cameraId: 'camera:1',
  cameraName: 'FaceTime HD Camera',
  microphoneId: 'mic:1',
  microphoneName: 'MacBook Pro Microphone'
} as SourceSelection

function pickerContext(overrides: Partial<StudioActionContext> = {}): StudioActionContext {
  return studioContext({
    sourcePicker: {
      sources: SOURCES,
      capture: [
        device('screen:1', 'screen', 'Built-in Display'),
        device('screen:2', 'screen', 'Studio Display'),
        device('window:9', 'window', 'Visual Studio Code'),
        device('screen:3', 'screen', 'Sidecar', 'unavailable')
      ],
      cameras: [
        device('camera:1', 'camera', 'FaceTime HD Camera'),
        device('camera:2', 'camera', 'Desk View')
      ],
      microphones: [
        device('mic:1', 'microphone', 'MacBook Pro Microphone'),
        device('mic:2', 'microphone', 'Shure MV7')
      ]
    },
    switchSource: vi.fn(async () => ({ ok: true })),
    setAudioGain: vi.fn(),
    ...overrides
  })
}

describe('set_audio, the rest (plan 209 S11)', () => {
  it('sets both gains in whole dB inside the faders, and switches the microphone', async () => {
    const context = pickerContext()
    expect(
      await executeAgentIntent(
        call('set_audio', {
          microphone: { deviceId: 'mic:2', gainDb: 3.4 },
          systemAudio: { gainDb: -6 }
        }),
        context
      )
    ).toEqual({
      ok: true,
      message: 'The microphone is Shure MV7. Microphone gain is 3 dB. System audio gain is -6 dB.',
      result: {
        microphone: { deviceId: 'mic:2', name: 'Shure MV7', gainDb: 3 },
        systemAudio: { gainDb: -6 }
      }
    })
    // The picker's own switch with the picker's own builder.
    expect(context.switchSource).toHaveBeenCalledWith(
      'microphone',
      expect.objectContaining({
        microphoneId: 'mic:2',
        microphoneName: 'Shure MV7',
        screenId: 'screen:1'
      })
    )
    expect(context.setAudioGain).toHaveBeenCalledWith({ microphoneGainDb: 3 })
    expect(context.setAudioGain).toHaveBeenCalledWith({ systemAudioGainDb: -6 })
  })

  it('turns the microphone off with deviceId null', async () => {
    const context = pickerContext()
    expect(
      await executeAgentIntent(call('set_audio', { microphone: { deviceId: null } }), context)
    ).toEqual({
      ok: true,
      message: 'The microphone is off.',
      result: { microphone: { deviceId: null } }
    })
    expect(context.switchSource).toHaveBeenCalledWith(
      'microphone',
      expect.objectContaining({ microphoneId: undefined, microphoneOff: true })
    )
  })

  it("refuses a microphone the picker doesn't offer, and the picker's own reason", async () => {
    expect(
      await executeAgentIntent(
        call('set_audio', { microphone: { deviceId: 'mic:404' } }),
        pickerContext()
      )
    ).toEqual({ ok: false, message: RUN_THE_SHOW_COPY.microphoneMissing })
    const busy = pickerContext({
      switchSource: vi.fn(async () => ({ ok: false, message: 'The scene is changing.' }))
    })
    expect(
      await executeAgentIntent(call('set_audio', { microphone: { deviceId: 'mic:2' } }), busy)
    ).toEqual({ ok: false, message: 'The scene is changing.' })
    // System audio's fader is off while System audio can't be heard.
    const unavailable = pickerContext({ systemAudio: ['permission-required', false] })
    expect(
      await executeAgentIntent(
        call('set_audio', { microphone: { gainDb: 0 }, systemAudio: { gainDb: 0 } }),
        unavailable
      )
    ).toEqual({
      ok: false,
      message: `Microphone gain is 0 dB. ${REMOTE_INTENT_COPY.systemAudio}`
    })
    expect(
      await executeAgentIntent(call('set_audio', { microphone: {} }), pickerContext())
    ).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.setAudioEmpty
    })
  })
})

describe('set_sources (plan 209 S11)', () => {
  it('switches the screen and the camera through the Sources pickers', async () => {
    const context = pickerContext()
    expect(
      await executeAgentIntent(
        call('set_sources', { screenId: 'screen:2', cameraId: 'camera:2' }),
        context
      )
    ).toEqual({
      ok: true,
      message: 'The screen is Studio Display. The camera is Desk View.',
      result: {
        screen: { id: 'screen:2', name: 'Studio Display' },
        camera: { id: 'camera:2', name: 'Desk View' }
      }
    })
    expect(context.switchSource).toHaveBeenNthCalledWith(
      1,
      'capture',
      expect.objectContaining({
        screenId: 'screen:2',
        screenName: 'Studio Display',
        windowId: undefined
      })
    )
    expect(context.switchSource).toHaveBeenNthCalledWith(
      2,
      'camera',
      expect.objectContaining({ cameraId: 'camera:2', cameraName: 'Desk View' })
    )
  })

  it('captures a window, and turns the camera off with null', async () => {
    const context = pickerContext()
    expect(
      await executeAgentIntent(
        call('set_sources', { windowId: 'window:9', cameraId: null }),
        context
      )
    ).toEqual({
      ok: true,
      message: 'The window is Visual Studio Code. The camera is off.',
      result: { window: { id: 'window:9', name: 'Visual Studio Code' }, camera: null }
    })
    expect(context.switchSource).toHaveBeenNthCalledWith(
      1,
      'capture',
      expect.objectContaining({ windowId: 'window:9', screenId: undefined })
    )
    expect(context.switchSource).toHaveBeenNthCalledWith(
      2,
      'camera',
      expect.objectContaining({ cameraId: undefined, cameraOff: true })
    )
  })

  it("refuses what the pickers wouldn't offer, and the live switch's own refusal", async () => {
    const context = pickerContext()
    expect(await executeAgentIntent(call('set_sources', {}), context)).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.setSourcesEmpty
    })
    expect(
      await executeAgentIntent(
        call('set_sources', { screenId: 'screen:1', windowId: 'window:9' }),
        context
      )
    ).toEqual({ ok: false, message: RUN_THE_SHOW_COPY.screenOrWindow })
    // A window id is not a screen.
    expect(
      await executeAgentIntent(call('set_sources', { screenId: 'window:9' }), context)
    ).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.screenMissing
    })
    expect(
      await executeAgentIntent(call('set_sources', { screenId: 'screen:3' }), context)
    ).toEqual({
      ok: false,
      message: "Sidecar isn't available right now."
    })
    expect(
      await executeAgentIntent(call('set_sources', { cameraId: 'camera:9' }), context)
    ).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.cameraMissing
    })
    expect(context.switchSource).not.toHaveBeenCalled()
    const live = pickerContext({
      switchSource: vi.fn(async () => ({ ok: false, message: 'Checking the current session…' }))
    })
    expect(await executeAgentIntent(call('set_sources', { cameraId: 'camera:2' }), live)).toEqual({
      ok: false,
      message: 'Checking the current session…'
    })
  })
})

describe('set_captions (plan 209 S11)', () => {
  it('turns captions on and off through the switch, and refuses what the switch would', async () => {
    const set = vi.fn()
    const off = studioContext({
      captions: { enabled: false, pending: false, blockedReason: null, set }
    })
    expect(await executeAgentIntent(call('set_captions', { on: true }), off)).toEqual({
      ok: true,
      message: 'Live captions are on.',
      result: { on: true }
    })
    expect(set).toHaveBeenCalledWith(true)
    const premium = studioContext({
      captions: {
        enabled: false,
        pending: false,
        blockedReason: 'Live captions are part of Videorc Premium.',
        set: vi.fn()
      }
    })
    expect(await executeAgentIntent(call('set_captions', { on: true }), premium)).toEqual({
      ok: false,
      message: 'Live captions are part of Videorc Premium.'
    })
    // Off always works, even locked.
    const lockedOn = studioContext({
      captions: { enabled: true, pending: false, blockedReason: 'Locked.', set }
    })
    expect(await executeAgentIntent(call('set_captions', { on: false }), lockedOn)).toEqual({
      ok: true,
      message: 'Live captions are off.',
      result: { on: false }
    })
    expect(set).toHaveBeenLastCalledWith(false)
    const pending = studioContext({
      captions: { enabled: false, pending: true, blockedReason: null, set: vi.fn() }
    })
    expect(await executeAgentIntent(call('set_captions', { on: true }), pending)).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.captionsChanging
    })
  })
})

describe('set_background (plan 209 S11)', () => {
  it('puts a live background on, takes any background off, and refuses an unknown id', async () => {
    const apply = vi.fn(async () => true)
    const context = studioContext({ background: { liveId: null, picture: true, apply } })
    expect(await executeAgentIntent(call('set_background', { liveId: 'silk' }), context)).toEqual({
      ok: true,
      message: 'Silk is on the scene.',
      result: { liveId: 'silk', name: 'Silk' }
    })
    expect(apply).toHaveBeenCalledWith('silk')
    expect(await executeAgentIntent(call('set_background', { liveId: null }), context)).toEqual({
      ok: true,
      message: 'The background is off.',
      result: { liveId: null }
    })
    expect(apply).toHaveBeenLastCalledWith(null)
    expect(await executeAgentIntent(call('set_background', { liveId: 'lava' }), context)).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.backgroundMissing
    })
    const failing = studioContext({
      background: { liveId: null, picture: false, apply: vi.fn(async () => false) }
    })
    expect(await executeAgentIntent(call('set_background', { liveId: 'beams' }), failing)).toEqual({
      ok: false,
      message: RUN_THE_SHOW_COPY.backgroundFailed
    })
  })
})
