// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SoundboardSummary } from '../../../../shared/sound-commands'
import { StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 189 S9: the Sounds action opens the same pads as Studio, four to a
// row, with Stop all; below 640 px it folds into the ⋯ menu as Sounds….

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
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

const board: SoundboardSummary = {
  sounds: [
    { id: 'airhorn', name: 'Airhorn', mode: 'oneShot' },
    { id: 'applause', name: 'Applause', mode: 'toggle' }
  ],
  voices: [{ soundId: 'applause', startedAtMs: Date.now(), durationMs: 5000, loop: false }]
}

async function render(
  sounds: SoundboardSummary | null,
  onSound: ((action: unknown) => void) | null = vi.fn()
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(StreamManagerStatusBar, {
        providers: [],
        audience: null,
        alwaysOnTop: false,
        sounds,
        onSound: onSound ?? undefined
      })
    )
  )
}

async function openSounds(): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Sounds"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.click())
  // The pads load in their own chunk.
  await vi.waitFor(() =>
    expect(document.querySelector('[data-videorc-sounds-popover]')).not.toBeNull()
  )
  return document.querySelector<HTMLElement>('[data-videorc-sounds-popover]')!
}

describe('StreamManagerStatusBar Sounds (plan 189 S9)', () => {
  it('plays a pad, stops a playing one and stops them all', async () => {
    const onSound = vi.fn()
    await render(board, onSound)
    const popover = await openSounds()
    const pad = (id: string) =>
      popover.querySelector<HTMLButtonElement>(`[data-videorc-sound-pad="${id}"]`)!
    expect(pad('applause').hasAttribute('data-playing')).toBe(true)
    // No key chips here: the keys belong to Studio.
    expect(popover.querySelector('kbd')).toBeNull()
    await act(async () => {
      pad('airhorn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      pad('applause').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(onSound.mock.calls).toEqual([
      [{ action: 'play', id: 'airhorn' }],
      [{ action: 'stop', id: 'applause' }]
    ])
    const stopAll = [...popover.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop all'
    )!
    await act(async () => stopAll.click())
    expect(onSound).toHaveBeenLastCalledWith({ action: 'stopAll' })
  })

  it('says the board is loading or empty', async () => {
    await render(null)
    expect((await openSounds()).textContent).toContain('Loading sounds…')
    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ sounds: [], voices: [] })
    const empty = await openSounds()
    expect(empty.textContent).toContain('No sounds yet. Add sounds in Assets.')
    const stopAll = [...empty.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop all'
    )!
    expect(stopAll.disabled).toBe(true)
  })

  it('folds into the narrow ⋯ menu as Sounds…, and leaves both out without a relay', async () => {
    await render(board)
    const more = container.querySelector<HTMLButtonElement>(
      '[aria-label="More Stream Manager actions"]'
    )!
    await act(async () => {
      more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const menu = document.querySelector<HTMLElement>('[role=menu]')!
    const item = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')].find(
      (row) => row.textContent === 'Sounds…'
    )!
    expect(item).toBeDefined()
    // It opens once the menu has let the focus go, and keeps the focus.
    await act(async () => item.click())
    await vi.waitFor(() =>
      expect(document.querySelector('[data-videorc-sounds-popover]')).not.toBeNull()
    )
    expect(
      document
        .querySelector('[data-testid="stream-manager-sounds"]')
        ?.contains(document.activeElement)
    ).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(board, null)
    expect(container.querySelector('[aria-label="Sounds"]')).toBeNull()
  })
})
