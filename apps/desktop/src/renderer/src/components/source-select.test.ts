// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@/lib/backend'
import { SourceSelect } from './source-select'

let root: Root
let container: HTMLDivElement
const onChange = vi.fn()
const devices: Device[] = [
  { id: 'screen', name: 'Display', kind: 'screen', status: 'available' },
  { id: 'window-a', name: 'Café 東京', detail: 'Safari', kind: 'window', status: 'available' },
  { id: 'window-b', name: 'Café 東京', detail: 'Editor', kind: 'window', status: 'available' },
  { id: 'locked', name: 'Private', kind: 'window', status: 'permission-required' }
]
async function render(list = devices, value: string | undefined = 'screen'): Promise<void> {
  await act(async () =>
    root.render(
      createElement(SourceSelect, {
        label: 'Screen / window',
        devices: list,
        value,
        searchable: true,
        allowNone: true,
        onChange
      })
    )
  )
}
async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => (element as HTMLElement).click())
}
async function search(value: string): Promise<void> {
  const input = document.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(async () => {
  await import('./source-select-searchable')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onChange.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('searchable source selector', () => {
  it('selects the correct duplicate-name ID and keeps None available through filtering', async () => {
    await render()
    await click(container.querySelector('button'))
    const trigger = container.querySelector('button')!
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull()
    expect(document.activeElement).toBe(document.querySelector('input'))
    await search('editor 東京')
    expect(document.querySelector('[cmdk-item][data-value="window-a"]')).toBeNull()
    expect(document.querySelector('[cmdk-item][data-value="__none__"]')).not.toBeNull()
    expect(container.textContent).toContain('Display')
    await click(document.querySelector('[cmdk-item][data-value="window-b"]'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('window-b')
  })
  it('dismisses with Escape without changing selection, returns focus and clears the query', async () => {
    await render()
    const trigger = container.querySelector('button')!
    await click(trigger)
    await search('nothing matches')
    expect(document.body.textContent).toContain('No matching screens or windows')
    await act(async () =>
      document
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(onChange).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
    await click(trigger)
    expect(document.querySelector('input')!.value).toBe('')
  })
  it('disables unavailable entries and handles disappearance while searching', async () => {
    await render()
    await click(container.querySelector('button'))
    expect(document.querySelector('[data-value="locked"]')?.getAttribute('aria-disabled')).toBe(
      'true'
    )
    await search('café')
    await render([devices[0]], 'window-a')
    expect(container.textContent).toContain('Saved device unavailable')
    expect(document.body.textContent).toContain('No matching screens or windows')
    expect(onChange).not.toHaveBeenCalled()
    await click(document.querySelector('[data-value="__none__"]'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })
  it('uses the command keyboard navigation to select a filtered source', async () => {
    await render()
    await click(container.querySelector('button'))
    await search('editor')
    const input = document.querySelector('input')!
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(onChange).toHaveBeenCalledExactlyOnceWith('window-b')
  })
})
