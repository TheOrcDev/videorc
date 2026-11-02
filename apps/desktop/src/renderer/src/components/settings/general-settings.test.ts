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

/** The id is on Base UI's hidden input; the label for it names the switch. */
function switchById(id: string): HTMLElement | null {
  const label = container.querySelector(`label[for="${id}"]`)
  return container.querySelector<HTMLElement>(`[role="switch"][aria-labelledby="${label?.id}"]`)
}

describe('GeneralSettings', () => {
  it('splits into Appearance, Chat, Setup, Import, Privacy and Elsewhere', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(headings()).toEqual(['Appearance', 'Chat', 'Setup', 'Import', 'Privacy', 'Elsewhere'])
    expect(container.textContent).toContain('Open Stream Manager when you go live')
  })

  it('offers Retro LCD under Appearance, off until turned on (plan 197)', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    const toggle = switchById('retro-lcd-studio')
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

  // Plan 204 (D3, D4): Chat in Studio is the Chat section's first row, off
  // until turned on, and it stays when the Stream Manager window is off.
  it('offers Chat in Studio first under Chat, off until turned on (plan 204)', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    const toggle = switchById('studio-chat')
    expect(toggle?.getAttribute('role')).toBe('switch')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    const chat = [...container.querySelectorAll('h2')]
      .find((heading) => heading.textContent === 'Chat')
      ?.closest('[data-slot="panel-section"]')
    expect(chat?.textContent).toContain('Chat in Studio')
    expect(chat?.querySelector('[role="switch"]')).toBe(toggle)
    await act(async () => (toggle as HTMLElement).click())
    const setSettings = mocked.core.setSettings as ReturnType<typeof vi.fn>
    const update = setSettings.mock.calls.at(-1)?.[0] as (current: object) => object
    expect(update({ keepOriginalRecording: false })).toEqual({
      keepOriginalRecording: false,
      studioChat: true
    })
  })

  it('shows the switch on when the setting is on', async () => {
    mocked.core = { ...mocked.core, settings: { studioChat: true } }
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(switchById('studio-chat')?.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps Chat in Studio and drops only the Stream Manager row when that window is off', async () => {
    mocked.core = {
      ...mocked.core,
      runtimeInfo: { platform: 'darwin', commentsWindowEnabled: false }
    }
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(headings()).toEqual(['Appearance', 'Chat', 'Setup', 'Import', 'Privacy', 'Elsewhere'])
    expect(container.querySelector('#studio-chat')).not.toBeNull()
    expect(container.textContent).not.toContain('Open Stream Manager when you go live')
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

  it('does not promise a permissions step on Linux, where setup has none', async () => {
    mocked.core = {
      ...mocked.core,
      runtimeInfo: { platform: 'linux', commentsWindowEnabled: true }
    }
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(container.textContent).toContain('Go through the welcome steps again.')
    expect(container.textContent).not.toContain('starting with permissions')
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
