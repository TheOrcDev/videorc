// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { useCachedAvatar, type CachedImageKind } from './chat-avatar'

function ImageUrl({ url, kind }: { url: string | null; kind: CachedImageKind }) {
  const local = useCachedAvatar(url, kind)
  return createElement('span', null, local ?? 'fallback')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A null answer leaves no <img> to fail, and the Stream Manager never hears
// the backend come back: the hook asks again, a bounded number of times.
it('asks again after a null answer until the backend answers', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const cacheChatAvatar = vi.fn(async (): Promise<string | null> => null)
  vi.stubGlobal('videorc', { cacheChatAvatar, cacheChatGif: vi.fn(async () => null) })
  const container = document.createElement('div')
  const root = createRoot(container)
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  try {
    await act(async () => {
      root.render(createElement(ImageUrl, { url: 'while-away', kind: 'avatar' }))
    })
    await vi.waitFor(() => expect(cacheChatAvatar).toHaveBeenCalledTimes(1))
    await advance(0)
    expect(container.textContent).toBe('fallback')
    await advance(4_000)
    expect(cacheChatAvatar).toHaveBeenCalledTimes(1)
    await advance(1_500)
    await vi.waitFor(() => expect(cacheChatAvatar).toHaveBeenCalledTimes(2))
    expect(container.textContent).toBe('fallback')
    cacheChatAvatar.mockImplementation(async () => 'local:back')
    await advance(21_000)
    await vi.waitFor(() => expect(cacheChatAvatar).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(container.textContent).toBe('local:back'))
    await advance(600_000)
    expect(cacheChatAvatar).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
  }
})

it('stops asking after the last retry', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const cacheChatAvatar = vi.fn(async (): Promise<string | null> => null)
  vi.stubGlobal('videorc', { cacheChatAvatar, cacheChatGif: vi.fn(async () => null) })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(ImageUrl, { url: 'refused-for-good', kind: 'avatar' }))
    })
    await vi.waitFor(() => expect(cacheChatAvatar).toHaveBeenCalledTimes(1))
    for (let step = 0; step < 20; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
    }
    // The first answer and one per retry delay (5 s, 20 s, 60 s).
    expect(cacheChatAvatar).toHaveBeenCalledTimes(4)
    expect(container.textContent).toBe('fallback')
  } finally {
    await act(async () => root.unmount())
  }
})

it('loads the cache through the hook and ignores superseded results', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const pending = new Map<string, (value: string | null) => void>()
  const cacheChatAvatar = vi.fn(
    (url: string) => new Promise<string | null>((resolve) => pending.set(url, resolve))
  )
  const cacheChatGif = vi.fn(async () => 'local:gif')
  vi.stubGlobal('videorc', { cacheChatAvatar, cacheChatGif })
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = async (url: string | null, kind: CachedImageKind = 'avatar'): Promise<void> => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(ImageUrl, { url, kind })))
    })
  }
  try {
    await render('first')
    await vi.waitFor(() => expect(cacheChatAvatar).toHaveBeenCalledTimes(1))
    expect(container.textContent).toBe('fallback')
    await render('second')
    await vi.waitFor(() => expect(cacheChatAvatar).toHaveBeenCalledTimes(2))
    await act(async () => pending.get('second')!('local:second'))
    expect(container.textContent).toBe('local:second')
    await act(async () => pending.get('first')!('local:first'))
    expect(container.textContent).toBe('local:second')
    await render('animation', 'gif')
    expect(container.textContent).toBe('local:gif')
    expect(cacheChatGif).toHaveBeenCalledTimes(1)
    await render(null)
    expect(container.textContent).toBe('fallback')
  } finally {
    await act(async () => root.unmount())
  }
})
