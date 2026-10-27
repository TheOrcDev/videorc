import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_TOOL_CATALOG, studioAgentTools } from '../../../../shared/agent-tools'
import { SOUND_ACTION_COPY } from '@/lib/sounds'
import { AGENT_TOOL_EXECUTORS, executeAgentIntent, type AgentIntent } from './agent'
import type { StudioActionContext } from './context'
import { REMOTE_INTENT_COPY } from './copy'
import { AGENT_TOOL_COPY, STUDIO_AGENT_TOOLS } from './tools'

// Plan 209 S6: every `runsIn: studio` tool runs through the same executor as
// a deck key, answers with the sentence the agent reads, and refuses with
// Videorc's own sentence.

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
    systemAudio: ['available', false],
    setSystemAudioEnabled: vi.fn(),
    knownLayoutPresets: ['screen-camera', 'screen-only'],
    applyLayoutPreset: vi.fn(async () => true),
    hasTakeover: vi.fn((id: string) => id === 'brb'),
    activateTakeover: vi.fn(async () => true),
    clearTakeover: vi.fn(async () => true),
    openWindow: vi.fn(async (name: string) => ['notes', 'comments', 'preview'].includes(name)),
    showCommentHighlight: vi.fn(async () => ({ ok: true })),
    clearCommentHighlight: vi.fn(async () => ({ ok: true })),
    markClip: vi.fn(async () => ({ ok: true })),
    replayOn: false,
    banners: [],
    sounds: [{ id: 'airhorn' }],
    sessionLive: false,
    savedScenes: [{ id: 'scene-1', name: 'Coding' }],
    applySavedScene: vi.fn(async () => true),
    layoutLabels: { 'screen-camera': 'Screen + camera', 'screen-only': 'Screen only' },
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

describe('the Studio agent tools (plan 209 S6)', () => {
  it('has exactly one renderer executor per runsIn: studio tool, and no extra executors', () => {
    const studio = studioAgentTools()
      .map((tool) => tool.name)
      .sort()
    expect(Object.keys(AGENT_TOOL_EXECUTORS).sort()).toEqual(studio)
    expect(AGENT_TOOL_EXECUTORS).toBe(STUDIO_AGENT_TOOLS)
    const backend = AGENT_TOOL_CATALOG.tools
      .filter((tool) => tool.runsIn === 'backend')
      .map((tool) => tool.name)
    for (const name of backend) expect(Object.hasOwn(AGENT_TOOL_EXECUTORS, name), name).toBe(false)
  })

  it('start_recording records through the Studio start, and refuses with its reason', async () => {
    const idle = studioContext()
    expect(await executeAgentIntent(call('start_recording'), idle)).toEqual({
      ok: true,
      message: 'Recording.',
      result: { started: true }
    })
    expect(idle.startRecording).toHaveBeenCalledTimes(1)
    expect(
      await executeAgentIntent(call('start_recording'), studioContext({ sessionActive: true }))
    ).toEqual({ ok: false, message: REMOTE_INTENT_COPY.alreadyRunning })
    const blocked = studioContext({
      startRecording: vi.fn(async () => false),
      recordBlockedReason: 'Choose a screen or a camera first.'
    })
    expect(await executeAgentIntent(call('start_recording'), blocked)).toEqual({
      ok: false,
      message: 'Choose a screen or a camera first.'
    })
  })

  it('stop names what it ended, and refuses when nothing runs', async () => {
    const live = studioContext({ sessionActive: true, sessionLive: true })
    expect(await executeAgentIntent(call('stop'), live)).toEqual({
      ok: true,
      message: 'The livestream ended.',
      result: { stopped: 'livestream' }
    })
    expect(live.stopSession).toHaveBeenCalledTimes(1)
    expect(await executeAgentIntent(call('stop'), studioContext({ sessionActive: true }))).toEqual({
      ok: true,
      message: 'The recording stopped.',
      result: { stopped: 'recording' }
    })
    expect(await executeAgentIntent(call('stop'), studioContext())).toEqual({
      ok: false,
      message: REMOTE_INTENT_COPY.notRunning
    })
  })

  it('switch_scene applies a saved scene or a layout by id, and refuses an unknown id', async () => {
    const context = studioContext()
    expect(await executeAgentIntent(call('switch_scene', { sceneId: 'scene-1' }), context)).toEqual(
      {
        ok: true,
        message: 'Switched to Coding.',
        result: { scene: { id: 'scene-1', name: 'Coding', kind: 'saved' } }
      }
    )
    expect(context.applySavedScene).toHaveBeenCalledWith('scene-1')
    expect(
      await executeAgentIntent(call('switch_scene', { sceneId: 'screen-only' }), context)
    ).toEqual({
      ok: true,
      message: 'Switched to Screen only.',
      result: { scene: { id: 'screen-only', name: 'Screen only', kind: 'layout' } }
    })
    expect(context.applyLayoutPreset).toHaveBeenCalledWith('screen-only')
    expect(await executeAgentIntent(call('switch_scene', { sceneId: 'gone' }), context)).toEqual({
      ok: false,
      message: AGENT_TOOL_COPY.sceneMissing
    })
    const failing = studioContext({ applySavedScene: vi.fn(async () => false) })
    expect(await executeAgentIntent(call('switch_scene', { sceneId: 'scene-1' }), failing)).toEqual(
      { ok: false, message: AGENT_TOOL_COPY.sceneFailed }
    )
  })

  it('set_audio mutes and switches System audio, and refuses an empty or impossible change', async () => {
    const context = studioContext()
    expect(
      await executeAgentIntent(
        call('set_audio', { microphone: { muted: true }, systemAudio: { on: true } }),
        context
      )
    ).toEqual({
      ok: true,
      message: 'The microphone is muted. System audio is on.',
      result: { microphone: { muted: true }, systemAudio: { on: true } }
    })
    expect(context.setMicrophoneMuted).toHaveBeenCalledWith('mute')
    expect(context.setSystemAudioEnabled).toHaveBeenCalledWith(true)
    expect(await executeAgentIntent(call('set_audio', {}), context)).toEqual({
      ok: false,
      message: AGENT_TOOL_COPY.setAudioEmpty
    })
    const noDevice = studioContext({ systemAudio: ['unavailable', false] })
    expect(
      await executeAgentIntent(call('set_audio', { systemAudio: { on: true } }), noDevice)
    ).toEqual({ ok: false, message: REMOTE_INTENT_COPY.systemAudio })
    const micFails = studioContext({ setMicrophoneMuted: vi.fn(async () => false) })
    expect(
      await executeAgentIntent(call('set_audio', { microphone: { muted: false } }), micFails)
    ).toEqual({ ok: false, message: REMOTE_INTENT_COPY.microphone })
  })

  it('set_takeover shows by id or takes it down with null, and refuses an unknown id', async () => {
    const context = studioContext()
    expect(await executeAgentIntent(call('set_takeover', { takeoverId: 'brb' }), context)).toEqual({
      ok: true,
      message: 'The takeover is up.',
      result: { takeoverId: 'brb' }
    })
    expect(context.activateTakeover).toHaveBeenCalledWith('brb')
    expect(await executeAgentIntent(call('set_takeover', { takeoverId: null }), context)).toEqual({
      ok: true,
      message: 'The takeover is down.',
      result: { takeoverId: null }
    })
    expect(await executeAgentIntent(call('set_takeover', { takeoverId: 'gone' }), context)).toEqual(
      { ok: false, message: REMOTE_INTENT_COPY.takeoverMissing }
    )
  })

  it('play_sound presses a pad, and refuses a sound that is not on the board', async () => {
    const context = studioContext()
    expect(await executeAgentIntent(call('play_sound', { soundId: 'airhorn' }), context)).toEqual({
      ok: true,
      message: 'Pressed.',
      result: { soundId: 'airhorn' }
    })
    expect(context.client.request).toHaveBeenCalled()
    expect(await executeAgentIntent(call('play_sound', { soundId: 'gone' }), context)).toEqual({
      ok: false,
      message: SOUND_ACTION_COPY.missing
    })
  })

  it('stop_sounds stops one or all, and refuses a sound that is not on the board', async () => {
    const context = studioContext()
    expect(await executeAgentIntent(call('stop_sounds'), context)).toEqual({
      ok: true,
      message: 'Every sound stopped.',
      result: { all: true }
    })
    expect(await executeAgentIntent(call('stop_sounds', { soundId: 'airhorn' }), context)).toEqual({
      ok: true,
      message: 'Stopped.',
      result: { soundId: 'airhorn', all: false }
    })
    expect(await executeAgentIntent(call('stop_sounds', { soundId: 'gone' }), context)).toEqual({
      ok: false,
      message: SOUND_ACTION_COPY.missing
    })
  })

  it('set_highlight puts a message on stream or clears it, with the Studio refusal', async () => {
    const context = studioContext()
    expect(await executeAgentIntent(call('set_highlight', { messageId: 'm-1' }), context)).toEqual({
      ok: true,
      message: 'The comment is on the stream.',
      result: { messageId: 'm-1' }
    })
    expect(context.showCommentHighlight).toHaveBeenCalledWith('m-1')
    expect(await executeAgentIntent(call('set_highlight', { messageId: null }), context)).toEqual({
      ok: true,
      message: 'The comment is off the stream.',
      result: { messageId: null }
    })
    const notLive = studioContext({
      showCommentHighlight: vi.fn(async () => ({
        ok: false,
        message: 'That comment is no longer available.'
      }))
    })
    expect(await executeAgentIntent(call('set_highlight', { messageId: 'm-1' }), notLive)).toEqual({
      ok: false,
      message: 'That comment is no longer available.'
    })
  })

  it('open_window brings the Stream Manager, Notes or Preview forward, and refuses others', async () => {
    const context = studioContext()
    expect(
      await executeAgentIntent(call('open_window', { window: 'stream-manager' }), context)
    ).toEqual({ ok: true, message: 'It is in front.', result: { window: 'stream-manager' } })
    expect(context.openWindow).toHaveBeenCalledWith('comments')
    expect(await executeAgentIntent(call('open_window', { window: 'settings' }), context)).toEqual({
      ok: false,
      message: REMOTE_INTENT_COPY.windowMissing
    })
  })

  it('notify accepts a message for the Studio notice, and refuses an empty one', async () => {
    const context = studioContext()
    expect(
      await executeAgentIntent(call('notify', { message: 'the sponsor banner is up' }), context)
    ).toEqual({ ok: true, message: 'Shown in Videorc.', result: { shown: true } })
    expect(await executeAgentIntent(call('notify', { message: '   ' }), context)).toEqual({
      ok: false,
      message: AGENT_TOOL_COPY.notifyEmpty
    })
  })
})
