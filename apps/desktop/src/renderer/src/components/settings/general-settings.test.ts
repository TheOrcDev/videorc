// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

import { GeneralSettings } from './general-settings'

// Plan 174 S3.17 (I-27): General ends with where every other setting lives.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/hooks/use-chat-emote-settings', () => ({
  useChatEmoteSettings: () => ({
    settings: { sevenTv: false, sevenTvStatus: { state: 'off' }, twitchGifs: 'animated' },
    error: null,
    setSevenTv: () => undefined,
    setTwitchGifs: () => undefined
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
  it('splits into Appearance, Stream Manager, Import and Elsewhere', async () => {
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(headings()).toEqual(['Appearance', 'Stream Manager', 'Import', 'Elsewhere'])
    expect(container.textContent).toContain('Open Stream Manager when you go live')
  })

  it('hides the Stream Manager section when that window is off', async () => {
    mocked.core = {
      ...mocked.core,
      runtimeInfo: { platform: 'darwin', commentsWindowEnabled: false }
    }
    await act(async () => root.render(createElement(GeneralSettings)))
    expect(headings()).toEqual(['Appearance', 'Import', 'Elsewhere'])
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
