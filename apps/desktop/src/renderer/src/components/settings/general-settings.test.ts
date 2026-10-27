// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FIRST_RUN_SETUP_OPEN_EVENT, WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

import { GeneralSettings } from './general-settings'

// Plan 174 S3.17 (I-27): General ends with where every other setting lives.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => ({ recording: mocked.recording })
}))
vi.mock('@/hooks/use-chat-emote-settings', () => ({
  useChatEmoteSettings: () => ({
    settings: { sevenTv: false, sevenTvStatus: { state: 'off' }, twitchGifs: 'animated' },
    error: null,
    setSevenTv: () => undefined,
    setTwitchGifs: () => undefined
  })
}))
vi.mock('@/hooks/use-usage-stats-setting', () => ({
  useUsageStatsSetting: () => ({
    state: { enabled: true, envDisabled: false },
    error: null,
    setEnabled: () => undefined
  })
}))
vi.mock('@/components/obs-import-dialog', () => ({ ObsImportDialog: () => null }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.recording = { state: 'idle' }
  mocked.core = {
    settings: {},
    setSettings: vi.fn(),
    runtimeInfo: { platform: 'darwin', commentsWindowEnabled: true },
    scheduleHardwareAccelerationRetry: vi.fn(),
    account: null,
    signOutAccount: vi.fn()
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const headings = (): string[] =>
  [...container.querySelectorAll('h2')].map((heading) => heading.textContent ?? '')

describe('GeneralSettings', () => {
  it('splits into Appearance, Stream Manager, Setup, Import, Privacy and Elsewhere', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(headings()).toEqual([
      'Appearance',
      'Stream Manager',
      'Setup',
      'Import',
      'Privacy',
      'Elsewhere'
    ])
    expect(container.textContent).toContain('Open Stream Manager when you go live')
  })

  it('offers Retro LCD under Appearance, off until turned on (plan 197)', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    const toggle = container.querySelector('#retro-lcd-studio')
    expect(toggle?.getAttribute('role')).toBe('switch')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    const appearance = container.querySelector('h2')?.closest('[data-slot="panel-section"]')
    expect(appearance?.textContent).toContain('Retro LCD')
    await act(async () => (toggle as HTMLElement).click())
    const setSettings = mocked.core.setSettings as ReturnType<typeof vi.fn>
    const update = setSettings.mock.calls.at(-1)?.[0] as (current: object) => object
    expect(update({ keepOriginalRecording: false })).toEqual({
      keepOriginalRecording: false,
      retroLcdStudio: true
    })
  })

  it('hides the Stream Manager section when that window is off', async () => {
    mocked.core = {
      ...mocked.core,
      runtimeInfo: { platform: 'darwin', commentsWindowEnabled: false }
    }
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(headings()).toEqual(['Appearance', 'Setup', 'Import', 'Privacy', 'Elsewhere'])
  })

  // Plan 203 S6 (D5): first-run setup again, back to Settings after.
  const runSetupAgain = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Run setup again…'
    )

  it('runs first-run setup again and returns to Settings', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(container.textContent).toContain('First-run setup')
    expect(container.textContent).toContain(
      'Go through the welcome steps again, starting with permissions.'
    )
    const requests: unknown[] = []
    const listen = (event: Event): void => void requests.push((event as CustomEvent).detail)
    window.addEventListener(FIRST_RUN_SETUP_OPEN_EVENT, listen)
    await act(async () => runSetupAgain()?.click())
    window.removeEventListener(FIRST_RUN_SETUP_OPEN_EVENT, listen)
    expect(requests).toEqual([{ returnTo: 'settings' }])
  })

  it('locks Run setup again… while a recording or livestream runs, and says why', async () => {
    mocked.recording = { state: 'streaming' }
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(runSetupAgain()?.disabled).toBe(true)
    expect(container.innerHTML).toContain('Finish your recording or livestream first.')
  })

  it('opens the page that owns each setting', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    const opened: unknown[] = []
    const listen = (event: Event): void => void opened.push((event as CustomEvent).detail)
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, listen)
    const rows = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="settings-elsewhere"] button')
    ]
    expect(rows.map((row) => row.textContent)).toEqual([
      'Account and PremiumSign in',
      'Buddy, chat posting and Clean cutBuddy',
      'Recording quality and filesOutput',
      'Destinations and stream detailsLivestream',
      'Checks and the support bundleHealth'
    ])
    for (const row of rows.slice(1)) await act(async () => row.click())
    window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, listen)
    expect(opened).toEqual([
      { tab: 'ai' },
      { tab: 'recording' },
      { tab: 'live' },
      { tab: 'diagnostics' }
    ])
  })
})
