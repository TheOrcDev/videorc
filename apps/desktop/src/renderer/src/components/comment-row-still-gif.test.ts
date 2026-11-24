// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ reportChatImageFailure: vi.fn(() => true) }))
vi.mock('@/lib/chat-avatar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-avatar')>()),
  reportChatImageFailure: mocked.reportChatImageFailure
}))

import { StillFrame } from './comment-row'

afterEach(() => {
  vi.unstubAllGlobals()
  mocked.reportChatImageFailure.mockClear()
})

// A Still (or reduced-motion) GIF loads through a detached image, which the
// window's capture listener never sees: its own error reports the dead route.
it('reports a retired route from a Still GIF, and nothing after unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null }> = []
  class DetachedImage {
    decoding = ''
    src = ''
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() {
      images.push(this)
    }
  }
  vi.stubGlobal('Image', DetachedImage)
  const route = `http://127.0.0.1:4321/chat-images/${'0'.repeat(32)}.gif?key=${'a'.repeat(32)}`
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(StillFrame, { alt: 'dance', src: route }))
  })
  expect(images).toHaveLength(1)
  const image = images[0]!
  expect(image.onerror).toBeTypeOf('function')
  image.onerror?.()
  expect(mocked.reportChatImageFailure).toHaveBeenCalledWith(route)
  await act(async () => root.unmount())
  expect(image.onerror).toBeNull()
  expect(mocked.reportChatImageFailure).toHaveBeenCalledTimes(1)
})
