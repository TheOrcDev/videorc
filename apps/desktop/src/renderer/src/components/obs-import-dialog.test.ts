// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import type { ObsDiscovery, ObsSetup } from '@/lib/backend'
import { STORAGE_KEYS } from '@/lib/capture'
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
      description: 'Check Sources and the Scene stage for anything that was approximated.'
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
})
