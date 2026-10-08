// @vitest-environment happy-dom
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './chat-pane'
import type { SessionMarker, LiveChatProviderState } from '@/lib/backend'

let root: Root
let container: HTMLElement
let dom: Window
beforeEach(() => {
  dom = new Window()
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'Event',
    'MouseEvent',
    'KeyboardEvent'
  ] as const)
    vi.stubGlobal(
      key,
      key === 'window'
        ? dom
        : key === 'getComputedStyle'
          ? dom.getComputedStyle.bind(dom)
          : dom[key]
    )
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  await dom.happyDOM.close()
})
const marker: SessionMarker = {
  id: 'm1',
  sessionId: 's1',
  atSeconds: 12.3,
  label: 'Shadcn New Library',
  source: 'manual',
  createdAt: '2026-10-05T12:00:00Z',
  revision: 1
}
const onSend = vi.fn()
async function mount(
  onMarker = vi.fn(async () => marker),
  available = true,
  providers: LiveChatProviderState[] = [],
  pending = false
): Promise<typeof onMarker> {
  onSend.mockClear()
  await act(async () =>
    root.render(
      createElement(Composer, {
        providers,
        pending,
        failures: [],
        operation: null,
        prefill: null,
        cohostNudge: false,
        markerContext: { sessionId: 's1', available },
        onSend,
        onMarker
      })
    )
  )
  return onMarker
}
async function type(text: string): Promise<void> {
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function enter(composing = false): Promise<void> {
  await act(async () =>
    container
      .querySelector('input')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: composing })
      )
  )
}
describe('real marker composer', () => {
  it('creates with zero providers and keeps local help/errors off provider send', async () => {
    const create = await mount()
    expect(container.querySelector('input')!.disabled).toBe(false)
    await type('/marker Shadcn New Library')
    await enter()
    expect(create).toHaveBeenCalledExactlyOnceWith('Shadcn New Library')
    expect(container.textContent).toContain('00:00:12')
    expect(container.querySelector('input')!.value).toBe('')
    await type('/unknown')
    await enter()
    expect(container.textContent).toContain('Unknown command')
    await type('/help')
    await enter()
    expect(container.textContent).toContain('Library')
    expect(onSend).not.toHaveBeenCalled()
  })
  it('never submits an IME composition and preserves new typing during pending save', async () => {
    let resolve!: (value: SessionMarker) => void
    const create = vi.fn(
      () =>
        new Promise<SessionMarker>((done) => {
          resolve = done
        })
    )
    await mount(create)
    await type('/marker Alpha')
    await enter(true)
    expect(create).not.toHaveBeenCalled()
    await enter()
    expect(create).toHaveBeenCalledTimes(1)
    await type('/marker Next')
    await enter()
    expect(create).toHaveBeenCalledTimes(1)
    await act(async () => resolve(marker))
    expect(container.querySelector('input')!.value).toBe('/marker Next')
  })
  it('preserves a failed draft and reports idle capture without sending chat', async () => {
    await mount(
      vi.fn(async () => {
        throw new Error('Disk full')
      })
    )
    await type('/marker Alpha')
    await enter()
    expect(container.querySelector('input')!.value).toBe('/marker Alpha')
    expect(container.textContent).toContain('Disk full')
    const create = await mount(undefined, false)
    await type('/marker Beta')
    await enter()
    expect(create).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })
  it('routes literal slash chat normally and keeps local markers independent of chat pending', async () => {
    const providers: LiveChatProviderState[] = ['youtube', 'twitch'].map((platform) => ({
      id: platform,
      platform: platform === 'youtube' ? 'youtube' : 'twitch',
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: 'Connected'
    }))
    const create = await mount(undefined, true, providers)
    await type('//marker literal')
    await enter()
    expect(onSend).toHaveBeenCalledExactlyOnceWith('/marker literal', {})
    await mount(create, true, providers, true)
    await type('/marker 😀 Library')
    expect(container.textContent).toContain('Local · current session')
    expect(container.querySelector('[data-testid="chat-send-to"]')).toBeNull()
    await enter()
    expect(create).toHaveBeenCalledExactlyOnceWith('😀 Library')
    expect(onSend).not.toHaveBeenCalled()
  })
  it('completes a command with Tab and dismisses suggestions without clearing the draft', async () => {
    await mount()
    await type('/m')
    await act(async () =>
      container
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    )
    expect(container.querySelector('input')!.value).toBe('/marker ')
    await type('/h')
    await act(async () =>
      container
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(container.querySelector('input')!.value).toBe('/h')
    expect(container.querySelector('[aria-label="Local commands"]')).toBeNull()
  })
})
