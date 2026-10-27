import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SoundboardStore } from '@/lib/soundboard-store'
import type { StreamTargetSettings } from '../../../shared/backend'
import { AgentSurfacePublisher, buildAgentSurface, type AgentSurfaceInput } from './agent-surface'

// Plan 209 S6: the Studio's projection for agents is an allowlist (D9): no
// token, key, server URL, account id or path ever crosses.

function target(overrides: Partial<StreamTargetSettings>): StreamTargetSettings {
  return {
    id: 'twitch-1',
    platform: 'twitch',
    label: 'Twitch',
    enabled: true,
    serverUrl: 'rtmp://live.twitch.tv/app',
    streamKey: 'live_123_secret_key',
    streamKeySecretRef: 'stream-key:twitch-1',
    streamKeyPresent: true,
    streamKeyHint: '••••1234',
    authMode: 'manual',
    accountId: 'account-secret-id',
    ...overrides
  } as StreamTargetSettings
}

function input(overrides: Partial<AgentSurfaceInput> = {}): AgentSurfaceInput {
  return {
    recordBlockedReason: null,
    liveStreamBlockedReason: 'Turn on a destination in Livestream.',
    layoutPreset: 'screen-camera',
    layoutPresets: ['screen-camera', 'screen-only'],
    activeSavedSceneId: null,
    savedSceneModified: false,
    savedScenes: [{ id: 'scene-1', name: 'Coding' }],
    microphoneMuted: false,
    sources: { screenId: 'screen-1', microphoneId: 'mic-1', microphoneName: 'Old name' },
    devices: [
      { id: 'screen-1', name: 'Built-in Display', kind: 'screen', status: 'available' },
      { id: 'mic-1', name: 'MacBook Pro Microphone', kind: 'microphone', status: 'available' },
      {
        id: 'cam-1',
        name: 'FaceTime HD',
        kind: 'camera',
        status: 'permission-required',
        detail: 'Allow camera access in System Settings'
      },
      { id: 'system-audio', name: 'System audio', kind: 'system-audio', status: 'available' }
    ],
    systemAudioStatus: 'available',
    systemAudioShown: true,
    activeTakeoverId: 'brb',
    takeovers: [{ id: 'brb', name: 'BRB', imagePath: '/Users/me/Library/brb.png' } as never],
    background: {
      assetId: 'live-silk-satin',
      managedAssetPath: '/Users/me/Library/Application Support/Videorc/backgrounds/x.webp',
      fit: 'fill',
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      blurPx: 0,
      dimPercent: 0,
      saturationPercent: 100,
      vignettePercent: 0,
      visibilityPercent: 20,
      live: { id: 'silk', look: 'satin', motion: 'normal' }
    } as never,
    captionsEnabled: true,
    captionsStatus: { state: 'listening' },
    cohostSettings: { enabled: true } as never,
    cohostState: { status: 'listening' } as never,
    streaming: {
      enabled: true,
      mode: 'multi',
      targets: [
        target({}),
        target({
          id: 'youtube-1',
          platform: 'youtube',
          label: 'YouTube',
          enabled: false,
          serverUrl: '',
          streamKey: '',
          streamKeySecretRef: undefined,
          streamKeyPresent: false
        })
      ],
      defaultOutputPreset: 'tutorial-1080p30',
      defaultBitrateKbps: 6000,
      enabledTargetIds: ['twitch-1']
    } as never,
    streamMetadataDraft: {
      title: 'Building an MCP live',
      description: '',
      defaultPrivacy: 'public',
      targetOverrides: [
        {
          platform: 'twitch',
          customize: false,
          title: '',
          description: '',
          privacy: 'public',
          twitchCategoryName: 'Software and Game Development'
        }
      ],
      updatedAt: '2026-10-27T10:00:00Z'
    } as never,
    windows: { notes: false, streamManager: true, preview: false },
    ...overrides
  }
}

describe('buildAgentSurface', () => {
  it('projects the Studio for get_status and the list tools', () => {
    const surface = buildAgentSurface(input(), [{ id: 'airhorn', name: 'Airhorn', playing: true }])
    expect(surface.scene).toEqual({
      id: 'screen-camera',
      name: 'Screen + camera',
      kind: 'layout',
      modified: false
    })
    expect(surface.scenes.map((scene) => `${scene.kind}:${scene.id}`)).toEqual([
      'saved:scene-1',
      'layout:screen-camera',
      'layout:screen-only'
    ])
    expect(surface.microphone).toEqual({ muted: false, name: 'MacBook Pro Microphone' })
    expect(surface.systemAudio).toEqual({ on: true, available: true })
    expect(surface.takeoverId).toBe('brb')
    expect(surface.takeovers).toEqual([{ id: 'brb', name: 'BRB' }])
    expect(surface.background).toEqual({ liveId: 'silk', look: 'satin' })
    expect(surface.captions).toEqual({ on: true, state: 'listening' })
    expect(surface.buddy).toEqual({ on: true, status: 'listening' })
    expect(surface.sources.devices.map((device) => device.kind)).toEqual([
      'screen',
      'microphone',
      'camera'
    ])
    expect(surface.sources.devices[2]).toEqual({
      id: 'cam-1',
      name: 'FaceTime HD',
      kind: 'camera',
      available: false
    })
    expect(surface.sources.chosen).toEqual({ screenId: 'screen-1', microphoneId: 'mic-1' })
    expect(surface.destinations).toEqual([
      {
        id: 'twitch-1',
        platform: 'twitch',
        label: 'Twitch',
        on: true,
        ready: true,
        title: 'Building an MCP live',
        category: 'Software and Game Development'
      },
      {
        id: 'youtube-1',
        platform: 'youtube',
        label: 'YouTube',
        on: false,
        ready: false,
        reason: 'Finish setting up YouTube in Livestream.',
        title: 'Building an MCP live'
      }
    ])
    expect(surface.liveBlockedReason).toBe('Turn on a destination in Livestream.')
    expect(surface).not.toHaveProperty('recordBlockedReason')
  })

  it('names the saved scene when one is active, and says a picture background is a picture', () => {
    const surface = buildAgentSurface(
      input({
        activeSavedSceneId: 'scene-1',
        savedSceneModified: true,
        background: { assetId: 'beach', managedAssetPath: '/x/beach.png' } as never
      }),
      []
    )
    expect(surface.scene).toEqual({ id: 'scene-1', name: 'Coding', kind: 'saved', modified: true })
    expect(surface.background).toEqual({ picture: true })
  })

  it('never carries a key, a server URL, an account id, a path or a device detail (D9)', () => {
    const wire = JSON.stringify(buildAgentSurface(input(), []))
    for (const secret of [
      'live_123_secret_key',
      'stream-key:twitch-1',
      'rtmp://',
      '••••1234',
      'account-secret-id',
      '/Users/me',
      'managedAssetPath',
      'assetId',
      'System Settings',
      'Old name'
    ]) {
      expect(wire, secret).not.toContain(secret)
    }
  })
})

describe('AgentSurfacePublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function store(): SoundboardStore {
    return {
      getSnapshot: () => ({ board: null, voices: [], hidden: new Set() }),
      subscribe: () => () => undefined
    } as unknown as SoundboardStore
  }

  it('publishes only while Agents is on, deduped, and again after a reconnect', async () => {
    const request = vi.fn(async () => ({ ok: true }) as never)
    const publisher = new AgentSurfacePublisher(store())
    publisher.attach({ request })
    publisher.markConnected()
    publisher.sync(input())
    await vi.advanceTimersByTimeAsync(500)
    expect(request).not.toHaveBeenCalled()

    publisher.setEnabled(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('agent.surface.publish', {
      surface: expect.objectContaining({ version: 1 })
    })

    publisher.sync(input())
    await vi.advanceTimersByTimeAsync(500)
    expect(request).toHaveBeenCalledTimes(1)

    publisher.sync(input({ microphoneMuted: true }))
    await vi.advanceTimersByTimeAsync(500)
    expect(request).toHaveBeenCalledTimes(2)

    publisher.markConnected()
    await vi.advanceTimersByTimeAsync(10)
    expect(request).toHaveBeenCalledTimes(3)

    publisher.setEnabled(false)
    publisher.sync(input({ microphoneMuted: false }))
    await vi.advanceTimersByTimeAsync(500)
    expect(request).toHaveBeenCalledTimes(3)
    publisher.detach()
  })

  it('also publishes while Buddy may use the tools, Agents off (plan 209 S19)', async () => {
    const request = vi.fn(async () => ({ ok: true }) as never)
    const publisher = new AgentSurfacePublisher(store())
    publisher.attach({ request })
    publisher.markConnected()
    publisher.sync(input({ buddyCanAct: false }))
    await vi.advanceTimersByTimeAsync(500)
    expect(request).not.toHaveBeenCalled()

    // Premium arrives: the planner's names are published at once.
    publisher.sync(input({ buddyCanAct: true }))
    await vi.advanceTimersByTimeAsync(10)
    expect(request).toHaveBeenCalledTimes(1)

    // The projection itself never carries the flag.
    const published = (request.mock.calls[0] as unknown[])[1] as { surface: object }
    expect(published.surface).not.toHaveProperty('buddyCanAct')

    publisher.sync(input({ buddyCanAct: false, microphoneMuted: true }))
    await vi.advanceTimersByTimeAsync(500)
    expect(request).toHaveBeenCalledTimes(1)
    publisher.detach()
  })
})
