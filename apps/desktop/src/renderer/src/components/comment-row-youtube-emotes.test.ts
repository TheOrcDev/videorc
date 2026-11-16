// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixture from '../../../../../../scripts/fixtures/stream-manager/youtube-chat-emotes.json'
import type { LiveChatMessage } from '@/lib/backend'
import { CommentRow } from './comment-row'

const cached = vi.hoisted(() => ({ localUrl: null as string | null, requested: vi.fn() }))
vi.mock('@/lib/chat-avatar', async (original) => ({
  ...(await original<typeof import('@/lib/chat-avatar')>()),
  useCachedAvatar: (url: string | undefined) => {
    cached.requested(url)
    return url ? cached.localUrl : null
  }
}))

const blue = fixture.message.fragments[0]!
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  cached.localUrl = null
  cached.requested.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(overrides: Partial<LiveChatMessage> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(CommentRow, {
        message: { ...fixture.message, platform: 'youtube', eventType: 'message', ...overrides },
        onHighlight: () => undefined
      })
    )
  )
}

describe('YouTube emotes in Stream Manager', () => {
  it('renders the exact @vcode_sh blue-face regression through the shared cache', async () => {
    cached.localUrl = 'videorc-asset://avatar/blue-face.img'
    await render()
    const image = container.querySelector<HTMLImageElement>('[data-slot="comment-emote"]')!
    expect(container.textContent).toContain('@vcode_sh')
    expect(image.alt).toBe(':face-blue-smiling:')
    expect(image.title).toBe(':face-blue-smiling:')
    expect(image.getAttribute('src')).toBe(cached.localUrl)
    expect(image.className).toContain('align-text-bottom')
    expect(image.className).toContain('h-5')
    expect(cached.requested).toHaveBeenCalledWith(blue.imageUrl)
    expect(container.querySelector('img[src^="https:"]')).toBeNull()
  })

  it('keeps readable text when the cache refuses or cannot fetch an image', async () => {
    await render()
    expect(container.querySelector('[data-slot="comment-emote"]')).toBeNull()
    expect(container.textContent).toContain(':face-blue-smiling:')
  })

  it('restores the alias if a cached image fails to decode', async () => {
    cached.localUrl = 'videorc-asset://avatar/broken.img'
    await render()
    const image = container.querySelector('[data-slot="comment-emote"]')!
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.querySelector('[data-slot="comment-emote"]')).toBeNull()
    expect(container.textContent).toContain(':face-blue-smiling:')
  })

  it('preserves mixed text, Unicode, adjacent repeats and unknown member aliases without HTML', async () => {
    cached.localUrl = 'videorc-asset://avatar/blue-face.img'
    const prefix = '<img src=x onerror=alert(1)> 👩🏽‍💻 '
    const suffix = ' :_memberCustom: ❤️'
    await render({
      messageText: prefix + blue.text + blue.text + suffix,
      fragments: [{ type: 'text', text: prefix }, blue, blue, { type: 'text', text: suffix }]
    })
    expect(container.querySelectorAll('[data-slot="comment-emote"]')).toHaveLength(2)
    expect(container.textContent).toContain(prefix)
    expect(container.textContent).toContain(suffix)
    expect(container.querySelector('img[src="x"]')).toBeNull()
  })

  it.each(['youtube', 'twitch', 'kick', 'x'] as const)(
    'does not guess aliases in %s plain renderer text',
    async (platform) => {
      cached.localUrl = 'videorc-asset://avatar/blue-face.img'
      await render({ platform, fragments: [] })
      expect(container.querySelector('[data-slot="comment-emote"]')).toBeNull()
      expect(container.textContent).toContain(blue.text)
      expect(cached.requested).not.toHaveBeenCalledWith(blue.imageUrl)
    }
  )
})
