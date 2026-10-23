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
    expect(container.textContent).toContain('0:12')
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

describe('/banner in the composer (plan 186 S7)', () => {
  const banners = [
    { id: 'sponsor', name: 'Sponsor', shown: false },
    { id: 'spring', name: 'Spring sale', shown: true }
  ]
  async function mountBanners(onBanner = vi.fn(async () => true)): Promise<typeof onBanner> {
    onSend.mockClear()
    await act(async () =>
      root.render(
        createElement(Composer, {
          providers: [
            {
              id: 'youtube',
              platform: 'youtube',
              read: 'ready',
              write: 'ready',
              state: 'connected',
              message: 'Connected'
            }
          ],
          pending: false,
          failures: [],
          operation: null,
          prefill: null,
          cohostNudge: false,
          markerContext: { sessionId: 's1', available: true },
          onSend,
          onMarker: vi.fn(async () => marker),
          banners,
          onBanner
        })
      )
    )
    return onBanner
  }
  const input = () => container.querySelector('input')!
  const completionList = () =>
    [...container.querySelectorAll('[aria-label="Local commands"] [cmdk-item]')].map(
      (item) => item.textContent
    )
  async function key(name: string): Promise<void> {
    await act(async () =>
      input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
    )
  }

  it('toggles the banner a name means with an explicit verb, and never posts to chat', async () => {
    const onBanner = await mountBanners()
    await type('/banner sponsor')
    await enter()
    expect(onBanner).toHaveBeenCalledExactlyOnceWith({ action: 'show', id: 'sponsor' })
    expect(input().value).toBe('')
    await type('/banner SPRING sale')
    await enter()
    expect(onBanner).toHaveBeenLastCalledWith({ action: 'hide', id: 'spring' })
    await type('/banner off')
    await enter()
    expect(onBanner).toHaveBeenLastCalledWith({ action: 'hideAll' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('says which banner it could not pick, in the plan words, and keeps the draft', async () => {
    const onBanner = await mountBanners()
    // The send button runs the draft as typed, past the completion list.
    const run = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Run local command"]')!
    await type('/banner acme')
    await act(async () => run().click())
    expect(container.textContent).toContain('No banner called “acme”.')
    await type('/banner sp')
    await act(async () => run().click())
    expect(container.textContent).toContain('“sp” matches Sponsor and Spring sale.')
    expect(input().value).toBe('/banner sp')
    expect(onBanner).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the draft when the show did not happen (the window has said why)', async () => {
    const onBanner = await mountBanners(vi.fn(async () => false))
    await type('/banner sponsor')
    await enter()
    expect(onBanner).toHaveBeenCalledOnce()
    expect(input().value).toBe('/banner sponsor')
  })

  it('offers /banner, then the banner names with what Enter does', async () => {
    await mountBanners()
    await type('/b')
    expect(completionList()).toEqual(['/banner [name] · Show or hide a banner'])
    await key('Tab')
    expect(input().value).toBe('/banner ')
    expect(completionList()).toEqual([
      '/banner Sponsor · Show',
      '/banner Spring sale · Hide',
      '/banner off · Hide all banners'
    ])
    await type('/banner spo')
    await enter()
    expect(input().value).toBe('/banner Sponsor')
  })

  it('leaves /banner out where the window cannot show banners', async () => {
    await mount()
    await type('/')
    expect(completionList().some((text) => text?.startsWith('/banner'))).toBe(false)
  })
})

describe('/sound in the composer (plan 189 S9)', () => {
  const sounds = {
    sounds: [
      { id: 'airhorn', name: 'Airhorn', mode: 'oneShot' as const },
      { id: 'applause', name: 'Applause', mode: 'toggle' as const }
    ],
    voices: [{ soundId: 'applause', startedAtMs: 1, durationMs: 5000, loop: false }]
  }
  async function mountSounds(onSound = vi.fn(async () => true)): Promise<typeof onSound> {
    onSend.mockClear()
    await act(async () =>
      root.render(
        createElement(Composer, {
          providers: [
            {
              id: 'youtube',
              platform: 'youtube',
              read: 'ready',
              write: 'ready',
              state: 'connected',
              message: 'Connected'
            }
          ],
          pending: false,
          failures: [],
          operation: null,
          prefill: null,
          cohostNudge: false,
          markerContext: { sessionId: 's1', available: true },
          onSend,
          onMarker: vi.fn(async () => marker),
          sounds,
          onSound
        })
      )
    )
    return onSound
  }
  const input = () => container.querySelector('input')!
  const completionList = () =>
    [...container.querySelectorAll('[aria-label="Local commands"] [cmdk-item]')].map(
      (item) => item.textContent
    )
  const run = () => container.querySelector<HTMLButtonElement>('[aria-label="Run local command"]')!

  it('presses the first sound a name starts, stops them all, and never posts to chat', async () => {
    const onSound = await mountSounds()
    await type('/sound air')
    await act(async () => run().click())
    expect(onSound).toHaveBeenCalledExactlyOnceWith({ action: 'press', id: 'airhorn' })
    expect(input().value).toBe('')
    await type('/sound stop')
    await enter()
    expect(onSound).toHaveBeenLastCalledWith({ action: 'stopAll' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('says when no sound has that name, and keeps the draft', async () => {
    const onSound = await mountSounds()
    await type('/sound gong')
    await act(async () => run().click())
    expect(container.textContent).toContain('No sound called “gong”.')
    expect(input().value).toBe('/sound gong')
    expect(onSound).not.toHaveBeenCalled()
  })

  it('offers /sound, then the sounds with what Enter does', async () => {
    await mountSounds()
    await type('/so')
    expect(completionList()).toEqual(['/sound [name] · Play a sound'])
    await act(async () =>
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    )
    expect(input().value).toBe('/sound ')
    expect(completionList()).toEqual([
      '/sound Airhorn · Play',
      '/sound Applause · Stop',
      '/sound stop · Stop all sounds'
    ])
  })

  it('leaves /sound out where the window cannot play sounds', async () => {
    await mount()
    await type('/')
    expect(completionList().some((text) => text?.startsWith('/sound'))).toBe(false)
  })
})
