// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'
import type { VideorcAccount } from '@/lib/account'

// PERF-03: the account menu starts closed, so its implementation (Base UI menu
// + the product dropdown) is a lazy chunk. These tests pin the behaviour that
// must not change (open by pointer or keyboard, Escape, navigation, sign-in
// state, sign-out lock) and the part that must: nothing loads until intent.

const account = vi.hoisted(() => ({
  value: { status: 'signed-out' } as VideorcAccount,
  signIn: vi.fn(),
  openAccount: vi.fn(),
  signOut: vi.fn()
}))

vi.mock('@/hooks/use-account', () => ({
  useVideorcAccount: () => ({
    account: account.value,
    signIn: account.signIn,
    openAccount: account.openAccount,
    signOut: account.signOut
  })
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }))

// Counts how often the lazy chunk's module body evaluates (registered per test).
const bodyEvaluations = vi.hoisted(() => ({ count: 0 }))

type AccountMenuModule = typeof import('./account-menu')

describe('AccountMenu', () => {
  let root: Root
  let container: HTMLDivElement
  let mod: AccountMenuModule
  let onOpenHealth: ReturnType<typeof vi.fn>
  let onOpenSettings: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    account.value = { status: 'signed-out' }
    account.signIn.mockClear()
    account.openAccount.mockClear()
    account.signOut.mockClear()
    toastError.mockClear()
    bodyEvaluations.count = 0
    onOpenHealth = vi.fn()
    onOpenSettings = vi.fn()
    // A fresh module per test: the chunk cache is module state.
    vi.resetModules()
    vi.doMock('./account-menu-body', async () => {
      bodyEvaluations.count += 1
      return vi.importActual('./account-menu-body')
    })
    mod = await import('./account-menu')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  async function mount(props: { live?: boolean; needsSignIn?: boolean } = {}): Promise<void> {
    await act(async () =>
      root.render(
        createElement(mod.AccountMenu, {
          tier: 'basic',
          statusTone: 'good',
          statusLabel: 'Ready',
          statusPulse: false,
          live: false,
          onOpenHealth,
          onOpenSettings,
          ...props
        })
      )
    )
  }

  const trigger = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('button[data-slot="dropdown-menu-trigger"]')
  const menu = (): Element | null => document.querySelector('[role=menu]')
  const itemNames = (): string[] =>
    [...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent?.trim() ?? '')

  // The lazy import (cold, it transforms Base UI) and the menu's open
  // transition finish on their own clock: wait for them instead of a sleep.
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  }

  async function click(element: Element | null): Promise<void> {
    await act(async () => {
      ;(element as HTMLElement).click()
    })
    await settle()
  }

  it('renders a closed trigger without loading the menu implementation', async () => {
    await mount()
    expect(bodyEvaluations.count).toBe(0)
    expect(menu()).toBeNull()
    expect(trigger()?.textContent).toContain('Sign in')
    expect(trigger()?.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger()?.getAttribute('aria-busy')).toBeNull()
  })

  it('warms the chunk on pointer or focus intent without opening the menu', async () => {
    await mount()
    await act(async () => {
      trigger()?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      trigger()?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await settle()
    expect(bodyEvaluations.count).toBe(1)
    expect(menu()).toBeNull()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('swaps the real trigger in on a mouse hover, closed, and keeps its press as its own', async () => {
    await mount()
    const before = trigger()
    await act(async () => {
      before?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      )
    })
    await vi.waitFor(() => expect(trigger()).not.toBe(before), { timeout: 5000 })
    expect(menu()).toBeNull()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger()?.textContent).toBe(before?.textContent)
    expect(trigger()?.className).toBe(before?.className)
    // The Base UI trigger opens on the press, as it did before the split.
    await act(async () => {
      trigger()?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      )
    })
    await settle()
    expect(menu()).not.toBeNull()
  })

  it('does not swap the button under a press in flight, and the click still opens', async () => {
    await mount()
    const before = trigger()
    await act(async () => {
      before?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      )
      before?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })
      )
    })
    // The chunk finishes loading while the button is still held down.
    await settle()
    await settle()
    expect(bodyEvaluations.count).toBe(1)
    expect(trigger()).toBe(before)
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }))
      before?.click()
    })
    await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5000 })
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true')
  })

  it('does not swap on a touch or pen hover', async () => {
    await mount()
    const before = trigger()
    await act(async () => {
      before?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' })
      )
    })
    await settle()
    expect(bodyEvaluations.count).toBe(1)
    expect(trigger()).toBe(before)
  })

  it('keeps keyboard focus on the trigger when the hover swap replaces it', async () => {
    await mount()
    const before = trigger()
    await act(async () => before?.focus())
    expect(document.activeElement).toBe(before)
    await act(async () => {
      before?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      )
    })
    await vi.waitFor(() => expect(trigger()).not.toBe(before), { timeout: 5000 })
    expect(document.activeElement).toBe(trigger())
  })

  it('opens on the first click, cold, and shows the signed-out menu', async () => {
    await mount()
    await click(trigger())
    await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5000 })
    expect(bodyEvaluations.count).toBe(1)
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true')
    expect(itemNames()).toEqual(['Sign in', 'View Premium', 'HealthReady', 'Settings'])
    expect(menu()?.textContent).toContain('Not signed in')
    expect(menu()?.textContent).toContain('Basic')
  })

  it('opens on ArrowDown from the keyboard', async () => {
    await mount()
    await act(async () => {
      trigger()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5000 })
  })

  const activeRow = (): string =>
    document.activeElement?.getAttribute('role') === 'menuitem'
      ? (document.activeElement.textContent?.trim() ?? '')
      : ''

  it('puts focus on the first row after a keyboard open, as the Base UI trigger does', async () => {
    await mount()
    await act(async () => {
      trigger()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    await vi.waitFor(() => expect(activeRow()).toBe('Sign in'), { timeout: 5000 })
  })

  it('puts focus on the last row after ArrowUp', async () => {
    await mount()
    await act(async () => {
      trigger()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      )
    })
    await vi.waitFor(() => expect(activeRow()).toBe('Settings'), { timeout: 5000 })
  })

  it('puts focus on the first row after Enter or Space (a click with no pointer)', async () => {
    await mount()
    await click(trigger())
    await vi.waitFor(() => expect(activeRow()).toBe('Sign in'), { timeout: 5000 })
  })

  it('leaves focus on the popup after a pointer click', async () => {
    await mount()
    await act(async () => {
      trigger()?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
      )
    })
    await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5000 })
    await settle()
    expect(document.activeElement?.getAttribute('role')).not.toBe('menuitem')
  })

  it('shows the account rows and a sign-out the live session locks', async () => {
    account.value = { status: 'signed-in', username: 'orc', displayName: 'Orc Dev' }
    await mount({ live: true })
    await click(trigger())
    expect(trigger()?.textContent).toContain('Orc Dev')
    expect(itemNames()).toEqual(['Account', 'View Premium', 'HealthReady', 'Settings', 'Sign out'])
    const signOut = [...document.querySelectorAll('[role=menuitem]')].find((item) =>
      item.textContent?.includes('Sign out')
    )
    expect(signOut?.getAttribute('aria-disabled')).toBe('true')
    expect(menu()?.textContent).toContain("Sign out is locked while you're recording or live.")
  })

  it('leaves sign-out enabled when nothing is live', async () => {
    account.value = { status: 'signed-in', username: 'orc' }
    await mount({ live: false })
    await click(trigger())
    const signOut = [...document.querySelectorAll('[role=menuitem]')].find((item) =>
      item.textContent?.includes('Sign out')
    ) as HTMLElement
    expect(signOut.getAttribute('aria-disabled')).not.toBe('true')
    expect(menu()?.textContent).not.toContain('locked')
    await click(signOut)
    expect(account.signOut).toHaveBeenCalledTimes(1)
  })

  it('runs the row actions and closes the menu', async () => {
    await mount()
    await click(trigger())
    await click(
      [...document.querySelectorAll('[role=menuitem]')].find((item) =>
        item.textContent?.includes('Settings')
      ) ?? null
    )
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('signs in from the signed-out row', async () => {
    await mount()
    await click(trigger())
    await click(
      [...document.querySelectorAll('[role=menuitem]')].find((item) =>
        item.textContent?.includes('Sign in')
      ) ?? null
    )
    expect(account.signIn).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape wherever focus sits', async () => {
    await mount()
    await click(trigger())
    expect(menu()).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    expect(menu()).toBeNull()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when the workspace navigates (FX5)', async () => {
    await mount()
    await click(trigger())
    expect(menu()).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new Event(WORKSPACE_NAVIGATE_EVENT))
    })
    await settle()
    expect(menu()).toBeNull()
  })

  it('reopens from the real trigger after the first open', async () => {
    await mount()
    await click(trigger())
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    expect(menu()).toBeNull()
    await click(trigger())
    expect(menu()).not.toBeNull()
  })

  it('keeps the needs-sign-in dot on the trigger', async () => {
    await mount({ needsSignIn: true })
    expect(trigger()?.querySelector('[data-slot="account-needs-sign-in"]')).not.toBeNull()
    await click(trigger())
    expect(trigger()?.querySelector('[data-slot="account-needs-sign-in"]')).not.toBeNull()
  })

  it('tells the user when the chunk fails to load, and a retry loads it again', async () => {
    vi.resetModules()
    vi.doMock('./account-menu-body', () => {
      throw new Error('chunk load failed')
    })
    const failing = await import('./account-menu')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () =>
      root.render(
        createElement(failing.AccountMenu, {
          tier: 'basic',
          statusTone: 'good',
          statusLabel: 'Ready',
          statusPulse: false,
          live: false,
          onOpenHealth,
          onOpenSettings
        })
      )
    )
    await click(trigger())
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
    expect(trigger()?.getAttribute('aria-busy')).toBeNull()
    consoleError.mockRestore()
    vi.doUnmock('./account-menu-body')
  })
})

// The point of the split is what the eager entry does NOT pull in. This guards
// the import edges the asset budget would only catch as bytes later.
describe('AccountMenu eager closure (PERF-03)', () => {
  const source = (name: string): string => readFileSync(join(__dirname, name), 'utf8')
  const staticImports = (text: string): string[] =>
    [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1])

  it('keeps the menu package and the dropdown wrapper out of the eager files', () => {
    for (const name of ['account-menu.tsx', 'account-menu-trigger.tsx']) {
      const imports = staticImports(source(name))
      expect(
        imports.filter((path) => /dropdown-menu|account-menu-body|base-ui/.test(path))
      ).toEqual([])
    }
  })

  it('reaches the lazy body only through one dynamic import', () => {
    const text = source('account-menu.tsx')
    expect(text.match(/import\('\.\/account-menu-body'\)/g)).toHaveLength(1)
    expect(text).not.toMatch(/\blazy\(\s*\(\)\s*=>/)
  })

  it('keeps the Base UI menu in the lazy body', () => {
    expect(staticImports(source('account-menu-body.tsx'))).toContain(
      '@/components/ui/dropdown-menu'
    )
  })
})
