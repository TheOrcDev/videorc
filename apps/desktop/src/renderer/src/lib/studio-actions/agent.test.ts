import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_INTENT_COPY,
  executeAgentIntent,
  type AgentIntent,
  type AgentToolExecutor
} from './agent'
import type { StudioActionContext } from './context'
import { REMOTE_INTENT_COPY } from './copy'
import { recordStart } from './session'

// Plan 209 S5: an agent's tool call runs against the Studio context through
// the executor registered under the tool's catalog name, and resolves to the
// body of its ack. S6 fills the registry; these tests bring their own.

function studioContext(overrides: Partial<StudioActionContext> = {}): StudioActionContext {
  return {
    client: { request: async () => undefined as never },
    sessionActive: false,
    recordBlockedReason: null,
    liveStreamBlockedReason: null,
    startRecording: vi.fn(async () => true),
    startLivestream: vi.fn(async () => false),
    stopSession: vi.fn(async () => true),
    setMicrophoneMuted: vi.fn(async () => true),
    systemAudio: ['available', false],
    setSystemAudioEnabled: vi.fn(),
    knownLayoutPresets: ['screen-camera'],
    applyLayoutPreset: vi.fn(async () => true),
    hasTakeover: vi.fn(() => true),
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

const intent = (tool: string, args: Record<string, unknown> = {}): AgentIntent => ({
  intentId: 'ai-1',
  agentId: 'agent-1',
  agentName: 'Claude Desktop',
  tool,
  args
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('executeAgentIntent', () => {
  it('runs the tool under the call name with the Studio context, the args and the intent', async () => {
    const context = studioContext()
    const switchScene: AgentToolExecutor = vi.fn(async () => ({ ok: true }))
    const call = intent('switch_scene', { scene: 'screen-only' })
    await expect(executeAgentIntent(call, context, { switch_scene: switchScene })).resolves.toEqual(
      { ok: true }
    )
    expect(switchScene).toHaveBeenCalledWith(context, { scene: 'screen-only' }, call)
  })

  it('resolves to the ack body only: {ok}, a refusal sentence, or a result when the tool answers', async () => {
    const context = studioContext()
    const executors: Record<string, AgentToolExecutor> = {
      get_status: async () => ({ ok: true, result: { live: false, recording: false } }),
      stop: async () => ({ ok: false, message: REMOTE_INTENT_COPY.notRunning }),
      quiet: async () => ({ ok: true, message: undefined, result: undefined })
    }
    const status = await executeAgentIntent(intent('get_status'), context, executors)
    expect(status).toEqual({ ok: true, result: { live: false, recording: false } })
    expect(Object.keys(status)).toEqual(['ok', 'result'])
    expect(await executeAgentIntent(intent('stop'), context, executors)).toEqual({
      ok: false,
      message: REMOTE_INTENT_COPY.notRunning
    })
    const quiet = await executeAgentIntent(intent('quiet'), context, executors)
    expect(quiet).toEqual({ ok: true })
    expect(Object.keys(quiet)).toEqual(['ok'])
  })

  it('refuses a tool it does not have, including a prototype name, without running anything', async () => {
    const context = studioContext()
    const startRecording: AgentToolExecutor = vi.fn(async () => ({ ok: true }))
    const executors = { start_recording: startRecording }
    for (const tool of ['delete_everything', 'constructor', 'toString', '']) {
      await expect(executeAgentIntent(intent(tool), context, executors)).resolves.toEqual({
        ok: false,
        message: AGENT_INTENT_COPY.unknownTool
      })
    }
    expect(startRecording).not.toHaveBeenCalled()
    // The shipped registry refuses a backend tool the same way: it never
    // reaches the Studio, and a name Videorc does not know never runs.
    await expect(executeAgentIntent(intent('get_status'), context)).resolves.toEqual({
      ok: false,
      message: AGENT_INTENT_COPY.unknownTool
    })
  })

  it('turns a tool that throws into the plain failure and keeps the error for the console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const context = studioContext()
    const executors: Record<string, AgentToolExecutor> = {
      save_clip: async () => {
        throw new Error('backend hiccup')
      }
    }
    await expect(executeAgentIntent(intent('save_clip'), context, executors)).resolves.toEqual({
      ok: false,
      message: AGENT_INTENT_COPY.failed
    })
    expect(error).toHaveBeenCalledWith('[agents] tool failed', 'save_clip', expect.any(Error))
  })

  it('runs a remote executor as a tool unchanged, with the same refusal sentence', async () => {
    const executors = { start_recording: recordStart }
    const idle = studioContext()
    await expect(executeAgentIntent(intent('start_recording'), idle, executors)).resolves.toEqual({
      ok: true
    })
    expect(idle.startRecording).toHaveBeenCalledTimes(1)
    const live = studioContext({ sessionActive: true })
    await expect(executeAgentIntent(intent('start_recording'), live, executors)).resolves.toEqual({
      ok: false,
      message: REMOTE_INTENT_COPY.alreadyRunning
    })
    expect(live.startRecording).not.toHaveBeenCalled()
  })
})
