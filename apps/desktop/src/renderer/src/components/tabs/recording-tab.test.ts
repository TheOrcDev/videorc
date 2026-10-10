// @vitest-environment happy-dom
import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VideoSettings } from '@/lib/backend'
import {
  coerceVideoToOrientation,
  defaultCaptureConfig,
  layoutPresetOrientation,
  videoPresets,
  type CaptureConfig
} from '@/lib/capture'
import { LANDSCAPE_CANVAS_RULE } from '@/lib/output-quality'
import { QuickSettings } from '@/components/studio/quick-settings'
import { RecordingTab } from './recording-tab'

// Plan 174: the Output page's typed fields commit once and never transpose
// (D-1), and the Output page and the Studio's Output row pick a resolution
// the same way, so the bitrate moves with the size on both (D-8).

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: () => {} })
}))

let root: Root
let container: HTMLDivElement
let patches: Partial<VideoSettings>[]
let stored: VideoSettings

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  patches = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** The provider's `patchVideo`: merge, mark Custom, keep the scene's orientation. */
function Harness({ surface, video }: { surface: () => ReactElement; video: VideoSettings }) {
  const [config, setConfig] = useState<CaptureConfig>({ ...defaultCaptureConfig, video })
  stored = config.video
  mocked.core = {
    captureConfig: config,
    setCaptureConfig: setConfig,
    patchVideo: (patch: Partial<VideoSettings>) => {
      patches.push(patch)
      setConfig((current) => ({
        ...current,
        video: coerceVideoToOrientation(
          { ...current.video, ...patch, preset: 'custom' },
          layoutPresetOrientation(current.layout.layoutPreset)
        )
      }))
    },
    applyVideoPreset: vi.fn(),
    isSessionActive: false,
    goLiveConfirmationPending: false,
    goLivePartialSetup: null,
    entitlements: null,
    performanceCheck: undefined,
    performanceCheckProgress: null,
    runPerformanceCheck: vi.fn(),
    // Studio's Inputs rows.
    switchSourceDeviceLive: vi.fn(),
    sourceSwitchReason: () => null,
    sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
    retrySourceStatus: vi.fn(),
    allowCaptureNone: true,
    deviceList: { devices: [], warnings: [] },
    selectedCaptureDevice: undefined,
    selectedCamera: undefined,
    selectedMicrophone: undefined,
    captionsStatus: { state: 'idle' },
    captionsCommandPending: false,
    wsStatus: 'connected',
    systemAudioConfirmed: null,
    systemAudioIssue: null
  }
  return surface()
}

async function render(
  surface: () => ReactElement,
  video: VideoSettings = videoPresets['tutorial-1080p30']
): Promise<void> {
  await act(async () => root.render(createElement(Harness, { surface, video })))
}

function input(label: string): HTMLInputElement {
  const field = [...document.querySelectorAll('label')].find(
    (entry) => entry.textContent === label
  )!
  expect(field).toBeTruthy()
  return document.getElementById(field.htmlFor) as HTMLInputElement
}

async function type(element: HTMLInputElement, text: string): Promise<void> {
  // One input event per keystroke, as the user types it.
  for (let index = 1; index <= text.length; index += 1) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        element,
        text.slice(0, index)
      )
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}

async function key(element: HTMLInputElement, name: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}

async function blur(element: HTMLInputElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

const renderOutputPage = (): Promise<void> => render(() => createElement(RecordingTab))

describe('Output page typed fields (plan 174, D-1)', () => {
  it('typing 2560 into Width gives 2560×1080, committed once on blur', async () => {
    await renderOutputPage()
    const width = input('Width')
    await type(width, '2560')
    expect(patches).toEqual([])
    expect(width.value).toBe('2560')
    await blur(width)
    expect(patches).toEqual([{ width: 2560 }])
    expect([stored.width, stored.height]).toEqual([2560, 1080])
    expect(input('Width').value).toBe('2560')
    expect(input('Height').value).toBe('1080')
  })

  it('commits on Enter and labels every field', async () => {
    await renderOutputPage()
    for (const label of ['Width', 'Height', 'FPS', 'Bitrate kbps']) {
      expect(input(label).id).not.toBe('')
    }
    const fps = input('FPS')
    await type(fps, '60')
    await key(fps, 'Enter')
    expect(patches).toEqual([{ fps: 60 }])
    expect(stored.fps).toBe(60)
  })

  it('refuses a height taller than a landscape width, and keeps the setting', async () => {
    await renderOutputPage()
    const height = input('Height')
    await type(height, '2000')
    await key(height, 'Enter')
    expect(patches).toEqual([])
    expect([stored.width, stored.height]).toEqual([1920, 1080])
    expect(height.value).toBe('1080')
    expect(height.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(height.getAttribute('aria-describedby')!)
    expect(error?.textContent).toBe(LANDSCAPE_CANVAS_RULE)
    // Typing again clears the rule.
    await type(height, '1200')
    expect(height.getAttribute('aria-invalid')).toBeNull()
  })

  it('puts the setting back on Escape without committing', async () => {
    await renderOutputPage()
    const bitrate = input('Bitrate kbps')
    await type(bitrate, '99')
    await key(bitrate, 'Escape')
    expect(bitrate.value).toBe(String(videoPresets['tutorial-1080p30'].bitrateKbps))
    await blur(bitrate)
    expect(patches).toEqual([])
  })
})

describe('one resolution picker on both surfaces (plan 174, D-8)', () => {
  it('moves the bitrate with the size on the Output page and in the Studio row alike', async () => {
    await renderOutputPage()
    const button = [...document.querySelectorAll('button')].find((entry) =>
      entry.textContent?.startsWith('4K')
    )!
    await act(async () => button.click())
    const fromOutputPage = { ...stored }
    await act(async () => root.unmount())

    patches = []
    root = createRoot(container)
    await render(() => createElement(QuickSettings))
    const outputRow = [...document.querySelectorAll('[data-slot="inspector-row"]')].find(
      (row) => row.querySelector('span')?.textContent === 'Output'
    )!
    await act(async () => (outputRow.querySelector('[role="combobox"]') as HTMLElement).click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.startsWith('4K')
    )!
    await act(async () => option.click())
    const fromStudioRow = { ...stored }

    expect(fromStudioRow).toEqual(fromOutputPage)
    expect(fromStudioRow).toMatchObject({ width: 3840, height: 2160, bitrateKbps: 30000 })
  })
})
