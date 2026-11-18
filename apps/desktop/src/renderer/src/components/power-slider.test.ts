// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PowerSlider } from '@/components/power-slider'
import { TooltipProvider } from '@/components/ui/tooltip'

let root: Root
let container: HTMLDivElement
let value: number
let setDisabled: (disabled: boolean) => void = () => undefined
const changed = vi.fn()
const committed = vi.fn()

function Fixture({ disabled: initiallyDisabled }: { disabled: boolean }): React.ReactElement {
  const [current, setCurrent] = useState(20)
  const [disabled, setLocked] = useState(initiallyDisabled)
  value = current
  setDisabled = setLocked
  return createElement(
    TooltipProvider,
    null,
    createElement(PowerSlider, {
      label: 'Brightness',
      value: current,
      min: 0,
      max: 100,
      numericInput: true,
      defaultValue: 0,
      disabled,
      disabledReason: disabled ? 'Locked while recording.' : undefined,
      onChange: (next: number) => {
        changed(next)
        setCurrent(next)
      },
      onCommit: committed
    })
  )
}

async function mount(disabled = false): Promise<void> {
  await act(async () => root.render(createElement(Fixture, { disabled })))
}

function input(): HTMLInputElement {
  return container.querySelector('input[aria-label="Brightness value"]') as HTMLInputElement
}

async function type(text: string): Promise<void> {
  await act(async () => input().focus())
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string): Promise<void> {
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
}

async function doubleClickTrack(): Promise<void> {
  const track = container.querySelector('[data-slot="slider-track"]')!
  await act(async () => track.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  changed.mockClear()
  committed.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('PowerSlider typed number', () => {
  it('commits a typed number on Enter', async () => {
    await mount()
    await type('60')
    await press('Enter')
    expect(value).toBe(60)
    expect(committed.mock.calls).toEqual([[60]])
  })

  it('cancels a typed number on Escape (QA F23)', async () => {
    await mount()
    await type('60')
    await press('Escape')
    expect(value).toBe(20)
    expect(input().value).toBe('20')
    expect(changed).not.toHaveBeenCalled()
    expect(committed).not.toHaveBeenCalled()

    // The next edit commits on blur as before.
    await type('35')
    await act(async () => input().blur())
    expect(value).toBe(35)
    expect(committed.mock.calls).toEqual([[35]])
  })
})

describe('PowerSlider disabled (QA F24)', () => {
  it('resets to the default on a double-click while enabled', async () => {
    await mount()
    await doubleClickTrack()
    expect(value).toBe(0)
    expect(committed.mock.calls).toEqual([[0]])
  })

  it('ignores a double-click while disabled', async () => {
    await mount(true)
    expect(container.textContent).toContain('Locked while recording.')
    await doubleClickTrack()
    expect(value).toBe(20)
    expect(changed).not.toHaveBeenCalled()
    expect(committed).not.toHaveBeenCalled()
  })

  it('drops a typed number when the slider locks before it is committed', async () => {
    await mount()
    await type('60')
    await act(async () => setDisabled(true))
    await act(async () => input().blur())
    expect(value).toBe(20)
    expect(committed).not.toHaveBeenCalled()
  })
})
