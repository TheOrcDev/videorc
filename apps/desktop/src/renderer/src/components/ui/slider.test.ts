// @vitest-environment happy-dom
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Field, FieldLabel } from './field'
import { Slider } from './slider'

// Plan 174 S0.5 (E-3): the name sat on the slider's root, so every thumb (the
// element with role="slider", Base UI's range input inside the thumb) was
// read without one, and the player's scrubber announced raw milliseconds.

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
  vi.unstubAllGlobals()
})

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element))
}

/** Base UI's thumbs: a range input (role slider) inside each thumb. */
function thumbs(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="range"]')]
}

describe('Slider names its thumbs (plan 174 S0.5)', () => {
  it('puts aria-label and aria-valuetext on the thumb, not the root', async () => {
    await render(
      h(Slider, {
        'aria-label': 'Playhead',
        'aria-valuetext': '2:05 of 41:10',
        max: 2_470_000,
        value: 125_000
      })
    )
    const [thumb] = thumbs()
    expect(thumb?.getAttribute('aria-label')).toBe('Playhead')
    expect(thumb?.getAttribute('aria-valuetext')).toBe('2:05 of 41:10')
    const slider = container.querySelector('[data-slot="slider"]')!
    expect(slider.hasAttribute('aria-label')).toBe(false)
    expect(slider.hasAttribute('aria-valuetext')).toBe(false)
  })

  it('forwards aria-labelledby to the thumb', async () => {
    await render(h(Slider, { 'aria-labelledby': 'gain-label', value: 3 }))
    expect(thumbs()[0]?.getAttribute('aria-labelledby')).toBe('gain-label')
    expect(container.querySelector('[data-slot="slider"]')!.hasAttribute('aria-labelledby')).toBe(
      false
    )
  })

  it("takes its Field's label when it names nothing, and keeps its own when it does", async () => {
    await render(
      h(Field, null, h(FieldLabel, null, 'Motion'), h(Slider, { max: 1, step: 0.05, value: 0.45 }))
    )
    const label = container.querySelector<HTMLLabelElement>('[data-slot="field-label"]')!
    expect(thumbs()[0]?.getAttribute('aria-labelledby')).toBe(label.id)
    expect(document.getElementById(label.id)?.textContent).toBe('Motion')
    // A label element cannot point at a thumb, so it points at nothing.
    expect(label.hasAttribute('for')).toBe(false)

    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Answers'),
        h(Slider, { 'aria-label': 'Answers cooldown', value: 20 })
      )
    )
    expect(thumbs()[0]?.getAttribute('aria-label')).toBe('Answers cooldown')
    expect(thumbs()[0]?.hasAttribute('aria-labelledby')).toBe(false)
  })

  it('draws one thumb for a scalar and one per value for a range', async () => {
    await render(h(Slider, { 'aria-label': 'Gain', value: 40 }))
    expect(thumbs().map((thumb) => thumb.value)).toEqual(['40'])
    await render(h(Slider, { 'aria-label': 'Bitrate range', value: [2, 8] }))
    expect(thumbs().map((thumb) => thumb.value)).toEqual(['2', '8'])
  })
})
