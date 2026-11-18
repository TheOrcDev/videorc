// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import type { ObsDiscovery, ObsSetup } from '@/lib/backend'
import { type CaptureConfig, defaultCaptureConfig, STORAGE_KEYS } from '@/lib/capture'
import { OBS_PROFILE_UNREADABLE, ObsImportDialog } from './obs-import-dialog'

// Plan 174 (C-7, C-29): the OBS import says what will happen and then does
// exactly that; a failed discovery or read says so and offers Try again.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/toast', () => ({ toast: mocked.toast }))

const DISCOVERY: ObsDiscovery = {
  available: true,
  collections: ['Untitled'],
  profiles: ['Untitled'],
  currentCollection: 'Untitled',
  currentProfile: 'Untitled'
}

const item = (sourceName: string) => ({
  sourceName,
  visible: true,
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  boundsType: 0,
  boundsX: 0,
  boundsY: 0,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0
})

const SETUP: ObsSetup = {
  collectionName: 'Untitled',
  canvasWidth: 1920,
  canvasHeight: 1080,
  outputWidth: 1920,
  outputHeight: 1080,
  fps: 30,
  sources: [
    { name: 'Display', kind: 'display', obsKind: 'screen_capture' },
    {
      name: 'Backdrop',
      kind: 'image',
      obsKind: 'image_source',
      managedBackground: {
        id: 'obs-backdrop',
        name: 'Backdrop',
        assetPath: 'videorc-asset://background/obs-backdrop.png',
        thumbnailPath: 'videorc-asset://background/obs-backdrop.png',
        fileName: 'backdrop.png'
      }
    }
  ],
  scenes: [{ name: 'Scene', current: true, items: [item('Backdrop'), item('Display')] }],
  hasDesktopAudio: false
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = {
    deviceList: { devices: [], warnings: [] },
    setCaptureConfig: vi.fn(),
    setSettings: vi.fn()
  }
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(videorc: Record<string, unknown>): Promise<void> {
  vi.stubGlobal('videorc', videorc)
  await act(async () =>
    root.render(
      createElement(
        BackgroundAssetsProvider,
        null,
        createElement(ObsImportDialog, { open: true, onOpenChange: () => {} })
      )
    )
  )
}

const text = (): string => document.body.textContent ?? ''
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === label
  )

describe('Import from OBS', () => {
  it('says discovery failed, and Try again looks again', async () => {
    const obsDiscover = vi
      .fn<() => Promise<ObsDiscovery>>()
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'obs:discover': Error: EACCES: permission denied")
      )
      .mockResolvedValue(DISCOVERY)
    await render({ obsDiscover, obsRead: vi.fn(async () => SETUP) })
    expect(text()).toContain("Couldn't look for OBS Studio. EACCES: permission denied")
    expect(text()).not.toContain('Looking for OBS Studio')

    await act(async () => button('Try again')!.click())
    expect(obsDiscover).toHaveBeenCalledTimes(2)
    expect(text()).not.toContain("Couldn't look for OBS Studio")
    // Both pickers are named on screen, not only for a screen reader.
    for (const label of ['Scene collection', 'Profile']) {
      const field = [...document.querySelectorAll('label')].find(
        (entry) => entry.textContent === label
      )!
      expect(document.getElementById(field.htmlFor)?.getAttribute('role')).toBe('combobox')
    }
  })

  it('says a profile could not be read, and Try again reads it again', async () => {
    const obsRead = vi
      .fn<(collection: string, profile: string) => Promise<ObsSetup | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(SETUP)
    await render({ obsDiscover: vi.fn(async () => DISCOVERY), obsRead })
    expect(text()).toContain(`Couldn't read this OBS profile. ${OBS_PROFILE_UNREADABLE}`)
    expect(text()).not.toContain('Reading your OBS setup')
    expect(button('Import setup')!.disabled).toBe(true)

    await act(async () => button('Try again')!.click())
    expect(obsRead).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Will import')
  })

  it('names the background the import replaces, then applies exactly that', async () => {
    await render({ obsDiscover: vi.fn(async () => DISCOVERY), obsRead: vi.fn(async () => SETUP) })
    // A fresh profile has no empty slot: the last built-in preset is named.
    expect(text()).toContain('Becomes the scene background, in place of Focus in Assets.')
    const importButton = button('Import setup')!
    expect(importButton.querySelectorAll('svg')).toHaveLength(1)

    await act(async () => importButton.click())
    expect(mocked.core.setCaptureConfig).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.backgroundAssets)!)
    expect(stored.slots.find((slot: { id: string }) => slot.id === 'bg-10').assetId).toBe(
      'obs-backdrop'
    )
    expect(stored.activeSlotId).toBe('bg-10')
    // The toast closes the loop without pointing back at the closed report.
    expect(mocked.toast.success).toHaveBeenCalledWith('OBS setup imported', {
      description: 'Check Sources and Scene.'
    })
  })

  it('keeps Import off while discovery has failed, even with an earlier read', async () => {
    const obsDiscover = vi
      .fn<() => Promise<ObsDiscovery>>()
      .mockResolvedValueOnce(DISCOVERY)
      .mockRejectedValue(new Error('offline'))
    const videorc = { obsDiscover, obsRead: vi.fn(async () => SETUP) }
    await render(videorc)
    expect(button('Import setup')!.disabled).toBe(false)

    // Closed and opened again: the collection and profile are remembered, so
    // the read succeeds while the fresh discovery fails.
    for (const open of [false, true]) {
      await act(async () =>
        root.render(
          createElement(
            BackgroundAssetsProvider,
            null,
            createElement(ObsImportDialog, { open, onOpenChange: () => {} })
          )
        )
      )
    }
    expect(text()).toContain("Couldn't look for OBS Studio. offline")
    expect(button('Import setup')!.disabled).toBe(true)
  })

  // QA F11 + F12: the platform key the report promises arrives through the
  // real Apply, and only the destination the import names changes.
  const KEY = 'fixture-obs-key-not-real'
  const platformSetup = (service: string, server: string): ObsSetup => ({
    ...SETUP,
    service: { type: 'rtmp_common', service, server, hasKey: true }
  })
  const appliedConfig = (start: CaptureConfig): CaptureConfig => {
    const setCaptureConfig = mocked.core.setCaptureConfig as ReturnType<typeof vi.fn>
    expect(setCaptureConfig).toHaveBeenCalledTimes(1)
    const update = setCaptureConfig.mock.calls[0]![0] as (current: CaptureConfig) => CaptureConfig
    return update(start)
  }
  const withTargets = (
    patch: Record<string, Partial<CaptureConfig['streaming']['targets'][number]>>
  ): CaptureConfig => {
    const config = structuredClone(defaultCaptureConfig)
    config.streaming.targets = config.streaming.targets.map((target) =>
      patch[target.id] ? { ...target, ...patch[target.id] } : target
    )
    return config
  }

  for (const [id, service, server] of [
    ['youtube', 'YouTube - RTMPS', 'rtmps://a.rtmps.youtube.com:443/live2'],
    ['facebook', 'Facebook Live', 'rtmps://live-api-s.facebook.com:443/rtmp/'],
    ['kick', 'Kick', 'rtmps://fa723fc1b171.global-contribute.live-video.net/app']
  ] as const) {
    it(`imports the ${id} stream key the report promises, replacing the old one`, async () => {
      const obsReadStreamKey = vi.fn(async () => KEY)
      const log = vi.spyOn(console, 'log')
      await render({
        obsDiscover: vi.fn(async () => DISCOVERY),
        obsRead: vi.fn(async () => platformSetup(service, server)),
        obsReadStreamKey
      })
      expect(text()).toContain('Imports the server and the stream key into')

      await act(async () => button('Import setup')!.click())

      expect(obsReadStreamKey).toHaveBeenCalledExactlyOnceWith('Untitled')
      const before = withTargets({
        [id]: { enabled: false, streamKeySecretRef: 'old-secret-ref', streamKeyPresent: true }
      })
      const next = appliedConfig(before)
      const target = next.streaming.targets.find((entry) => entry.id === id)!
      expect(target).toMatchObject({
        enabled: true,
        serverUrl: server,
        authMode: 'manual-rtmp',
        streamKey: KEY,
        streamKeyPresent: true,
        streamKeySecretRef: undefined
      })
      expect(next.streaming.enabledTargetIds).toContain(id)
      // The key never reaches a toast or the console.
      expect(JSON.stringify(mocked.toast.success.mock.calls)).not.toContain(KEY)
      expect(JSON.stringify(log.mock.calls)).not.toContain(KEY)
      log.mockRestore()
    })
  }

  it('leaves a separately set up YouTube Vertical alone on a YouTube import', async () => {
    await render({
      obsDiscover: vi.fn(async () => DISCOVERY),
      obsRead: vi.fn(async () =>
        platformSetup('YouTube - RTMPS', 'rtmps://horizontal.fixture.invalid/live2')
      ),
      obsReadStreamKey: vi.fn(async () => KEY)
    })
    await act(async () => button('Import setup')!.click())

    const before = withTargets({
      'youtube-vertical': {
        enabled: false,
        serverUrl: 'rtmps://vertical.fixture.invalid/live2',
        authMode: 'manual-rtmp',
        streamKeySecretRef: 'vertical-secret-ref',
        streamKeyPresent: true
      }
    })
    const vertical = before.streaming.targets.find((entry) => entry.id === 'youtube-vertical')
    const next = appliedConfig(before)
    expect(next.streaming.targets.find((entry) => entry.id === 'youtube-vertical')).toEqual(
      vertical
    )
    expect(next.streaming.enabledTargetIds).not.toContain('youtube-vertical')
    expect(next.streaming.targets.find((entry) => entry.id === 'youtube')).toMatchObject({
      enabled: true,
      serverUrl: 'rtmps://horizontal.fixture.invalid/live2',
      streamKey: KEY
    })
  })
})
