// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommentRow } from '@/components/comment-row'
import type { LiveChatMessage } from '@/lib/backend'

const message: LiveChatMessage = {
  id: 'youtube:message-1',
  providerMessageId: 'message-1',
  platform: 'youtube',
  sessionId: 'session-1',
  authorName: 'Ada Lovelace',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-07-10T12:00:00.000Z',
  receivedAt: '2026-07-10T12:00:01.000Z',
  messageText: 'Ship it!',
  fragments: [],
  eventType: 'message',
  isDeleted: false
}

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(phase: 'idle' | 'live'): Promise<{
  onHighlight: ReturnType<typeof vi.fn>
  button: HTMLButtonElement
}> {
  const onHighlight = vi.fn()
  await act(async () => {
    root.render(createElement(CommentRow, { highlight: { phase }, message, onHighlight }))
  })
  const button = container.querySelector<HTMLButtonElement>('[data-message-id] > button')
  if (!button) throw new Error('no row button')
  return { onHighlight, button }
}

function mouseClick(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
}

describe('CommentRow click (owner call, plan 174 D10)', () => {
  it('puts the message on stream, and takes the live row off', async () => {
    const idle = await mount('idle')
    await act(async () => mouseClick(idle.button))
    expect(idle.onHighlight).toHaveBeenCalledWith(message)

    const live = await mount('live')
    expect(live.button.getAttribute('aria-pressed')).toBe('true')
    await act(async () => mouseClick(live.button))
    expect(live.onHighlight).toHaveBeenCalledWith(message)
  })

  it('ignores a mouse drag that ends with the message text selected', async () => {
    const { onHighlight, button } = await mount('idle')
    const text = [...button.querySelectorAll('span')].find((span) =>
      span.textContent?.includes('Ship it!')
    )?.firstChild
    if (!text) throw new Error('no message text')
    // What a drag over "Ship" leaves behind (happy-dom's own Selection cannot
    // read a range back, so the selection is stood in for).
    const selection = { isCollapsed: false, anchorNode: text, toString: () => 'Ship' }
    const getSelection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue(selection as unknown as Selection)

    await act(async () => mouseClick(button))
    expect(onHighlight).not.toHaveBeenCalled()

    // A keyboard click (Enter, Space) carries no drag: it still acts.
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
    })
    expect(onHighlight).toHaveBeenCalledTimes(1)

    // Once the words are no longer selected, the next click acts again.
    getSelection.mockReturnValue({ ...selection, isCollapsed: true } as unknown as Selection)
    await act(async () => mouseClick(button))
    expect(onHighlight).toHaveBeenCalledTimes(2)
  })
})
