import { describe, expect, it, vi } from 'vitest'

import { agentTool } from '../../../../shared/agent-tools'
import type {
  StreamMetadataDraft,
  StreamTargetSettings,
  StreamingSettings
} from '../../../../shared/backend'
import { SESSION_LOCK_REASON } from '@/lib/lock-reason'
import { executeAgentIntent, type AgentIntent } from './agent'
import type { StudioActionContext, StudioPrepareAccess, StudioSettingsAccess } from './context'
import { PREPARE_TOOL_COPY } from './prepare'
import { CURATED_SETTINGS, SETTINGS_TOOL_COPY, curatedSettings } from './settings'

// Plan 209 S14: Stream details, Destinations and the curated settings (D16),
// each through the control the streamer would use.

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

// --- S14 update_stream_info, set_destinations ---------------------------------

function draft(): StreamMetadataDraft {
  const override = (platform: 'youtube' | 'twitch' | 'kick' | 'x') => ({
    platform,
    customize: false,
    title: '',
    description: '',
    privacy: 'public' as const,
    updatedAt: '2026-10-27T10:00:00Z'
  })
  return {
    title: 'Old title',
    description: 'Shared words',
    defaultPrivacy: 'unlisted',
    targetOverrides: [override('youtube'), override('twitch'), override('kick'), override('x')],
    updatedAt: '2026-10-27T10:00:00Z'
  }
}

function target(id: string, platform: string, enabled: boolean): StreamTargetSettings {
  return {
    id,
    platform,
    label: platform === 'youtube' ? 'YouTube' : 'Twitch',
    enabled,
    serverUrl: 'rtmp://example',
    streamKey: '',
    streamKeyPresent: true
  } as unknown as StreamTargetSettings
}

function prepare(overrides: Partial<StudioPrepareAccess> = {}): StudioPrepareAccess {
  return {
    draft: draft(),
    saveDraft: vi.fn(async (next: StreamMetadataDraft) => next),
    searchCategories: vi.fn(async (platform: 'twitch' | 'kick') =>
      platform === 'kick'
        ? [{ id: 15, name: 'Software Development' }]
        : [
            { id: '1469308723', name: 'Software and Game Development' },
            { id: '509670', name: 'Science & Technology' }
          ]
    ),
    streaming: {
      targets: [target('youtube', 'youtube', false), target('twitch', 'twitch', true)],
      enabledTargetIds: ['twitch']
    } as unknown as StreamingSettings,
    entitlements: null,
    goLivePending: false,
    patchTarget: vi.fn(),
    ...overrides
  }
}

describe('update_stream_info (plan 209 S14)', () => {
  it('sets the shared details and a category by name, checked then saved', async () => {
    const access = prepare()
    const studio = context({ prepare: access })
    const outcome = await executeAgentIntent(
      call('update_stream_info', {
        title: 'Building an MCP live',
        category: 'software and game development'
      }),
      studio
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toBe('Stream details saved.')
    const saved = vi.mocked(access.saveDraft).mock.calls[0][0]
    expect(saved.title).toBe('Building an MCP live')
    const twitch = saved.targetOverrides.find((entry) => entry.platform === 'twitch')
    expect(twitch).toMatchObject({
      twitchCategoryId: '1469308723',
      twitchCategoryName: 'Software and Game Development'
    })
    // Kick takes its search's first match.
    expect(saved.targetOverrides.find((entry) => entry.platform === 'kick')).toMatchObject({
      kickCategoryId: 15,
      kickCategoryName: 'Software Development'
    })
    expect(studio.client.request).toHaveBeenCalledWith('streamTargets.metadata.validate', saved)
    expect(outcome.result).toMatchObject({ title: 'Building an MCP live', privacy: 'unlisted' })
  })

  it('gives a platform its own title starting from the shared details', async () => {
    const access = prepare()
    await executeAgentIntent(
      call('update_stream_info', {
        destinations: [{ platform: 'youtube', title: 'YouTube only', privacy: 'private' }]
      }),
      context({ prepare: access })
    )
    const saved = vi.mocked(access.saveDraft).mock.calls[0][0]
    expect(saved.targetOverrides.find((entry) => entry.platform === 'youtube')).toMatchObject({
      customize: true,
      title: 'YouTube only',
      description: 'Shared words',
      privacy: 'private'
    })
  })

  it("refuses what Go Live would refuse, an unknown category and a session's lock", async () => {
    const invalid = prepare()
    const refusing = context({
      prepare: invalid,
      client: {
        request: vi.fn(
          async () =>
            ({
              valid: false,
              issues: [{ field: 'title', message: 'Global title is required before going live.' }]
            }) as never
        )
      }
    })
    expect(await executeAgentIntent(call('update_stream_info', { title: ' ' }), refusing)).toEqual({
      ok: false,
      message: 'Global title is required before going live.'
    })
    expect(invalid.saveDraft).not.toHaveBeenCalled()

    const none = prepare({ searchCategories: vi.fn(async () => []) })
    expect(
      await executeAgentIntent(
        call('update_stream_info', { category: 'Nothing' }),
        context({ prepare: none })
      )
    ).toEqual({ ok: false, message: 'Twitch has no category called "Nothing".' })
    expect(
      await executeAgentIntent(
        call('update_stream_info', { destinations: [{ platform: 'youtube', category: 'Music' }] }),
        context({ prepare: prepare() })
      )
    ).toEqual({
      ok: false,
      message: `YouTube has no category in Videorc. ${PREPARE_TOOL_COPY.categoryPlatforms}`
    })
    expect(
      await executeAgentIntent(
        call('update_stream_info', { title: 'x' }),
        context({ prepare: prepare(), sessionActive: true })
      )
    ).toEqual({ ok: false, message: PREPARE_TOOL_COPY.locked })
    expect(
      await executeAgentIntent(call('update_stream_info', {}), context({ prepare: prepare() }))
    ).toEqual({ ok: false, message: PREPARE_TOOL_COPY.infoEmpty })
  })
})

describe('set_destinations (plan 209 S14)', () => {
  it('turns destinations on and off through their switches', async () => {
    const access = prepare()
    const outcome = await executeAgentIntent(
      call('set_destinations', {
        destinations: [
          { id: 'youtube', on: true },
          { id: 'twitch', on: false }
        ]
      }),
      context({ prepare: access })
    )
    expect(access.patchTarget).toHaveBeenNthCalledWith(1, 'youtube', { enabled: true })
    expect(access.patchTarget).toHaveBeenNthCalledWith(2, 'twitch', { enabled: false })
    expect(outcome).toMatchObject({ ok: true, message: 'On for the next stream: YouTube.' })
  })

  it('refuses an unknown id, the destination cap and a running session, changing nothing', async () => {
    const access = prepare()
    expect(
      await executeAgentIntent(
        call('set_destinations', {
          destinations: [
            { id: 'youtube', on: true },
            { id: 'kick', on: true }
          ]
        }),
        context({ prepare: access })
      )
    ).toEqual({
      ok: false,
      message: 'No destination has the id "kick". list_destinations gives the ids.'
    })
    expect(access.patchTarget).not.toHaveBeenCalled()

    const full = prepare({
      streaming: {
        targets: ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => target(id, 'twitch', index < 5)),
        enabledTargetIds: ['a', 'b', 'c', 'd', 'e']
      } as unknown as StreamingSettings
    })
    expect(
      await executeAgentIntent(
        call('set_destinations', { destinations: [{ id: 'f', on: true }] }),
        context({ prepare: full })
      )
    ).toEqual({ ok: false, message: 'You can stream to up to 5 destinations at once.' })
    expect(
      await executeAgentIntent(
        call('set_destinations', { destinations: [{ id: 'youtube', on: true }] }),
        context({ prepare: prepare(), sessionActive: true })
      )
    ).toEqual({ ok: false, message: PREPARE_TOOL_COPY.locked })
  })
})

// --- S14 get_settings, update_settings (D16) ----------------------------------

function settingsAccess(overrides: Partial<StudioSettingsAccess> = {}): StudioSettingsAccess {
  return {
    captureConfig: {
      video: { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
      layout: { layoutPreset: 'screen-camera' },
      recordEnabled: true,
      separateSourceRecordings: { enabled: false, keepCombined: true },
      replayBuffer: { enabled: true, explicit: false },
      captions: { language: 'auto' }
    } as never,
    settings: { outputDirectory: '', keepOriginalRecording: false, studioChat: false },
    theme: 'dark',
    platform: 'darwin',
    entitlements: null,
    patchVideo: vi.fn(),
    setCaptureConfig: vi.fn(),
    setSettings: vi.fn(),
    setClipsEnabled: vi.fn(),
    setTheme: vi.fn(),
    ...overrides
  }
}

describe('get_settings and update_settings (plan 209 S14, D16)', () => {
  it('lists exactly the curated settings, the same names as the catalog schema', async () => {
    const schema = agentTool('update_settings')!.inputSchema as {
      properties: Record<string, unknown>
      additionalProperties: boolean
    }
    expect(Object.keys(schema.properties).sort()).toEqual([...CURATED_SETTINGS].sort())
    expect(schema.additionalProperties).toBe(false)
    const read = await executeAgentIntent(
      call('get_settings'),
      context({ settings: settingsAccess() })
    )
    expect(read).toEqual({
      ok: true,
      message: 'The settings agents can change, as they stand.',
      result: {
        resolution: '1080p',
        frameRate: 30,
        keepOriginalRecording: false,
        recordingFolder: 'default',
        separateSourceRecordings: false,
        clips: true,
        captionsLanguage: 'auto',
        chatInStudio: false,
        theme: 'dark'
      }
    })
    expect(Object.keys(curatedSettings(settingsAccess())).sort()).toEqual(
      [...CURATED_SETTINGS].sort()
    )
  })

  it('changes each setting through its own setter', async () => {
    const access = settingsAccess()
    const outcome = await executeAgentIntent(
      call('update_settings', {
        resolution: '1440p',
        frameRate: 60,
        clips: false,
        chatInStudio: true,
        theme: 'light',
        captionsLanguage: 'es',
        recordingFolder: 'default'
      }),
      context({ settings: access })
    )
    expect(outcome.ok).toBe(true)
    expect(access.patchVideo).toHaveBeenCalledWith({
      width: 2560,
      height: 1440,
      fps: 60,
      bitrateKbps: expect.any(Number)
    })
    expect(access.setClipsEnabled).toHaveBeenCalledWith(false)
    expect(access.setTheme).toHaveBeenCalledWith('light')
    expect(access.setCaptureConfig).toHaveBeenCalledTimes(1)
    expect(access.setSettings).toHaveBeenCalledTimes(2)
    expect(outcome.result).toEqual({
      changed: {
        resolution: '1440p',
        frameRate: 60,
        clips: false,
        chatInStudio: true,
        theme: 'light',
        captionsLanguage: 'es',
        recordingFolder: 'default'
      }
    })
  })

  it('refuses every setting outside the curated list, and changes nothing', async () => {
    const forbidden = [
      'streamKey',
      'outputDirectory',
      'outputDirectoryHandle',
      'accounts',
      'youtubeChannel',
      'permissions',
      'remoteControl',
      'phoneRemote',
      'agents',
      'agentsEnabled',
      'autoUpdate',
      'updates',
      'diagnostics',
      'usageStats',
      'billing',
      'premium',
      'globalShortcuts',
      'keepMicrophoneWarm'
    ]
    const tool = agentTool('update_settings')!
    for (const name of forbidden) {
      const access = settingsAccess()
      expect(
        await executeAgentIntent(
          call('update_settings', { theme: 'light', [name]: true }),
          context({ settings: access })
        ),
        name
      ).toEqual({ ok: false, message: SETTINGS_TOOL_COPY.notCurated(name) })
      expect(access.setTheme, name).not.toHaveBeenCalled()
      // The catalog schema refuses it before it reaches the Studio, too.
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false })
      expect(Object.hasOwn((tool.inputSchema as { properties: object }).properties, name)).toBe(
        false
      )
    }
  })

  it("keeps each control's locks and gates", async () => {
    expect(
      await executeAgentIntent(
        call('update_settings', { frameRate: 60 }),
        context({ settings: settingsAccess(), sessionActive: true })
      )
    ).toEqual({ ok: false, message: SESSION_LOCK_REASON })
    expect(
      await executeAgentIntent(
        call('update_settings', { resolution: '4K' }),
        context({
          settings: settingsAccess({
            captureConfig: { ...settingsAccess().captureConfig, recordEnabled: false }
          })
        })
      )
    ).toEqual({ ok: false, message: SETTINGS_TOOL_COPY.recordOff })
    expect(
      await executeAgentIntent(
        call('update_settings', { separateSourceRecordings: true }),
        context({ settings: settingsAccess({ platform: 'win32' }) })
      )
    ).toEqual({
      ok: false,
      message: 'Works on Mac only for now. On this computer every recording is the Combined file.'
    })
    expect(
      await executeAgentIntent(
        call('update_settings', { recordingFolder: '/Users/someone/Desktop' }),
        context({ settings: settingsAccess() })
      )
    ).toEqual({ ok: false, message: SETTINGS_TOOL_COPY.folderPicker })
    expect(
      await executeAgentIntent(call('update_settings', {}), context({ settings: settingsAccess() }))
    ).toEqual({ ok: false, message: SETTINGS_TOOL_COPY.empty })
  })
})
