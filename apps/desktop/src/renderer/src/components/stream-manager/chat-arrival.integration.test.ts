import { markChatDeliveryIncomplete } from '../../../../shared/chat-delivery'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveChatMessage, LiveChatSnapshot } from '@/lib/backend'

const virtual = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  measureElement: vi.fn(),
  getVirtualItems: () => [],
  getTotalSize: () => 116000
}))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => virtual }))
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
import { ChatPane } from './chat-pane'
import { StreamManager } from './stream-manager'
import {
  applyLiveChatMessage,
  applyLiveChatMessages,
  applyLiveChatSnapshot
} from '@/lib/live-chat-view'
import { applyCommentsSnapshotDelta } from '../../../../shared/comments-snapshot-delta'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'

const message = (
  index: number,
  eventType: LiveChatMessage['eventType'] = 'message'
): LiveChatMessage => ({
  id: `s1:twitch:${index}`,
  providerMessageId: String(index),
  sessionId: 's1',
  platform: 'twitch',
  authorName: 'Viewer',
  authorBadges: [],
  authorRoles: [],
  publishedAt: String(index).padStart(8, '0'),
  receivedAt: String(index).padStart(8, '0'),
  messageText: 'Equal height message',
  fragments: [],
  eventType,
  isDeleted: false,
  ...(eventType === 'follow' ? { details: { kind: 'follow' as const } } : {})
})
const seed = (
  count = 1999,
  eventType: (index: number) => LiveChatMessage['eventType'] = () => 'message'
): LiveChatSnapshot =>
  applyLiveChatSnapshot({
    sessionId: 's1',
    providers: [],
    messages: Array.from({ length: count }, (_, index) => message(index, eventType(index))),
    unreadCount: 0,
    updatedAt: 'now'
  })

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
    'localStorage',
    'Event',
    'MouseEvent'
  ] as const)
    vi.stubGlobal(
      key,
      key === 'window'
        ? dom
        : key === 'getComputedStyle'
          ? dom.getComputedStyle.bind(dom)
          : dom[key]
    )
  vi.stubGlobal('requestAnimationFrame', dom.requestAnimationFrame.bind(dom))
  vi.stubGlobal('cancelAnimationFrame', dom.cancelAnimationFrame.bind(dom))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const element = dom.document.createElement('div')
  dom.document.body.appendChild(element)
  container = element as unknown as HTMLElement
  root = createRoot(container)
  virtual.scrollToIndex.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  await dom.happyDOM.close()
  vi.unstubAllGlobals()
})

const renderChat = async (snapshot: LiveChatSnapshot) => {
  await act(async () =>
    root.render(
      createElement(ChatPane, {
        messages: snapshot.messages,
        delivery: snapshot.delivery,
        arrivalKey: snapshot.sessionId,
        providers: [],
        live: true,
        questionMessageIds: new Set<string>(),
        mentionNames: []
      })
    )
  )
}
const unpin = async () => {
  const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
  Object.defineProperties(viewport, {
    scrollHeight: { value: 116000, configurable: true },
    clientHeight: { value: 600, configurable: true },
    scrollTop: { value: 0, writable: true, configurable: true }
  })
  await act(async () =>
    viewport.dispatchEvent(new dom.Event('scroll', { bubbles: true }) as unknown as Event)
  )
}
const newButton = () =>
  [...container.querySelectorAll('button')].find((button) =>
    /\d+ new/.test(button.textContent ?? '')
  )
const badge = (label: string) =>
  [...container.querySelectorAll('[data-slot="pane-tabs-narrow"] button')]
    .find((button) => button.textContent?.startsWith(label))
    ?.querySelector('[data-slot="pane-unseen"]')?.textContent ?? '0'

for (const [owner, append] of [
  ['provider', applyLiveChatMessage],
  [
    'detached',
    (snapshot: LiveChatSnapshot, next: LiveChatMessage) =>
      applyCommentsSnapshotDelta(snapshot, { kind: 'message', message: next })
  ]
] as const) {
  describe(`${owner} chat arrival consumers`, () => {
    it('counts 1999 to 2000 and constant-size rollover while unpinned, then jumps to latest', async () => {
      let snapshot = seed()
      await renderChat(snapshot)
      await unpin()
      snapshot = append(snapshot, message(1999))
      await renderChat(snapshot)
      expect(newButton()?.textContent).toContain('1 new')
      snapshot = append(snapshot, message(2000))
      await renderChat(snapshot)
      expect(snapshot.messages).toHaveLength(2000)
      expect(newButton()?.textContent).toContain('2 new')
      for (let index = 2001; index < 2004; index++) snapshot = append(snapshot, message(index))
      await renderChat(snapshot)
      expect(newButton()?.textContent).toContain('5 new')
      await act(async () => newButton()!.click())
      expect(newButton()).toBeUndefined()
      expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(1999, { align: 'end' })
    })
    it('follows every newest identity at an unchanged row count without resize callbacks', async () => {
      let snapshot = seed(2000)
      await renderChat(snapshot)
      virtual.scrollToIndex.mockClear()
      for (let index = 2000; index < 2003; index++) {
        snapshot = append(snapshot, message(index))
        await renderChat(snapshot)
      }
      expect(virtual.scrollToIndex).toHaveBeenCalledTimes(3)
      expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(1999, { align: 'end' })
    })
    it.each(['message', 'follow'] as const)(
      'counts fresh %s deliveries on its hidden pane at rollover',
      async (eventType) => {
        // Five oldest follows exercise Activity identity replacement without
        // mounting thousands of unrelated row menus in this arrival test.
        let snapshot = seed(1999, (index) =>
          eventType === 'follow' && index < 5 ? 'follow' : 'message'
        )
        const render = async () => {
          await act(async () =>
            root.render(createElement(StreamManager, { snapshot, dashboard: null }))
          )
        }
        const expectActivity = (indices: number[]) =>
          expect(
            [...container.querySelectorAll('[data-slot="activity-row"]')]
              .map((row) => row.getAttribute('data-activity-id'))
              .sort()
          ).toEqual(indices.map((index) => message(index).id).sort())
        expect(snapshot.messages).toHaveLength(1999)
        await render()
        if (eventType === 'follow') expectActivity([0, 1, 2, 3, 4])
        const label = eventType === 'follow' ? 'Activity' : 'Chat'
        snapshot = append(snapshot, message(1999, eventType))
        expect(snapshot.messages).toHaveLength(2000)
        await render()
        expect(badge(label)).toBe('1')
        if (eventType === 'follow') expectActivity([0, 1, 2, 3, 4, 1999])
        snapshot = append(snapshot, message(2000, eventType))
        expect(snapshot.messages).toHaveLength(2000)
        await render()
        expect(badge(label)).toBe('2')
        if (eventType === 'follow') expectActivity([1, 2, 3, 4, 1999, 2000])
        for (let index = 2001; index < 2004; index++) {
          snapshot = append(snapshot, message(index, eventType))
          expect(snapshot.messages).toHaveLength(2000)
        }
        await render()
        expect(badge(label)).toBe('5')
        if (eventType === 'follow') expectActivity([4, 1999, 2000, 2001, 2002, 2003])
      }
    )
  })
}

it('counts a distinct late delivery even when chronological retention immediately trims its row', async () => {
  let snapshot = seed(2000)
  await renderChat(snapshot)
  await unpin()
  const late = {
    ...message(5000),
    receivedAt: '-older-than-buffer',
    publishedAt: '-older-than-buffer'
  }
  snapshot = applyLiveChatMessage(snapshot, late)
  expect(snapshot.messages.some((row) => row.id === late.id)).toBe(false)
  await renderChat(snapshot)
  expect(newButton()?.textContent).toContain('1 new')
})

it('does not count an admission deleted in the same provider batch; preserves an already counted admission', async () => {
  let snapshot = seed(1999)
  await renderChat(snapshot)
  await unpin()
  const incoming = message(1999)
  const deleted = { ...incoming, isDeleted: true, eventType: 'deleted' as const, messageText: '' }
  snapshot = applyLiveChatMessages(snapshot, [incoming, deleted])
  await renderChat(snapshot)
  expect(newButton()).toBeUndefined()
  const next = message(2000)
  snapshot = applyLiveChatMessage(snapshot, next)
  await renderChat(snapshot)
  expect(newButton()?.textContent).toContain('1 new')
  snapshot = applyLiveChatMessage(snapshot, {
    ...next,
    isDeleted: true,
    eventType: 'deleted',
    messageText: ''
  })
  await renderChat(snapshot)
  expect(newButton()?.textContent).toContain('1 new')
})

it('counts a new open question identity when it replaces an equal-count question', async () => {
  const question = (id: string) => ({
    id,
    text: 'Question',
    messageIds: [],
    askers: [],
    platforms: [],
    priority: 'normal' as const,
    suggestedReply: '',
    fromNotes: false,
    firstSeenAt: 'now',
    updatedAt: 'now'
  })
  const render = async (id: string) => {
    await act(async () =>
      root.render(
        createElement(StreamManager, {
          snapshot: seed(0),
          dashboard: null,
          cohostGate: { allowed: true },
          cohostEnabled: true,
          cohostConsented: true,
          cohostState: {
            ...EMPTY_COHOST_STATE,
            sessionId: 's1',
            status: 'listening',
            questions: [question(id)]
          }
        })
      )
    )
  }
  await render('q1')
  expect(badge('Orcle')).toBe('0')
  await render('q2')
  expect(badge('Orcle')).toBe('1')
})

it('keeps duplicate, tombstone, hydration and emote refreshes from manufacturing unread; resets on clear and session change', async () => {
  let snapshot = seed(2000)
  await renderChat(snapshot)
  await unpin()
  const incoming = message(2000)
  snapshot = applyLiveChatMessage(snapshot, incoming)
  await renderChat(snapshot)
  expect(newButton()?.textContent).toContain('1 new')
  snapshot = applyLiveChatMessage(snapshot, incoming)
  await renderChat(snapshot)
  snapshot = applyLiveChatSnapshot(
    {
      ...snapshot,
      messages: snapshot.messages.map((row) => ({
        ...row,
        fragments: [{ type: 'text' as const, text: row.messageText }]
      }))
    },
    snapshot
  )
  await renderChat(snapshot)
  expect(newButton()?.textContent).toContain('1 new')
  snapshot = applyLiveChatSnapshot(
    { ...snapshot, messages: [], delivery: undefined },
    snapshot,
    true
  )
  await renderChat(snapshot)
  expect(newButton()).toBeUndefined()
  snapshot = applyLiveChatSnapshot(
    { ...snapshot, sessionId: 's2', delivery: undefined, messages: [message(2001)] },
    snapshot
  )
  await renderChat(snapshot)
  expect(newButton()).toBeUndefined()
})

it('uses ordinary new-chat indicators when one render overruns bounded filtered evidence, and reopen baselines it', async () => {
  let snapshot = seed(0)
  await renderChat(snapshot)
  await unpin()
  snapshot = applyLiveChatMessages(
    snapshot,
    Array.from({ length: 2003 }, (_, index) => message(index))
  )
  await renderChat(snapshot)
  const paused = container.querySelector<HTMLButtonElement>('button[aria-label^="Chat paused:"]')
  expect(paused?.textContent).toContain('New chat')
  await act(async () => root.render(createElement(StreamManager, { snapshot, dashboard: null })))
  expect(badge('Chat')).toBe('0')
  snapshot = applyLiveChatMessages(
    snapshot,
    Array.from({ length: 2003 }, (_, index) => message(index + 2003))
  )
  await act(async () => root.render(createElement(StreamManager, { snapshot, dashboard: null })))
  expect(badge('Chat')).toBe('New')
})

it('shows New chat for an owned pending-queue loss without inventing a numeric arrival count', async () => {
  let snapshot = seed(0)
  await renderChat(snapshot)
  await unpin()
  snapshot = markChatDeliveryIncomplete(snapshot)
  await renderChat(snapshot)
  expect(container.querySelector('button[aria-label^="Chat paused:"]')?.textContent).toContain(
    'New chat'
  )
  await renderChat({ ...snapshot })
  expect(container.querySelector('button[aria-label^="Chat paused:"]')?.textContent).toContain(
    'New chat'
  )
})

it('treats history replacement and returning to live as hydration baselines rather than hidden-pane arrivals', async () => {
  let snapshot = seed(2000)
  const history = {
    kind: 'history' as const,
    sessionId: 's1',
    title: 'Fixture history',
    startedAt: 'now'
  }
  const render = async (viewMode?: typeof history) => {
    await act(async () =>
      root.render(createElement(StreamManager, { snapshot, viewMode, dashboard: null }))
    )
  }
  await render(history)
  snapshot = applyLiveChatMessages(snapshot, [message(2000), message(2001), message(2002)])
  await render(history)
  expect(badge('Chat')).toBe('0')
  await render()
  expect(badge('Chat')).toBe('0')
  snapshot = applyLiveChatMessage(snapshot, message(2003))
  await render()
  expect(badge('Chat')).toBe('1')
})
