// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 199 D4, D9: the Clip action has two buttons, today's 30 seconds and
// the minute, each with its own hint, key and spoken phrase.

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
  vi.unstubAllGlobals()
})

const button = (label: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)

describe('StreamManagerStatusBar Clip buttons', () => {
  it('saves 30 seconds or the minute, and says which key and phrase does the same', async () => {
    const onMarkClip = vi.fn()
    await act(async () =>
      root.render(
        createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          onMarkClip,
          clip: {
            available: true,
            seconds: 30,
            longSeconds: 60,
            shortcutLabel: '⌥⌘C',
            longShortcutLabel: '⌥⌘M'
          }
        })
      )
    )
    const short = button('Save a 30-second clip')!
    const long = button('Save a 1-minute clip')!
    expect(short.textContent).toBe('Clip 30 s')
    expect(long.textContent).toBe('1 min')
    expect(short.getAttribute('aria-description')).toBe(
      'Save the last 30 seconds as a clip (⌥⌘C), or say “clip that”'
    )
    expect(long.getAttribute('aria-description')).toBe(
      'Save the last minute as a clip (⌥⌘M), or say “clip the last minute”'
    )
    await act(async () => short.click())
    await act(async () => long.click())
    expect(onMarkClip.mock.calls).toEqual([[30], [60]])
  })

  it('shows neither button when there is nothing to clip', async () => {
    await act(async () =>
      root.render(
        createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false
        })
      )
    )
    expect(button('Save a 30-second clip')).toBeNull()
    expect(button('Save a 1-minute clip')).toBeNull()
  })
})
