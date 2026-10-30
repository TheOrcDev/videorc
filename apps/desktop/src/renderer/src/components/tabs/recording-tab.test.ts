// @vitest-environment happy-dom
import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VideoSettings } from '@/lib/backend'
import {
  coerceVideoToOrientation,
  defaultCaptureConfig,
  defaultSettings,
  layoutPresetOrientation,
  videoPresets,
  type CaptureConfig,
  type SettingsState
} from '@/lib/capture'
import { LANDSCAPE_CANVAS_RULE } from '@/lib/output-quality'
import { QuickSettings } from '@/components/studio/quick-settings'
import { RecordingTab, SAVE_RECORDING_OFF, SAVE_RECORDING_ON } from './recording-tab'

// Plan 174: the Output page's typed fields commit once and never transpose
// (D-1), and the bitrate moves with the size (D-8). Studio has no second
// resolution picker: its Output row opens this page (S3.3, B-15).

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  // Plan 181: the Clips section reads the ring; off and unblocked here.
  useStudioReplay: () => ({
    state: { state: 'off', seconds: 30, bufferedSeconds: 0 },
    armed: false,
    blockedReason: null,
    setEnabled: () => {}
  })
}))
const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: () => {} })
}))

let root: Root
let container: HTMLDivElement
let patches: Partial<VideoSettings>[]
let stored: VideoSettings
let storedSettings: SettingsState

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
function Harness({
  surface,
  video,
  recordEnabled,
  initialSettings,
  configPatch
}: {
  surface: () => ReactElement
  video: VideoSettings
  recordEnabled: boolean
  initialSettings: SettingsState
  configPatch?: Partial<CaptureConfig>
}) {
  const [config, setConfig] = useState<CaptureConfig>({
    ...defaultCaptureConfig,
    ...configPatch,
    video,
    recordEnabled
  })
  const [settings, setSettings] = useState<SettingsState>(initialSettings)
  stored = config.video
  storedSettings = settings
  mocked.core = {
    captureConfig: config,
    setCaptureConfig: setConfig,
    settings,
    setSettings,
    runtimeInfo: { platform: 'darwin' },
    encoderPreference: null,
    setEncoderPreference: vi.fn(),
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
    // Studio's Sources and Captions rows.
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
    screenPrivacy: { hidden: false },
    systemAudioConfirmed: null,
    systemAudioIssue: null
  }
  return surface()
}

async function render(
  surface: () => ReactElement,
  video: VideoSettings = videoPresets['tutorial-1080p30'],
  {
    recordEnabled = true,
    settings = defaultSettings,
    config
  }: { recordEnabled?: boolean; settings?: SettingsState; config?: Partial<CaptureConfig> } = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(Harness, {
        surface,
        video,
        recordEnabled,
        initialSettings: settings,
        configPatch: config
      })
    )
  )
}

function labelled(text: string): HTMLElement {
  const label = [...document.querySelectorAll('label')].find((entry) => entry.textContent === text)!
  expect(label, text).toBeTruthy()
  return document.getElementById(label.htmlFor)!
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((entry) => entry.textContent === text)
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

const renderOutputPage = (
  video?: VideoSettings,
  options?: { recordEnabled?: boolean; settings?: SettingsState }
): Promise<void> => render(() => createElement(RecordingTab), video, options)

describe('separate files encoder notice (plan 200 D4)', () => {
  const separateFiles: Partial<CaptureConfig> = {
    separateSourceRecordings: { enabled: true, keepCombined: true },
    sources: { screenId: 'screen:1', cameraId: 'camera:1', testPattern: false }
  }
  const notice = (): HTMLElement | null =>
    document.querySelector('[data-testid="output-separate-source-recordings-encoder-notice"]')

  it('says at 4K what the separate files cost before Record', async () => {
    await render(() => createElement(RecordingTab), videoPresets['record-4k30'], {
      config: separateFiles
    })
    expect(notice()?.textContent).toBe(
      'Separate files at 4K · 30 fps use about 3× the encoder. If your Mac falls behind, Videorc stops the separate files and keeps the main recording.'
    )
  })

  it('stays quiet at 1080p30 and with the switch off', async () => {
    await render(() => createElement(RecordingTab), videoPresets['tutorial-1080p30'], {
      config: separateFiles
    })
    expect(notice()).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(() => createElement(RecordingTab), videoPresets['record-4k30'])
    expect(notice()).toBeNull()
  })
})

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

describe('one resolution picker (plan 174, D-8 and S3.3 B-15)', () => {
  it('moves the bitrate with the size on the Output page', async () => {
    await renderOutputPage()
    const button = [...document.querySelectorAll('button')].find((entry) =>
      entry.textContent?.startsWith('4K')
    )!
    await act(async () => button.click())
    expect(stored).toMatchObject({ width: 3840, height: 2160, bitrateKbps: 30000 })
  })

  it('gives Studio no second picker: Output is the Session row that opens this page', async () => {
    await render(() => createElement(QuickSettings))
    const labels = [...document.querySelectorAll('[data-slot="inspector-row"]')].map(
      (row) => row.querySelector('span')?.textContent
    )
    expect(labels).not.toContain('Output')
    expect(document.querySelector('[aria-label="Output"]')).toBeNull()
  })
})

describe('the Output page is the one home for the local file (plan 174 S3.6)', () => {
  it('names Save a local recording as a settings row whose label names the switch (D-3)', async () => {
    await renderOutputPage()
    const row = document.querySelector('[data-testid="output-save-recording"]')!
    const toggle = labelled('Save a local recording')
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(row.contains(toggle)).toBe(true)
    expect(row.textContent).toContain(SAVE_RECORDING_ON)
    expect(input('Width').disabled).toBe(false)
    await act(async () => toggle.click())
    expect(row.textContent).toContain(SAVE_RECORDING_OFF)
  })

  it('turns the quality off with the switch, and says why (D-3)', async () => {
    await renderOutputPage(undefined, { recordEnabled: false })
    for (const label of ['Width', 'Height', 'FPS', 'Bitrate kbps']) {
      expect(input(label).disabled, label).toBe(true)
    }
    expect((document.getElementById('video-preset') as HTMLButtonElement).disabled).toBe(true)
    const radios = [...document.querySelectorAll('[role="radio"]')]
    expect(radios.length).toBeGreaterThan(0)
    expect(radios.every((radio) => radio.hasAttribute('disabled'))).toBe(true)
    expect(document.body.textContent).toContain(SAVE_RECORDING_OFF)
  })

  it('shows the default recordings folder by its path, with Choose… and no reset (I-22, I-23)', async () => {
    await renderOutputPage()
    const folder = document.querySelector('[data-testid="recordings-folder"]')!
    expect(folder.textContent).toContain('~/Movies/Videorc/Recordings')
    expect(folder.querySelector('[id="output-directory"]')).toBeNull()
    expect(button('Choose…')).toBeTruthy()
    expect(button('Use default')).toBeUndefined()
    expect(button('Show in Finder')).toBeUndefined()
    expect(document.body.textContent).not.toMatch(/Browse|Reveal|Output directory|Blank uses/)
  })

  it('says why Choose… failed instead of doing nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('videorc', {
      pickDirectory: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'system:pick-directory': Error: Protected desktop persistence is unavailable."
          )
        )
    })
    await renderOutputPage()
    await act(async () => button('Choose…')!.click())
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't use that folder",
      expect.objectContaining({ description: expect.stringContaining('keyring') })
    )
    expect(storedSettings).toMatchObject({ outputDirectory: '', outputDirectoryHandle: undefined })
  })

  it('puts a chosen folder back to the default with Use default', async () => {
    await renderOutputPage(undefined, {
      settings: { ...defaultSettings, outputDirectory: 'Videos', outputDirectoryHandle: 'grant-1' }
    })
    const folder = document.querySelector('[data-testid="recordings-folder"]')!
    expect(folder.textContent).toContain('Videos')
    await act(async () => button('Use default')!.click())
    expect(storedSettings).toMatchObject({ outputDirectory: '', outputDirectoryHandle: undefined })
    expect(folder.textContent).toContain('~/Movies/Videorc/Recordings')
  })

  it('keeps Keep original recording here, as a labelled switch', async () => {
    await renderOutputPage()
    const toggle = labelled('Keep original recording')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle.click())
    expect(storedSettings.keepOriginalRecording).toBe(true)
  })
})
