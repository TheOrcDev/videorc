// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeBuddyPetCreator,
  openBuddyPetCreator,
  useBuddyPetCreatorOpen,
  useBuddyPetCreatorOptions
} from './buddy-pet-creator-nav'

afterEach(() => {
  closeBuddyPetCreator()
  vi.unstubAllGlobals()
})

function Probe({ seen }: { seen: unknown[] }) {
  seen.push({ open: useBuddyPetCreatorOpen(), options: useBuddyPetCreatorOptions() })
  return null
}

describe('openBuddyPetCreator (plan 169 D11)', () => {
  it('opens with the reference and trimmed notes, and forgets them on close', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const seen: unknown[] = []
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(createElement(Probe, { seen })))
    await act(async () =>
      openBuddyPetCreator({ reference: 'persona-idle', notes: '  A mossy buddy  ' })
    )
    expect(seen.at(-1)).toEqual({
      open: true,
      options: { reference: 'persona-idle', notes: 'A mossy buddy' }
    })
    await act(async () => closeBuddyPetCreator())
    expect(seen.at(-1)).toEqual({ open: false, options: {} })
    await act(async () => root.unmount())
  })

  it('opens plainly when used as a click handler', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const click = new MouseEvent('click')
    openBuddyPetCreator({ nativeEvent: click })
    // Nothing of the event survives as options.
    const seen: unknown[] = []
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(createElement(Probe, { seen })))
    expect(seen.at(-1)).toEqual({ open: true, options: {} })
    act(() => root.unmount())
  })
})
