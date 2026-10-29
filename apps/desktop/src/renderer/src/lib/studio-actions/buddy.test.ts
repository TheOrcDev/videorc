import { describe, expect, it, vi } from 'vitest'

import type { CohostSettings } from '../../../../shared/backend'
import { BUDDY_CONSENT_OFF_REASON } from '@/lib/buddy-tab-view'
import { DEFAULT_COHOST_AUTO_CHAT } from '@/lib/cohost-state'
import { executeAgentIntent, type AgentIntent } from './agent'
import { BUDDY_TOOL_COPY } from './buddy'
import type { StudioActionContext, StudioBuddyAccess } from './context'

// Plan 209 S13: `set_buddy` saves what a Stream Manager command saves, and
// refuses with Videorc's own sentence.

function context(overrides: Partial<StudioActionContext> = {}): StudioActionContext {
  return {
    client: { request: vi.fn(async () => ({ valid: true, issues: [] }) as never) },
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

// --- S13 set_buddy ------------------------------------------------------------

function buddy(overrides: Partial<StudioBuddyAccess> = {}): StudioBuddyAccess {
  const settings = { enabled: false, autoChat: DEFAULT_COHOST_AUTO_CHAT }
  return {
    settings,
    entitled: true,
    entitlementReason: null,
    consented: true,
    showOnStream: false,
    saveSettings: vi.fn(async (patch) => ({ ...settings, ...patch }) as unknown as CohostSettings),
    setShowOnStream: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('set_buddy (plan 209 S13)', () => {
  it.each(['off', 'bubble', 'suggest'])('saves talk %s without Premium', async (talk) => {
    const access = buddy({ entitled: false })
    const outcome = await executeAgentIntent(
      call('set_buddy', { talk }),
      context({ buddy: access })
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ on: false, talk, onStream: false })
  })

  it.each(['auto', 'off'])('refuses legacy chatMode %s', async (chatMode) => {
    const outcome = await executeAgentIntent(
      call('set_buddy', { chatMode }),
      context({ buddy: buddy() })
    )
    expect(outcome).toEqual({
      ok: false,
      message:
        chatMode === 'auto'
          ? 'Auto is gone: Buddy never posts in chat on its own. Use talk: bubble.'
          : 'chatMode is now talk: off, bubble or suggest.'
    })
  })

  it('turns Buddy Live on with the Stream Manager command save, never the microphone', async () => {
    const access = buddy()
    const outcome = await executeAgentIntent(
      call('set_buddy', { on: true }),
      context({ buddy: access })
    )
    expect(access.saveSettings).toHaveBeenCalledWith({ enabled: true })
    expect(outcome).toEqual({
      ok: true,
      message: 'Buddy Live is on.',
      result: { on: true, talk: 'bubble', onStream: false }
    })
  })

  it('saves a chat mode alone, merged into the stored block', async () => {
    const templates = [{ id: 't1', kind: 'follow', text: 'Thanks {name}!' }]
    const access = buddy({
      settings: {
        enabled: true,
        autoChat: {
          ...DEFAULT_COHOST_AUTO_CHAT,
          greetings: { ...DEFAULT_COHOST_AUTO_CHAT.greetings, templates: templates as never }
        }
      }
    })
    // plan 211 Phase D (S-D1) reshapes this call to `talk`; the merge-alone
    // intent is what this test keeps.
    const outcome = await executeAgentIntent(
      call('set_buddy', { talk: 'suggest' }),
      context({ buddy: access })
    )
    const patch = vi.mocked(access.saveSettings).mock.calls[0][0]
    expect(patch).not.toHaveProperty('enabled')
    expect(patch).not.toHaveProperty('listen')
    expect(patch.autoChat?.talk).toBe('suggest')
    expect(patch.autoChat?.greetings.templates).toEqual(templates)
    expect(outcome.message).toBe('Buddy talks: Suggest.')
  })

  it('refuses Buddy Live without Premium or consent, but always turns it off', async () => {
    expect(
      await executeAgentIntent(
        call('set_buddy', { on: true }),
        context({
          buddy: buddy({ entitled: false, entitlementReason: 'Buddy requires Videorc Premium.' })
        })
      )
    ).toEqual({ ok: false, message: 'Buddy requires Videorc Premium.' })
    expect(
      await executeAgentIntent(
        call('set_buddy', { on: true }),
        context({ buddy: buddy({ consented: false }) })
      )
    ).toEqual({ ok: false, message: BUDDY_CONSENT_OFF_REASON })
    const on = buddy({
      entitled: false,
      settings: { enabled: true, autoChat: DEFAULT_COHOST_AUTO_CHAT }
    })
    const off = await executeAgentIntent(call('set_buddy', { on: false }), context({ buddy: on }))
    expect(off.ok).toBe(true)
    expect(on.saveSettings).toHaveBeenCalledWith({ enabled: false })
  })

  it('puts Buddy on stream through the header switch, and refuses an empty call', async () => {
    const access = buddy()
    const outcome = await executeAgentIntent(
      call('set_buddy', { onStream: true }),
      context({ buddy: access })
    )
    expect(access.setShowOnStream).toHaveBeenCalledWith(true)
    expect(access.saveSettings).not.toHaveBeenCalled()
    expect(outcome.message).toBe('Buddy is on stream.')
    expect(await executeAgentIntent(call('set_buddy'), context({ buddy: access }))).toEqual({
      ok: false,
      message: BUDDY_TOOL_COPY.empty
    })
    expect(
      await executeAgentIntent(
        call('set_buddy', { on: true }),
        context({ buddy: buddy({ settings: null }) })
      )
    ).toEqual({ ok: false, message: BUDDY_TOOL_COPY.loading })
  })
})
