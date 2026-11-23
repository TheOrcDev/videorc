import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { Device, SourceSelection } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { QuickSettings } from './quick-settings'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  // Plan 258 S4: the camera status the system effect line reads.
  preview: { previewCameraStatus: {} as Record<string, unknown> },
  // Plan 258 S5: an open room disables the effects until S8.
  cloud: { cloudStatus: null as Record<string, unknown> | null }
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioPreview: () => mocked.preview,
  useStudioCloud: () => mocked.cloud,
  useStudioChat: () => ({
    liveChatSnapshot: { providers: [], messages: [], unreadCount: 0, updatedAt: '' },
    chatNewCount: 0
  }),
  useStudioRecordingState: () => ({ recording: { state: 'idle' } }),
  useStudioShell: () => ({ openCommentsWindow: vi.fn(), runtimeInfo: { platform: 'darwin' } })
}))
vi.mock('@/hooks/use-background-assets', () => ({
  useBackgroundAssets: () => ({
    registry: {
      version: 2,
      slots: [{ id: 'slot-1', defaultLabel: 'Loft', assetId: 'builtin-bg-06', status: 'ready' }],
      assets: {
        'builtin-bg-06': { id: 'builtin-bg-06', name: 'Loft', assetPath: '/assets/loft.webp' }
      },
      activeSlotId: null,
      bundledPresetVersion: 1,
      live: { activeId: null, settings: {} }
    }
  })
}))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: vi.fn() })
}))

describe('Studio Sources rows (plan 080 S4, plan 231 D8)', () => {
  const display: Device = { id: 'screen:2', name: 'Display 2', kind: 'screen', status: 'available' }
  const camera: Device = {
    id: 'camera:1',
    name: 'MacBook Pro Camera',
    kind: 'camera',
    status: 'available'
  }

  function renderInputs(
    sources: SourceSelection,
    devices: Device[] = [display, camera],
    layout: Partial<typeof defaultCaptureConfig.layout> = {},
    settings: Record<string, unknown> = {}
  ): string {
    mocked.core = {
      captureConfig: {
        ...defaultCaptureConfig,
        sources,
        layout: { ...defaultCaptureConfig.layout, ...layout }
      },
      applyLayoutPatch: vi.fn(),
      setCaptureConfig: vi.fn(),
      switchSourceDeviceLive: vi.fn(),
      sourceSwitchReason: () => null,
      sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
      retrySourceStatus: vi.fn(),
      allowCaptureNone: true,
      deviceList: { devices, warnings: [] },
      selectedCaptureDevice: devices.find((device) => device.id === sources.screenId),
      selectedCamera: devices.find((device) => device.id === sources.cameraId),
      selectedMicrophone: undefined,
      isSessionActive: false,
      audioBusActive: false,
      entitlements: null,
      captionsStatus: { state: 'idle' },
      captionsCommandPending: false,
      wsStatus: 'connected',
      systemAudioConfirmed: null,
      systemAudioIssue: null,
      settings,
      applyCameraBackground: vi.fn(),
      runtimeInfo: { platform: 'darwin' },
      screenPrivacy: { hidden: false }
    }
    return renderToStaticMarkup(createElement(QuickSettings))
  }

  const rowLabels = (markup: string): string[] =>
    [...markup.matchAll(/data-slot="inspector-row".*?<span[^>]*>([^<]+)<\/span>/g)].map(
      (match) => match[1] as string
    )

  it('gives the camera its row, and leaves audio to the Audio section', () => {
    const systemAudio: Device = {
      id: 'system-audio',
      name: 'System audio',
      kind: 'system-audio',
      status: 'available'
    }
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' }, [
      display,
      camera,
      systemAudio
    ])
    // The microphone and System audio live in the Audio section above (plans
    // 092 and 201); Output is the Session row (plan 174 S3.3, B-15).
    // Captions is a door to its page (plan 174 S3.2, B-13), not a switch row.
    expect(rowLabels(markup)).toEqual(['Camera'])
    expect(markup).not.toContain('System audio')
    // No switch at all: Background is one pick behind a trigger, and no audio row.
    expect(markup).not.toContain('role="switch"')
    expect(markup).toContain('data-slot="camera-background"')
    expect(markup).toMatch(/data-slot="navigable-row"[^>]*>[\s\S]*?>Captions</)
    expect(markup).not.toContain('aria-label="Enable live captions"')
    expect(markup).not.toContain('Mute microphone')
    expect(markup).toContain('title="MacBook Pro Camera"')
    // The old joined trigger ("Display 2 · MacBook Pro Camera") is gone.
    expect(markup).not.toContain('Display 2 · MacBook Pro Camera')
  })

  it('calls them Sources, with a way home, and keeps Captions out of them (B-15, B-25)', () => {
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' })
    expect(markup).not.toContain('Inputs')
    const [sources, captions] = markup.split('data-slot="panel-section"').slice(1)
    // Plan 235 D3: no title; the group keeps its name for screen readers.
    expect(sources).not.toContain('<h2')
    expect(sources).toMatch(
      /aria-label="Sources"[^>]*role="group"|role="group"[^>]*aria-label="Sources"/
    )
    // Plan 235 D4: the way home is one cog, at the end of the Camera row.
    const cogs = [...(sources ?? '').matchAll(/<button[^>]*aria-label="Open Sources"[^>]*>/g)]
    expect(cogs).toHaveLength(1)
    expect(cogs[0]?.[0]).toContain('data-testid="open-page-cog"')
    const cameraRow = (sources ?? '').split('data-slot="inspector-row"')[1] ?? ''
    expect(cameraRow).toContain('aria-label="Open Sources"')
    expect(cameraRow.indexOf('aria-label="Open Sources"')).toBeGreaterThan(
      cameraRow.indexOf('aria-label="Camera"')
    )
    expect(sources).not.toContain('>Open Sources</button>')
    expect(rowLabels(sources ?? '')).toEqual(['Camera'])
    expect(captions).not.toContain('<h2')
    // Captions is a door to its page there (plan 174 S3.2, B-13), not a switch row.
    expect(rowLabels(captions ?? '')).toEqual([])
    expect(captions).toMatch(/data-slot="navigable-row"[^>]*>[\s\S]*?>Captions</)
    // Chat's door sits right under Captions, built like it (plan 213 B1).
    expect(
      [
        ...(captions ?? '').matchAll(/data-slot="navigable-row"[\s\S]*?<span[^>]*>([^<]+)<\/span>/g)
      ].map((match) => match[1])
    ).toEqual(['Captions', 'Chat'])
  })

  it('opens Camera with one click: the row control is the dropdown', () => {
    // Owner, 2026-09-30: "for screen we're opening two dropdowns, it should
    // just be one ... same for camera". No popover wraps a second select.
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' })
    const trigger = /<button[^>]*aria-label="Camera"[^>]*>/.exec(markup)?.[0]
    expect(trigger).toContain('role="combobox"')
    // The camera's own line; Background's trigger under it opens its picker (plan 258 S5).
    const row =
      (markup.split('data-slot="inspector-row"')[1] ?? '').split(
        'data-slot="camera-background"'
      )[0] ?? ''
    expect(row).not.toContain('aria-haspopup="dialog"')
  })

  it('has no Screen row: the screen lives with the scene that shows it (plan 231 D8)', () => {
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' })
    expect(markup).not.toContain('aria-label="Screen"')
    expect(markup).not.toContain('title="Display 2"')
    // Hide screen and its chip moved with it, to the scene's Screen field.
    expect(markup).not.toContain('data-videorc-screen-privacy')
    expect(markup).not.toContain('Hide screen')
    expect(markup).not.toContain('data-slot="screen-privacy"')
  })

  it('shows Off for no camera, and the saved name for a missing one', () => {
    expect(renderInputs({ screenId: 'screen:2', cameraOff: true })).toContain('title="Off"')
    const missing = renderInputs({
      screenId: 'screen:2',
      cameraId: 'camera:gone',
      cameraName: 'Cam Link 4K'
    })
    expect(missing).toContain('title="Cam Link 4K"')
    // Plan 174 S1.9: the row says it is gone, in words.
    expect(missing).toContain('>Not found</span>')
  })

  it('says why a listed camera cannot run, never the raw status (S1.9)', () => {
    const locked = { ...camera, status: 'permission-required' as const }
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' }, [display, locked])
    expect(markup).toContain('>Needs permission</span>')
    expect(markup).not.toContain('permission-required')
  })

  it('says no camera was found instead of Off when none is listed (S1.9)', () => {
    const markup = renderInputs({ screenId: 'screen:2', cameraOff: true }, [display])
    expect(markup).toContain('title="No cameras found"')
    expect(markup).not.toContain('title="Off"')
  })

  const backgroundLine = (markup: string): string =>
    (markup.split('data-slot="inspector-row"')[1] ?? '').split(
      'data-slot="camera-background"'
    )[1] ?? ''
  const backgrounds = (background: Record<string, unknown>) => ({
    cameraBackgrounds: { 'camera:1': { blurPct: 70, edges: 'balanced', ...background } },
    cameraBackgroundMigration: 1
  })
  const trigger = (line: string): string =>
    line.match(/<button[^>]*data-videorc-camera-background-trigger[^>]*>[\s\S]*?<\/button>/)?.[0] ??
    ''

  it('replaces the Green screen line with one Background trigger, closed until clicked (plan 258 S5)', () => {
    const line = backgroundLine(renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' }))
    const button = trigger(line)
    // "Background · Off" with a picture of the pick; the tiles wait in the popover.
    expect(button).toContain('aria-label="Background: Off"')
    expect(button).toContain('>Background<')
    expect(button).toContain('>Off<')
    expect(button).toContain('<svg')
    expect(line).not.toContain('role="radiogroup"')
    expect(line).not.toContain('aria-label="Green screen"')
    expect(line).not.toContain('Adjust')
  })

  it('names the pick from the camera’s own setting, never the scene’s key', () => {
    const value = (background: Record<string, unknown>, layout = {}) =>
      trigger(
        backgroundLine(
          renderInputs(
            { screenId: 'screen:2', cameraId: 'camera:1' },
            undefined,
            layout,
            backgrounds(background)
          )
        )
      ).match(/aria-label="Background: ([^"]+)"/)?.[1]
    expect(value({ mode: 'blur', blurPct: 70 })).toBe('Strong blur')
    expect(value({ mode: 'blur', blurPct: 30 })).toBe('Slight blur')
    expect(value({ mode: 'blur', blurPct: 55 })).toBe('Blur 55%')
    expect(value({ mode: 'image', assetId: 'builtin-bg-06' })).toBe('Loft')
    expect(value({ mode: 'blue' })).toBe('Blue screen')
    // A scene that keys on its own no longer names the pick: the camera's does.
    expect(value({ mode: 'off' }, { cameraChromaKeyEnabled: true })).toBe('Off')
  })

  it('says under the trigger when the effect is covering for itself, never as a toast (plan 258 S5)', () => {
    const withStage = (cameraBackground: Record<string, unknown> | undefined): string => {
      mocked.preview = { previewCameraStatus: cameraBackground ? { cameraBackground } : {} }
      const markup = renderInputs(
        { screenId: 'screen:2', cameraId: 'camera:1' },
        undefined,
        {},
        backgrounds({ mode: 'blur' })
      )
      mocked.preview = { previewCameraStatus: {} }
      return markup
    }
    const running = { mode: 'blur', state: 'running', processedFrames: 9, coverFrames: 0 }
    expect(withStage(running)).not.toContain('data-slot="camera-background-stage"')
    // A cover shorter than 2 s says nothing (a blink, D6 covers it).
    expect(withStage({ ...running, state: 'cover', coverForMs: 400 })).not.toContain(
      'data-slot="camera-background-stage"'
    )
    const cover = withStage({ ...running, state: 'cover', coverForMs: 2400 })
    expect(cover.split('data-slot="camera-background-stage"')[1]).toContain(
      'Background is catching up. Viewers see your whole camera blurred until it&#x27;s back.'
    )
    expect(cover.indexOf('data-slot="camera-background-stage"')).toBeGreaterThan(
      cover.indexOf('data-slot="camera-background"')
    )
    expect(
      withStage({ ...running, mode: 'image', state: 'unavailable' }).split(
        'data-slot="camera-background-stage"'
      )[1]
    ).toContain('Viewers see only your picture until you turn the effect off.')
  })

  it('says under the Camera row when the system changes its background, never as a toast (plan 258 S4)', () => {
    const withEffect = (systemEffect: Record<string, unknown> | undefined): string => {
      mocked.preview = { previewCameraStatus: systemEffect ? { systemEffect } : {} }
      const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' })
      mocked.preview = { previewCameraStatus: {} }
      return markup
    }
    const flags = {
      backgroundBlur: false,
      backgroundReplacement: false,
      studioLight: false,
      turnedOffByVideorc: false
    }
    expect(withEffect(undefined)).not.toContain('data-slot="camera-system-effect"')
    expect(
      withEffect({ provider: 'macos-video-effects', ...flags, studioLight: true })
    ).not.toContain('data-slot="camera-system-effect"')
    const portrait = withEffect({ provider: 'macos-video-effects', ...flags, backgroundBlur: true })
    const line = portrait.split('data-slot="camera-system-effect"')[1] ?? ''
    expect(line).toContain(
      'macOS is blurring this camera (Video menu, Portrait). Turn it off there to use Videorc&#x27;s background.'
    )
    // Under the Background line, inside the Camera row.
    expect(portrait.indexOf('data-slot="camera-system-effect"')).toBeGreaterThan(
      portrait.indexOf('data-slot="camera-background"')
    )
    expect(
      withEffect({ provider: 'windows-studio-effects', ...flags, backgroundBlur: true })
    ).toContain('Windows Studio Effects is blurring this camera')
  })

  it('has no Background while the camera is Off: there is nothing behind you to change', () => {
    const markup = renderInputs({ screenId: 'screen:2', cameraOff: true })
    expect(markup).not.toContain('data-slot="camera-background"')
    expect(markup).not.toContain('data-videorc-camera-background-trigger')
  })
})
