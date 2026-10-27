// The Studio's Chat section (plan 204): what it lists and what it says. Pure,
// and loaded only with the section's chunk.

import type { LiveChatMessage, LiveChatProviderState } from '@/lib/backend'
import { liveChatProviderNotice } from '@/lib/live-chat-view'
import { chatPaneMessages, type ChatPaneFilter } from '@/lib/stream-manager-chat'

/** The Stream Manager's chat with no filter on: the set the Studio lists (D5). */
const UNFILTERED: ChatPaneFilter = {
  platform: 'all',
  questions: false,
  mentions: false,
  search: ''
}
const NO_QUESTIONS: ReadonlySet<string> = new Set()
const NO_NAMES: readonly string[] = []

/** Every chat message, without the activity-only events (follows, Power-ups, rewards). */
export function studioChatMessages<
  T extends Pick<LiveChatMessage, 'id' | 'platform' | 'eventType' | 'messageText' | 'authorName'>
>(messages: readonly T[]): T[] {
  return chatPaneMessages(messages, UNFILTERED, {
    questionMessageIds: NO_QUESTIONS,
    mentionNames: NO_NAMES
  })
}

/** A delivered message the section would list: what counts toward "4 new". */
export function studioChatCountsAsArrival(
  message: Pick<LiveChatMessage, 'id' | 'platform' | 'eventType' | 'messageText' | 'authorName'>
): boolean {
  return studioChatMessages([message]).length > 0
}

/** No destination on this livestream has chat. */
export const STUDIO_CHAT_NO_CHAT = 'No destination on this livestream has chat.'
/** Chat is attached and healthy, and nobody has written yet. */
export const STUDIO_CHAT_CONNECTED = 'Chat is connected. New messages appear here.'
/** Chat is attached, nobody has written yet, and the notice says what is wrong. */
export const STUDIO_CHAT_NO_MESSAGES = 'No messages yet.'

export type StudioChatBody =
  /** One line, no list area: nothing on this livestream has chat. */
  | { kind: 'no-chat'; text: string }
  /** The list area at its full height, with a line while it is empty. */
  | { kind: 'list'; emptyText: string }

/**
 * The section's body (D2). The list area is there from the moment chat
 * attaches, so the first message never grows the section and nothing under
 * it jumps mid-stream.
 */
export function studioChatBody(providers: readonly LiveChatProviderState[]): StudioChatBody {
  if (providers.length === 0) return { kind: 'no-chat', text: STUDIO_CHAT_NO_CHAT }
  return {
    kind: 'list',
    emptyText: studioChatNotice(providers) ? STUDIO_CHAT_NO_MESSAGES : STUDIO_CHAT_CONNECTED
  }
}

/**
 * The one quiet line under the header while a destination's chat needs the
 * streamer (D9): the same provider the Stream Manager's empty chat names.
 * Healthy, there is no line.
 */
export function studioChatNotice(providers: readonly LiveChatProviderState[]): string | null {
  return liveChatProviderNotice(providers)?.trim() || null
}
