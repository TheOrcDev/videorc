// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { useCachedAvatar, type CachedImageKind } from './chat-avatar'

function ImageUrl({ url, kind }: { url: string | null; kind: CachedImageKind }) {
  const local = useCachedAvatar(url, kind)
  return createElement('span', null, local ?? 'fallback')
}

afterEach(() => vi.unstubAllGlobals())

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
