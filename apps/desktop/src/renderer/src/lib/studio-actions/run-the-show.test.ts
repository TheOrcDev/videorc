import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentTool } from '../../../../shared/agent-tools'
import { executeAgentIntent, type AgentIntent } from './agent'
import type { StudioActionContext } from './context'
import { REMOTE_INTENT_COPY } from './copy'

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
