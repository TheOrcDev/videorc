// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommentHighlightState, LiveChatMessage, LiveChatSnapshot } from '@/lib/backend'
import { spaceShortcutBlocked } from '@/lib/studio-space-shortcut'

// Plan 204: Chat in Studio. A row is the avatar, the name, the words and the
// platform; a click puts it on stream and a click on the live row takes it
// off (owner call, D10), through the provider's one highlight.

const mocked = vi.hoisted(() => ({
  chat: {} as { liveChatSnapshot: LiveChatSnapshot },
  core: {} as Record<string, unknown>,
  shell: {} as Record<string, unknown>,
  toastInfo: vi.fn(),
  copy: vi.fn(async () => true)
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioChat: () => mocked.chat,
  useStudioCore: () => mocked.core,
  useStudioShell: () => mocked.shell
}))
vi.mock('@/lib/toast', () => ({
  TOAST_WITH_DESCRIPTION_MS: 8_000,
  toast: { info: mocked.toastInfo }
}))
vi.mock('@/lib/chat-link-actions', () => ({ copyChatText: mocked.copy }))
// Every row rendered: the virtualizer's window is not what is under test.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey: (index: number) => string | number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 36
      })),
    getTotalSize: () => options.count * 36,
    measureElement: () => undefined,
    scrollToIndex: () => undefined
  })
}))
vi.mock('@/components/ui/scroll-area', async () => {
  const { createElement } = await import('react')
  return {
    ScrollArea: ({
      children,
      ref
    }: {
      children?: React.ReactNode
      ref?: React.Ref<HTMLDivElement>
    }) =>
      createElement(
        'div',
        { ref },
        createElement('div', { 'data-slot': 'scroll-area-viewport' }, children)
      )
  }
})

import { StudioChatSection } from './studio-chat'

const message = (id: string, patch: Partial<LiveChatMessage> = {}): LiveChatMessage => ({
  id,
  providerMessageId: id,
  platform: 'youtube',
  sessionId: 's1',
  authorName: 'Ada Lovelace',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-10-27T12:00:00.000Z',
  receivedAt: '2026-10-27T12:00:00.000Z',
  messageText: 'Ship it!',
  fragments: [],
  eventType: 'message',
  isDeleted: false,
  ...patch
})

const snapshot = (
  messages: LiveChatMessage[],
  patch: Partial<LiveChatSnapshot> = {}
): LiveChatSnapshot => ({
  sessionId: 's1',
  providers: [
    {
      id: 'youtube:main',
      platform: 'youtube',
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: 'Connected.'
    }
  ],
  messages,
  unreadCount: 0,
  updatedAt: 'now',
  ...patch
})

const IDLE: CommentHighlightState = { generation: 0, phase: 'idle' }

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.toastInfo.mockClear()
  mocked.copy.mockClear()
  mocked.chat = { liveChatSnapshot: snapshot([message('m1')]) }
  mocked.core = {
    setSettings: vi.fn(),
    highlightedCommentId: null,
    commentHighlightState: IDLE,
    commentHighlightApplyingId: null,
    commentHighlightFailure: null,
    toggleCommentHighlight: vi.fn()
  }
  mocked.shell = {
    openCommentsWindow: vi.fn(async () => undefined),
    runtimeInfo: { platform: 'darwin', commentsWindowEnabled: true }
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = async (): Promise<void> => {
  await act(async () => root.render(createElement(StudioChatSection)))
}
const row = (id: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-message-id="${id}"]`) as HTMLElement
const rowButton = (id: string): HTMLButtonElement | null =>
  row(id)?.querySelector<HTMLButtonElement>(':scope > button') ?? null
const nameOf = (element: Element): string =>
  (element.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

describe('StudioChatSection', () => {
  it('heads the section Chat, with the Stream Manager door and the hide button', async () => {
    await render()
    expect(container.querySelector('h2')?.textContent).toBe('Chat')
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="studio-chat-open-stream-manager"]'
    )
    expect(open?.textContent).toBe('Open Stream Manager')
    await act(async () => open?.click())
    expect(mocked.shell.openCommentsWindow).toHaveBeenCalledTimes(1)
    expect(
      container.querySelector('[data-testid="studio-chat-hide"]')?.getAttribute('aria-label')
    ).toBe('Hide chat in Studio')
  })

  it('leaves out the Stream Manager door while that window is off', async () => {
    mocked.shell.runtimeInfo = { platform: 'darwin', commentsWindowEnabled: false }
    await render()
    expect(container.querySelector('[data-testid="studio-chat-open-stream-manager"]')).toBeNull()
  })

  it('names a row by who said what where, and shows the avatar, the words and the mark', async () => {
    await render()
    const button = rowButton('m1')
    expect(button).not.toBeNull()
    expect(nameOf(button as HTMLButtonElement)).toBe('Ada Lovelace on YouTube: Ship it!')
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    expect(button?.getAttribute('aria-description')).toBe('Shows it on stream')
    expect(row('m1').querySelector('[data-slot="avatar"]')?.textContent).toBe('AL')
    // No time, no ⋯ menu: less than the Stream Manager's row (D5).
    expect(row('m1').querySelector('time')).toBeNull()
    expect(row('m1').querySelector('[aria-haspopup="menu"]')).toBeNull()
  })

  it('puts a message on stream with a click, and a click on the live row asks again', async () => {
    await render()
    await act(async () => rowButton('m1')?.click())
    expect(mocked.core.toggleCommentHighlight).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1' })
    )
    mocked.core = {
      ...mocked.core,
      highlightedCommentId: 'm1',
      commentHighlightState: { generation: 1, phase: 'live', messageId: 'm1', sessionId: 's1' }
    }
    await render()
    const live = rowButton('m1')
    expect(live?.getAttribute('aria-pressed')).toBe('true')
    expect(live?.getAttribute('aria-description')).toBe('Takes it off the stream')
    expect(row('m1').getAttribute('data-highlight-phase')).toBe('live')
    expect(row('m1').textContent).toContain('On stream')
    await act(async () => live?.click())
    expect(mocked.core.toggleCommentHighlight).toHaveBeenCalledTimes(2)
  })

  it('never shows a message when the click ends a text selection', async () => {
    await render()
    const words = row('m1').querySelector('.select-text') as HTMLElement
    const selection = window.getSelection()
    selection?.selectAllChildren(words)
    await act(async () => {
      rowButton('m1')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    expect(mocked.core.toggleCommentHighlight).not.toHaveBeenCalled()
    selection?.removeAllRanges()
  })

  it('disables the row while its card renders, and says why one failed', async () => {
    mocked.core = { ...mocked.core, commentHighlightApplyingId: 'm1' }
    await render()
    expect(rowButton('m1')?.disabled).toBe(true)
    expect(row('m1').textContent).toContain('Applying…')
    mocked.core = {
      ...mocked.core,
      commentHighlightApplyingId: null,
      commentHighlightFailure: { messageId: 'm1', reason: 'The card could not render.' }
    }
    await render()
    expect(row('m1').querySelector('[data-testid="highlight-failed-reason"]')?.textContent).toBe(
      'The card could not render.'
    )
  })

  it('keeps a removed message and a plain notice off stream: facts, not buttons', async () => {
    mocked.chat = {
      liveChatSnapshot: snapshot([
        message('gone', { isDeleted: true }),
        message('note', { eventType: 'system', messageText: 'Slow mode is on.' })
      ])
    }
    await render()
    expect(rowButton('gone')).toBeNull()
    expect(rowButton('note')).toBeNull()
    expect(row('gone').getAttribute('tabindex')).not.toBeNull()
  })

  it('shows a paid message with its amount', async () => {
    mocked.chat = {
      liveChatSnapshot: snapshot([message('p1', { eventType: 'paid', amountText: '$5.00' })])
    }
    await render()
    expect(row('p1').getAttribute('data-row-tint')).toBe('paid')
    expect(row('p1').textContent).toContain('$5.00')
  })

  it('offers no row a click once the livestream it came from has no session', async () => {
    mocked.chat = { liveChatSnapshot: snapshot([message('m1')], { sessionId: undefined }) }
    await render()
    expect(rowButton('m1')).toBeNull()
  })

  it('moves the one tab stop with the arrows and copies with C', async () => {
    mocked.chat = { liveChatSnapshot: snapshot([message('m1'), message('m2'), message('m3')]) }
    await render()
    // The newest row holds the tab stop until another is chosen.
    expect(rowButton('m3')?.tabIndex).toBe(0)
    expect(rowButton('m1')?.tabIndex).toBe(-1)
    await act(async () => rowButton('m3')?.focus())
    await act(async () => {
      rowButton('m3')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
      )
    })
    expect(rowButton('m2')?.tabIndex).toBe(0)
    expect(document.activeElement).toBe(rowButton('m2'))
    await act(async () => {
      rowButton('m2')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    })
    expect(mocked.copy).toHaveBeenCalledWith('Ada Lovelace: Ship it!')
  })

  it('keeps Space on a focused row: it presses the row, never Record or Stop', async () => {
    await render()
    const button = rowButton('m1') as HTMLButtonElement
    await act(async () => button.focus())
    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })
    Object.defineProperty(event, 'target', { value: button })
    expect(spaceShortcutBlocked(event, document)).toBe(true)
  })

  it('hides at once with an Undo toast that says where it went', async () => {
    await render()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="studio-chat-hide"]')?.click()
    )
    const setSettings = mocked.core.setSettings as ReturnType<typeof vi.fn>
    const hide = setSettings.mock.calls.at(-1)?.[0] as (current: object) => object
    expect(hide({ studioChat: true, retroLcdStudio: true })).toEqual({
      studioChat: false,
      retroLcdStudio: true
    })
    expect(mocked.toastInfo).toHaveBeenCalledTimes(1)
    const [title, options] = mocked.toastInfo.mock.calls[0] as [
      string,
      { id: string; description: string; action: { label: string; onClick: () => void } }
    ]
    expect(title).toBe('Chat hidden in Studio')
    expect(options.id).toBe('studio-chat-hidden')
    expect(options.description).toBe('Turn it back on in Settings → General.')
    expect(options.action.label).toBe('Undo')
    options.action.onClick()
    const undo = setSettings.mock.calls.at(-1)?.[0] as (current: object) => object
    expect(undo({ studioChat: false })).toEqual({ studioChat: true })
  })

  it('says, in one line, that nothing on this livestream has chat', async () => {
    mocked.chat = { liveChatSnapshot: snapshot([], { providers: [] }) }
    await render()
    expect(container.querySelector('[data-testid="studio-chat-empty"]')?.textContent).toBe(
      'No destination on this livestream has chat.'
    )
    expect(container.querySelector('ol')).toBeNull()
  })

  it('waits on connected chat with the list area, and names a chat that needs the streamer', async () => {
    mocked.chat = { liveChatSnapshot: snapshot([]) }
    await render()
    expect(container.querySelector('[data-testid="studio-chat-empty"]')?.textContent).toBe(
      'Chat is connected. New messages appear here.'
    )
    expect(container.querySelector('[data-testid="studio-chat-notice"]')).toBeNull()
    mocked.chat = {
      liveChatSnapshot: snapshot([], {
        providers: [
          {
            id: 'youtube:main',
            platform: 'youtube',
            read: 'failed',
            write: 'ready',
            state: 'failed',
            message: 'YouTube chat stopped. Reconnect YouTube.'
          }
        ]
      })
    }
    await render()
    expect(container.querySelector('[data-testid="studio-chat-notice"]')?.textContent).toBe(
      'YouTube chat stopped. Reconnect YouTube.'
    )
    expect(container.querySelector('[data-testid="studio-chat-empty"]')?.textContent).toBe(
      'No messages yet.'
    )
  })
})
