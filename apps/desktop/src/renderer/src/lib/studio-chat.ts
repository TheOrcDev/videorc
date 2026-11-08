// Chat in Studio (plan 204): the gate the Studio tab reads on every render.
// Only the setting and the session state, so the chat itself, its rows and
// their imports stay in the section's own chunk
// (`components/studio/studio-chat.tsx`, `lib/studio-chat-view.ts`). The Chat
// row's count (plan 213 B1) lives here too: the provider keeps it.

import { sessionIsLive } from '../../../shared/capture-state'
import { isActivityOnlyEvent, type LiveChatSnapshot } from './backend'
import type { SettingsState } from './capture'

/** The Settings → General switch. Off unless turned on (owner, 2026-10-27). */
export function studioChatOn(settings: Pick<SettingsState, 'studioChat'>): boolean {
  return settings.studioChat === true
}

/**
 * The section shows while the switch is on and a livestream is on air: chat
 * exists only for a livestream, so idle, a recording, Clips alone and a
 * start still in flight show nothing (D2).
 */
export function studioChatShows({
  settings,
  recording
}: {
  settings: Pick<SettingsState, 'studioChat'>
  recording: { state?: string | null; streamUrl?: string | null }
}): boolean {
  return studioChatOn(settings) && sessionIsLive(recording)
}

/**
 * Where the streamer last saw chat (plan 213 B1): the livestream and its
 * newest message when the Stream Manager last stopped showing.
 */
export type ChatSeenMark = { sessionId?: string; lastSeenId?: string }

/** The mark for chat as it is now: everything in it counts as seen. */
export function chatSeenMark(
  snapshot: Pick<LiveChatSnapshot, 'sessionId' | 'messages'>
): ChatSeenMark {
  return { sessionId: snapshot.sessionId, lastSeenId: snapshot.messages.at(-1)?.id }
}

/**
 * The Studio's Chat row while live: chat messages that arrived after the mark
 * (activity-only events don't count, as in the Chat section). A mark from
 * another livestream, or one whose message has left the view, counts the
 * whole view.
 */
export function chatNewSinceSeen(
  snapshot: Pick<LiveChatSnapshot, 'sessionId' | 'messages'>,
  mark: ChatSeenMark | null
): number {
  if (!snapshot.sessionId) return 0
  const lastSeenId = mark?.sessionId === snapshot.sessionId ? mark.lastSeenId : undefined
  let count = 0
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]!
    if (message.id === lastSeenId) break
    if (!isActivityOnlyEvent(message.eventType)) count += 1
  }
  return count
}

/**
 * The Studio's Chat row (plan 213 B1): "{n} new" while a livestream with chat
 * is on air, otherwise the door itself (the Stream Manager and its key).
 */
export function chatDoorNewLabel({
  recording,
  snapshot,
  newCount
}: {
  recording: { state?: string | null; streamUrl?: string | null }
  snapshot: Pick<LiveChatSnapshot, 'sessionId' | 'providers'>
  newCount: number
}): string | null {
  const chatOnAir =
    sessionIsLive(recording) && Boolean(snapshot.sessionId) && snapshot.providers.length > 0
  return chatOnAir ? `${newCount} new` : null
}
