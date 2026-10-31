// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useThemeToggle } from './use-theme-toggle'

// Plan 174 A-2 and I-30: D flips the look, with or without Shift (as it
// always has), but never under Cmd, Ctrl or Alt, from a field, or under a
// dialog or a menu.

const theme = vi.hoisted(() => ({ setTheme: vi.fn() }))
vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: theme.setTheme, resolvedTheme: 'dark', systemTheme: 'dark' })
}))

let root: Root
let container: HTMLDivElement

function Probe(): null {
  useThemeToggle()
  return null
}

function press(init: KeyboardEventInit, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  theme.setTheme.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Probe)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useThemeToggle', () => {
  it('flips the look on D and on Shift+D', () => {
    press({ key: 'd' })
    press({ key: 'D', shiftKey: true })
    expect(theme.setTheme).toHaveBeenCalledTimes(2)
    expect(theme.setTheme).toHaveBeenCalledWith('light')
  })

  it('leaves D alone under Cmd, Ctrl or Alt, on a repeat, and in a field', () => {
    press({ key: 'd', metaKey: true })
    press({ key: 'd', ctrlKey: true })
    press({ key: 'd', altKey: true })
    press({ key: 'd', repeat: true })
    const input = document.createElement('input')
    container.append(input)
    press({ key: 'd' }, input)
    expect(theme.setTheme).not.toHaveBeenCalled()
  })
})
