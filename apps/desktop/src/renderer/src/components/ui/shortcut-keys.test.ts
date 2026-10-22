// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Button } from './button'
import { KBD_ON_FILLED_BUTTON } from './kbd'
import { ShortcutKeys } from './shortcut-keys'
import { ShortcutTooltip } from './shortcut-tooltip'

// Plan 174 S1.2 (A-5, I-18, V-X1): one renderer for every shortcut.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.platform
  vi.unstubAllGlobals()
})

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root.render(element))
}

const kbd = (): HTMLElement | null => container.querySelector('kbd')

describe('ShortcutKeys', () => {
  it('is one macOS keycap in system order', async () => {
    await render(
      createElement(ShortcutKeys, { accelerator: 'CmdOrCtrl+Shift+J', platform: 'darwin' })
    )
    expect(container.querySelectorAll('kbd')).toHaveLength(1)
    expect(kbd()?.textContent).toBe('⇧⌘J')
    expect(kbd()?.dataset.slot).toBe('kbd')
    expect(kbd()?.dataset.accelerator).toBe('CmdOrCtrl+Shift+J')
  })

  it('is words joined by + on Windows and Linux', async () => {
    await render(
      createElement(ShortcutKeys, { accelerator: 'CmdOrCtrl+Shift+J', platform: 'win32' })
    )
    expect(kbd()?.textContent).toBe('Ctrl+Shift+J')
    await render(createElement(ShortcutKeys, { accelerator: 'Space', platform: 'linux' }))
    expect(kbd()?.textContent).toBe('Space')
  })

  it('reads the platform the bootstrap set before the first paint', async () => {
    document.documentElement.dataset.platform = 'darwin'
    await render(createElement(ShortcutKeys, { accelerator: 'CmdOrCtrl+P' }))
    expect(kbd()?.textContent).toBe('⌘P')
    document.documentElement.dataset.platform = 'win32'
    await render(createElement(ShortcutKeys, { accelerator: 'CmdOrCtrl+P' }))
    expect(kbd()?.textContent).toBe('Ctrl+P')
  })

  it('prints the status bar hint as quiet text, no keycap', async () => {
    await render(
      createElement(ShortcutKeys, {
        accelerator: 'CmdOrCtrl+K',
        platform: 'darwin',
        variant: 'text'
      })
    )
    expect(kbd()).toBeNull()
    expect(container.querySelector('[data-slot="shortcut-keys"]')?.textContent).toBe('⌘K')
  })

  it('renders nothing for an unbound shortcut', async () => {
    await render(createElement(ShortcutKeys, { accelerator: '', platform: 'darwin' }))
    expect(container.innerHTML).toBe('')
  })

  it('takes the filled button style inside primary and destructive buttons (J1-16)', async () => {
    await render(
      createElement(
        Button,
        null,
        'Save',
        createElement(ShortcutKeys, { accelerator: 'Enter', platform: 'darwin' })
      )
    )
    expect(kbd()?.textContent).toBe('↵')
    for (const token of KBD_ON_FILLED_BUTTON.split(' ')) {
      expect(kbd()?.className).toContain(token)
    }
    expect(KBD_ON_FILLED_BUTTON).toContain(
      '[[data-slot=button][data-variant=default]_&]:text-current'
    )
    expect(KBD_ON_FILLED_BUTTON).toContain(
      '[[data-slot=button][data-variant=destructive]_&]:text-current'
    )
  })
})

describe('ShortcutTooltip', () => {
  it('shows the label and the bound shortcut as one keycap', async () => {
    await render(
      createElement(ShortcutTooltip, {
        label: 'Mute microphone',
        accelerator: 'Cmd+Shift+M',
        platform: 'darwin',
        children: createElement('button', { type: 'button' }, 'Mute')
      })
    )
    await act(async () => container.querySelector('button')?.focus())
    const content = document.querySelector('[data-slot="tooltip-content"]')
    expect(content?.textContent).toContain('Mute microphone')
    expect(content?.querySelector('kbd')?.textContent).toBe('⇧⌘M')
  })
})
