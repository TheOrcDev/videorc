// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SoundPadBoard, type SoundPadBoardSound } from './sound-pad-board'

// Plan 189: the pad applies its mode and the board sends play or stop. Play
// once and While held start on the press; While held stops on the release;
// a playing Play/stop or Loop pad stops.

let root: Root
let container: HTMLDivElement

const sounds: SoundPadBoardSound[] = [
  { id: 'airhorn', name: 'Airhorn', mode: 'oneShot', hotkey: '1' },
  { id: 'applause', name: 'Applause', mode: 'toggle' },
  { id: 'drumroll', name: 'Drumroll', mode: 'hold' },
  { id: 'crickets', name: 'Crickets', mode: 'loop' }
]

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
  vi.unstubAllGlobals()
})

async function render(
  playing: string[],
  handlers: { onPlay: (id: string) => void; onStop: (id: string) => void }
): Promise<void> {
  const voices = new Map(
    playing.map((id) => [
      id,
      { startedAtMs: Date.now(), durationMs: 2000, loop: id === 'crickets' }
    ])
  )
  await act(async () =>
    root.render(
      createElement(SoundPadBoard, {
        columns: 4,
        disabledReason: null,
        sounds,
        voices,
        ...handlers
      })
    )
  )
}

const pad = (id: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-videorc-sound-pad="${id}"]`)!
const pointer = (target: Element, type: 'pointerdown' | 'pointerup'): void => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }))
}

describe('the sound pads (plan 189)', () => {
  it('sends play on a press and stop on a playing toggle, loop or a held release', async () => {
    const onPlay = vi.fn()
    const onStop = vi.fn()
    await render([], { onPlay, onStop })
    await act(async () => {
      pointer(pad('airhorn'), 'pointerdown')
      pointer(pad('airhorn'), 'pointerup')
      pointer(pad('drumroll'), 'pointerdown')
      pointer(pad('drumroll'), 'pointerup')
    })
    expect(onPlay.mock.calls).toEqual([['airhorn'], ['drumroll']])
    expect(onStop.mock.calls).toEqual([['drumroll']])

    onPlay.mockClear()
    onStop.mockClear()
    await render(['applause', 'crickets', 'airhorn'], { onPlay, onStop })
    await act(async () => {
      pointer(pad('applause'), 'pointerdown')
      pointer(pad('crickets'), 'pointerdown')
      // Play once restarts (D7): the backend fades the old voice out.
      pointer(pad('airhorn'), 'pointerdown')
    })
    expect(onStop.mock.calls).toEqual([['applause'], ['crickets']])
    expect(onPlay.mock.calls).toEqual([['airhorn']])
  })

  it('draws progress only for a sound with an end, and the key only where it works', async () => {
    await render(['airhorn', 'crickets'], { onPlay: vi.fn(), onStop: vi.fn() })
    expect(pad('airhorn').querySelector('[data-slot="sound-pad-progress"]')).not.toBeNull()
    expect(pad('crickets').querySelector('[data-slot="sound-pad-progress"]')).toBeNull()
    expect(pad('crickets').getAttribute('aria-label')).toBe('Stop Crickets')
    expect(pad('airhorn').getAttribute('aria-keyshortcuts')).toBe('1')
    expect(pad('applause').querySelector('kbd')).toBeNull()
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Sound pads')
  })
})
