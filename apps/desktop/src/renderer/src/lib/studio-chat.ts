// Chat in Studio (plan 204): the gate the Studio tab reads on every render.
// Only the setting and the session state, so the chat itself, its rows and
// their imports stay in the section's own chunk
// (`components/studio/studio-chat.tsx`, `lib/studio-chat-view.ts`).

import { sessionIsLive } from '../../../shared/capture-state'
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
