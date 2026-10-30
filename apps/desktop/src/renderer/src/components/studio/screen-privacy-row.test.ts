// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Device, ScreenPrivacy, SourceSelection } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { SCREEN_HIDE_UNAVAILABLE } from '@/lib/studio-actions/privacy'
import { QuickSettings } from './quick-settings'
import { RetroQuickSettings } from './retro-lcd-studio'

// Plan 210 S8b: Hide screen on the Studio's Screen row (D9), in both looks.
// One button with its key, Show screen and the Screen hidden chip while
// hidden, and a refused hide's reason. It is there with or without a screen.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: vi.fn(), openStudioPanel: vi.fn(), setActive: vi.fn() }),
  WorkspaceNavContext: { Provider: () => null }
}))
const toastUserError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/user-error', () => ({ toastUserError }))

const display: Device = { id: 'screen:2', name: 'Display 2', kind: 'screen', status: 'available' }

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  toastUserError.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function core(
  privacy: ScreenPrivacy,
  extra: { sources?: SourceSelection; screenHideToggle?: string; wsStatus?: string } = {}
) {
  const sources = extra.sources ?? { screenId: 'screen:2', cameraOff: true }
  const hideScreen = vi.fn(async () => ({ ok: true }))
  const showScreen = vi.fn(async () => ({ ok: true }))
  mocked.core = {
    captureConfig: { ...defaultCaptureConfig, sources },
    setCaptureConfig: vi.fn(),
    switchSourceDeviceLive: vi.fn(),
    sourceSwitchReason: () => null,
    sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
    retrySourceStatus: vi.fn(),
    allowCaptureNone: true,
    deviceList: { devices: [display], warnings: [] },
    selectedCaptureDevice: sources.screenId ? display : undefined,
    selectedCamera: undefined,
    isSessionActive: false,
    captionsStatus: { state: 'idle' },
    wsStatus: extra.wsStatus ?? 'connected',
    systemAudioConfirmed: null,
    systemAudioIssue: null,
    runtimeInfo: { platform: 'darwin' },
    settings: {
      globalShortcuts:
        'screenHideToggle' in extra ? { screenHideToggle: extra.screenHideToggle } : {}
    },
    screenPrivacy: privacy,
    hideScreen,
    showScreen
  }
  return { hideScreen, showScreen }
}

async function render(view: () => ReactElement): Promise<void> {
  await act(async () => root.render(createElement(TooltipProvider, { delay: 0, children: view() })))
}

const line = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-slot="screen-privacy"]')!
const button = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-videorc-screen-privacy]')!
const tooltip = (): string | null | undefined =>
  document.querySelector('[data-slot="tooltip-content"]')?.textContent

describe('Studio Screen row: Hide screen (plan 210 S8b)', () => {
  it('hides from a 24 px button with the key beside it and in its tooltip', async () => {
    const { hideScreen, showScreen } = core({ hidden: false })
    await render(() => createElement(QuickSettings))
    // On the Screen row, under its picker, never in the transport.
    const row = line().closest('[data-slot="inspector-row"]')!
    expect(row.querySelector('span')?.textContent).toBe('Screen')
    expect(button().textContent).toBe('Hide screen')
    expect(button().dataset.size).toBe('xs')
    expect(line().querySelector('[data-slot="status-badge"]')).toBeNull()
    expect(line().querySelector('kbd')?.dataset.accelerator).toBe('Control+Alt+H')
    await act(async () => button().focus())
    expect(tooltip()).toContain('Hide screen')
    expect(document.querySelector('[data-slot="tooltip-content"] kbd')?.textContent).toBe('⌃⌥H')
    await act(async () => button().click())
    expect(hideScreen).toHaveBeenCalledTimes(1)
    expect(showScreen).not.toHaveBeenCalled()
  })

  it('reads Show screen in the same place while hidden, and the row says Screen hidden', async () => {
    const { hideScreen, showScreen } = core({ hidden: true, reason: 'you' })
    await render(() => createElement(QuickSettings))
    expect(button().textContent).toBe('Show screen')
    const chip = line().querySelector<HTMLElement>('[data-slot="status-badge"]')!
    expect(chip.textContent).toBe('Screen hidden')
    // A privacy state, not an error: the attention tone on its icon, no tint.
    expect(chip.dataset.tone).toBe('warn')
    expect(chip.className).not.toContain('glass-chip-tinted')
    // The button keeps the right edge, after the chip.
    expect(line().lastElementChild?.contains(button())).toBe(true)
    await act(async () => button().click())
    expect(showScreen).toHaveBeenCalledTimes(1)
    expect(hideScreen).not.toHaveBeenCalled()
  })

  it('is disabled with the legacy recording’s reason, and shows again even then', async () => {
    core({ hidden: false, unavailable: SCREEN_HIDE_UNAVAILABLE })
    await render(() => createElement(QuickSettings))
    expect(button().disabled).toBe(true)
    const wrapper = container.querySelector<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(
      document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe("Hide screen isn't available on this recording. Stop and record again.")
    await act(async () => wrapper.focus())
    expect(tooltip()).toContain('Stop and record again.')

    core({ hidden: true, unavailable: SCREEN_HIDE_UNAVAILABLE })
    await render(() => createElement(QuickSettings))
    expect(button().disabled).toBe(false)
  })

  it('says Videorc is reconnecting instead of failing quietly', async () => {
    core({ hidden: false }, { wsStatus: 'connecting' })
    await render(() => createElement(QuickSettings))
    expect(button().disabled).toBe(true)
    expect(container.querySelector('[data-slot="disabled-reason"]')).not.toBeNull()
  })

  it('stays with no screen in the scene: hiding is allowed', async () => {
    core({ hidden: false }, { sources: { cameraOff: true } })
    await render(() => createElement(QuickSettings))
    expect(button().textContent).toBe('Hide screen')
    expect(button().disabled).toBe(false)
  })

  it('drops the key once it is cleared in Settings, and says a failure', async () => {
    const { hideScreen } = core({ hidden: false }, { screenHideToggle: '' })
    hideScreen.mockRejectedValueOnce(new Error('socket closed'))
    await render(() => createElement(QuickSettings))
    expect(line().querySelector('kbd')).toBeNull()
    await act(async () => button().focus())
    expect(document.querySelector('[data-slot="tooltip-content"] kbd')).toBeNull()
    await act(async () => button().click())
    expect(toastUserError).toHaveBeenCalledWith(
      expect.any(Error),
      { action: 'hide', object: 'your screen' },
      { id: 'screen-privacy' }
    )
  })
})

describe('Retro LCD Sources: Hide screen (plan 210 S8b)', () => {
  const pressRow = (): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-slot="lcd-panel-press-row"]')].find(
      (row) => row.textContent?.startsWith('Hide screen')
    )!

  it('is the Sources screen’s own row: Off, then On lit while hidden', async () => {
    const { hideScreen } = core({ hidden: false })
    await render(() => createElement(RetroQuickSettings))
    expect(pressRow().textContent).toBe('Hide screenOff')
    expect(pressRow().getAttribute('aria-pressed')).toBe('false')
    await act(async () => pressRow().focus())
    expect(tooltip()).toContain('Hide screen')
    expect(document.querySelector('[data-slot="tooltip-content"] kbd')?.textContent).toBe('⌃⌥H')
    await act(async () => pressRow().click())
    expect(hideScreen).toHaveBeenCalledTimes(1)

    const shown = core({ hidden: true, reason: 'you' })
    await render(() => createElement(RetroQuickSettings))
    expect(pressRow().textContent).toBe('Hide screenOn')
    expect(pressRow().getAttribute('aria-pressed')).toBe('true')
    await act(async () => pressRow().click())
    expect(shown.showScreen).toHaveBeenCalledTimes(1)
  })

  it('says why a hide is refused on the screen', async () => {
    core({ hidden: false, unavailable: SCREEN_HIDE_UNAVAILABLE })
    await render(() => createElement(RetroQuickSettings))
    expect(pressRow().disabled).toBe(true)
    const wrapper = pressRow().closest<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(
      document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe(SCREEN_HIDE_UNAVAILABLE)
  })
})
