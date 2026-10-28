// `set_buddy` (plan 209 S13): Buddy Live on or off, its chat posting mode and
// whether it is on stream, saved exactly as the Stream Manager's commands
// save them. The save is `cohostEnableRelayPatch`: `enabled` only when it
// changes, the posting mode merged into the stored block so the templates
// and cooldowns stay, and never the microphone (listening is the streamer's
// own choice, with its own disclosure). Turning Buddy on needs Premium and
// the streamer's Cloud AI consent, which an agent cannot give.

import { BUDDY_MODE_LABELS } from '@/lib/buddy-auto-chat-view'
import { BUDDY_CONSENT_OFF_REASON } from '@/lib/buddy-tab-view'
import { cohostEnableRelayPatch, mergeAutoChatRelayPatch } from '@/lib/cohost-state'
import type { CohostAutoChatMode } from '../../../../shared/backend'
import type { AgentToolExecutor } from './agent'

export const BUDDY_TOOL_COPY = {
  empty: 'Say what to change: on, chatMode or onStream.',
  unavailable: "Buddy isn't available in this Studio.",
  loading: 'Loading your Buddy settings… Try again in a moment.',
  premium: 'Buddy requires Videorc Premium.',
  consent: BUDDY_CONSENT_OFF_REASON
} as const

const MODES: readonly CohostAutoChatMode[] = ['off', 'suggest', 'auto']

export const setBuddy: AgentToolExecutor = async (context, args) => {
  const on = typeof args.on === 'boolean' ? args.on : undefined
  const chatMode = MODES.find((mode) => mode === args.chatMode)
  const onStream = typeof args.onStream === 'boolean' ? args.onStream : undefined
  if (on === undefined && chatMode === undefined && onStream === undefined) {
    return { ok: false, message: BUDDY_TOOL_COPY.empty }
  }
  const buddy = context.buddy
  if (!buddy) return { ok: false, message: BUDDY_TOOL_COPY.unavailable }
  const current = buddy.settings
  if ((on !== undefined || chatMode !== undefined) && !current) {
    return { ok: false, message: BUDDY_TOOL_COPY.loading }
  }
  // Turning Buddy on, or choosing how it posts, is Buddy Live: Premium, and
  // the Cloud AI consent only the streamer can give. Off is always allowed.
  const turningOn = on === true && current?.enabled !== true
  if ((turningOn || chatMode !== undefined) && !buddy.entitled) {
    return { ok: false, message: buddy.entitlementReason ?? BUDDY_TOOL_COPY.premium }
  }
  if (turningOn && !buddy.consented) {
    return { ok: false, message: BUDDY_TOOL_COPY.consent }
  }

  const said: string[] = []
  let saved = current
  if (on !== undefined || chatMode !== undefined) {
    const autoChat = chatMode
      ? mergeAutoChatRelayPatch(current?.autoChat ?? null, { mode: chatMode })
      : null
    const patch = cohostEnableRelayPatch(
      current,
      { enabled: on ?? current?.enabled === true },
      autoChat
    )
    if (Object.keys(patch).length > 0) saved = await buddy.saveSettings(patch)
    if (on !== undefined) said.push(on ? 'Buddy Live is on.' : 'Buddy Live is off.')
    if (chatMode) said.push(`Chat posting: ${BUDDY_MODE_LABELS[chatMode]}.`)
  }
  if (onStream !== undefined) {
    if (onStream !== buddy.showOnStream) await buddy.setShowOnStream(onStream)
    said.push(onStream ? 'Buddy is on stream.' : 'Buddy is off the stream.')
  }
  return {
    ok: true,
    message: said.join(' '),
    result: {
      on: saved?.enabled === true,
      chatMode: saved?.autoChat?.mode ?? 'off',
      onStream: onStream ?? buddy.showOnStream
    }
  }
}
