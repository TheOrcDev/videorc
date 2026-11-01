// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import {
  getPrivacySettings,
  PRIVACY_SETTINGS_STORAGE_KEY,
  resetPrivacySettingsForTest
} from '@/lib/privacy-settings'
import { HideScreenSection } from './hide-screen-section'

// Plan 210 S8b (D9, D11, D12): the Scene page's Hide screen section. What
// viewers see, the key and its home, and on macOS the password-manager hide
// with its list; Windows and Linux keep the key only.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  apps: [] as { bundleId: string; name: string; windowCount: number }[]
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/hooks/use-app-icons', () => ({ useAppIcons: () => new Map() }))
vi.mock('@/hooks/use-app-choices', () => ({
  useAppChoices: (open: boolean) => ({
    apps: open ? mocked.apps : [],
    loading: false,
    pictures: false,
    grantMissing: false,
    refresh: () => {}
  })
}))
const openWorkspaceTab = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-navigation', () => ({ openWorkspaceTab }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  resetPrivacySettingsForTest()
  openWorkspaceTab.mockReset()
  mocked.apps = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  resetPrivacySettingsForTest()
  vi.unstubAllGlobals()
})

async function render(platform: string, screenHideToggle?: string): Promise<void> {
  mocked.core = {
    runtimeInfo: { platform },
    settings: { globalShortcuts: screenHideToggle === undefined ? {} : { screenHideToggle } }
  }
  await act(async () =>
    root.render(
      createElement(TooltipProvider, {
        delay: 0,
        children: createElement(HideScreenSection)
      })
    )
  )
}

const section = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-videorc-hide-screen]')!
const rows = (): string[] =>
  [...container.querySelectorAll('[data-password-manager] [data-slot="list-row-title"]')].map(
    (title) => title.textContent ?? ''
  )
const managerSwitch = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-videorc-password-manager-hide]')!

async function openRowMenu(name: string): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${name}"]`)!
  await act(async () => {
    trigger.click()
  })
  return document.querySelector<HTMLElement>('[role=menu]')!
}

describe('Scene page: Hide screen (plan 210 S8b)', () => {
  it('says what viewers see and links its key to Settings → Shortcuts', async () => {
    await render('darwin')
    expect(section().querySelector('h2')?.textContent).toBe('Hide screen')
    expect(section().textContent).toContain(
      'Your screen turns into a frosted picture on the recording and every stream, so nothing on it can be read. Your camera and voice stay on.'
    )
    const key = section().querySelector<HTMLButtonElement>('[data-slot="navigable-row"]')!
    expect(key.textContent).toContain('Shortcut')
    expect(key.querySelector('kbd')?.dataset.accelerator).toBe('Control+Alt+H')
    await act(async () => key.click())
    expect(openWorkspaceTab).toHaveBeenCalledWith('settings', 'shortcuts')
  })

  it('says Not set once the key is cleared', async () => {
    await render('darwin', '')
    const key = section().querySelector<HTMLElement>('[data-slot="navigable-row"]')!
    expect(key.querySelector('kbd')).toBeNull()
    expect(key.textContent).toContain('Not set')
  })

  it('lists the password managers by name, on by default, on macOS', async () => {
    await render('darwin')
    expect(section().textContent).toContain('Hide when a password manager is in front')
    expect(managerSwitch().getAttribute('aria-checked')).toBe('true')
    expect(rows()).toEqual([
      '1Password',
      'Bitwarden',
      'Dashlane',
      'Keeper',
      'LastPass',
      'Passwords',
      'Keychain Access',
      'Proton Pass',
      'KeePassXC',
      'Enpass'
    ])
    await act(async () => managerSwitch().click())
    expect(getPrivacySettings().hideForPasswordManagers).toBe(false)
    expect(JSON.parse(localStorage.getItem(PRIVACY_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      hideForPasswordManagers: false
    })
  })

  it('takes a built-in app off and restores the built-in list', async () => {
    await render('darwin')
    expect(container.textContent).not.toContain('Restore built-in apps')
    const menu = await openRowMenu('Dashlane')
    const remove = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')].find(
      (item) => item.textContent === 'Remove'
    )!
    await act(async () => remove.click())
    expect(rows()).not.toContain('Dashlane')
    expect(getPrivacySettings().removedPasswordManagerBundleIds).toContain('com.dashlane.Dashlane')
    const restore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore built-in apps'
    )!
    await act(async () => restore.click())
    expect(rows()).toContain('Dashlane')
  })

  it('adds an open app through Add app…, leaving out apps already listed', async () => {
    mocked.apps = [
      { bundleId: 'com.example.Vault', name: 'Vault', windowCount: 1 },
      { bundleId: 'com.bitwarden.desktop', name: 'Bitwarden', windowCount: 1 }
    ]
    await render('darwin')
    const add = container.querySelector<HTMLButtonElement>('[data-testid="password-manager-add"]')!
    expect(add.textContent).toBe('Add app…')
    await act(async () => add.click())
    const picker = document.querySelector<HTMLElement>('[data-testid="password-manager-picker"]')!
    const options = [...picker.querySelectorAll<HTMLElement>('[cmdk-item]')]
    expect(options.map((option) => option.textContent)).toEqual(['Vault'])
    await act(async () => options[0].click())
    expect(rows().at(-1)).toBe('Vault')
    expect(getPrivacySettings().addedPasswordManagers).toEqual([
      { bundleId: 'com.example.Vault', name: 'Vault' }
    ])
  })

  it('keeps the key and leaves the password managers out on Windows and Linux', async () => {
    for (const platform of ['win32', 'linux']) {
      await render(platform)
      expect(section().querySelector('kbd')?.dataset.accelerator).toBe('Control+Alt+H')
      expect(section().textContent).not.toContain('password manager')
      expect(container.querySelector('[data-videorc-password-managers]')).toBeNull()
      expect(container.querySelector('[role="switch"]')).toBeNull()
    }
  })
})
