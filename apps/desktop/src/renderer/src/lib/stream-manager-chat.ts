import type { LiveChatMessage, LiveChatProviderState, StreamPlatform } from '@/lib/backend'
import { commentMentions } from '@/components/comment-row'

// The Stream Manager's chat filters (plan 055, D3): platform, Orcle's
// questions, mentions of the streamer, and search. Follows are activity and
// never appear in chat.

export interface ChatPaneFilter {
  platform: StreamPlatform | 'all'
  questions: boolean
  mentions: boolean
  search: string
}

export function chatPaneMessages(
  messages: readonly LiveChatMessage[],
  filter: ChatPaneFilter,
  context: { questionMessageIds: ReadonlySet<string>; mentionNames: readonly string[] }
): LiveChatMessage[] {
  const query = filter.search.trim().toLowerCase()
  return messages.filter((message) => {
    if (message.eventType === 'follow') return false
    if (filter.platform !== 'all' && message.platform !== filter.platform) return false
    if (filter.questions && !context.questionMessageIds.has(message.id)) return false
    if (filter.mentions && !commentMentions(message, context.mentionNames)) return false
    if (
      query &&
      !message.messageText.toLowerCase().includes(query) &&
      !message.authorName.toLowerCase().includes(query)
    ) {
      return false
    }
    return true
  })
}

/** The providers the composer's "Send to" picker offers (plan 055, S10). */
export function writableProviders(
  providers: readonly LiveChatProviderState[]
): LiveChatProviderState[] {
  return providers.filter((provider) => provider.write === 'ready')
}

/**
 * The providers one send reaches: the picked ones that are still writable, or
 * every writable one when nothing is picked. A pick that has since gone
 * read-only never silently widens to all.
 */
export function pickedSendProviders(
  providers: readonly LiveChatProviderState[],
  picked: ReadonlySet<string> | null
): LiveChatProviderState[] {
  const writable = writableProviders(providers)
  return picked ? writable.filter((provider) => picked.has(provider.id)) : writable
}

/** The part of a ResizeObserver the chat follow needs (a fake in tests). */
export interface ResizeObserverLike {
  observe: (target: Element) => void
  disconnect: () => void
}

/**
 * Keeps a pinned chat on its newest row when the scroll viewport or its
 * content resizes (plan 057, P4). Following on new rows alone missed a window
 * resize, the composer growing, and a row that grows once its emotes load:
 * the newest message sat out of view with no paused chip. Returns the cleanup.
 */
export function followChatOnResize(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'firstElementChild'>,
  isPinned: () => boolean,
  createObserver: (callback: () => void) => ResizeObserverLike = (callback) =>
    new ResizeObserver(callback)
): () => void {
  const observer = createObserver(() => {
    if (isPinned()) viewport.scrollTop = viewport.scrollHeight
  })
  observer.observe(viewport as Element)
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
  return () => observer.disconnect()
}
