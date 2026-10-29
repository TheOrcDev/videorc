// `set_buddy` (plan 209 S13, plan 211 D12): Buddy Live on or off, how Buddy
// talks (`talk`: off, bubble or suggest) and whether it is on stream, saved
// exactly as the Stream Manager's commands save them. The save is
// `cohostEnableRelayPatch`: `enabled` only when it changes, the talk mode
// merged into the stored block so the templates and cooldowns stay, and
// never the microphone (listening is the streamer's own choice, with its own
// disclosure). Turning Buddy Live on needs Premium and the streamer's Cloud
// AI consent, which an agent cannot give; `talk` needs neither.

import { BUDDY_TALK_LABELS, BUDDY_TALK_MODES, buddyTalkLabel } from '@/lib/buddy-auto-chat-view'
import { BUDDY_CONSENT_OFF_REASON } from '@/lib/buddy-tab-view'
import { cohostEnableRelayPatch, mergeAutoChatRelayPatch } from '@/lib/cohost-state'
import type { AgentToolExecutor } from './agent'

export const BUDDY_TOOL_COPY = {
  empty: 'Say what to change: on, talk or onStream.',
  unavailable: "Buddy isn't available in this Studio.",
  loading: 'Loading your Buddy settings… Try again in a moment.',
  premium: 'Buddy requires Videorc Premium.',
  consent: BUDDY_CONSENT_OFF_REASON,
  // Plan 211 D12: the old `chatMode` argument. The catalog keeps it as a
  // string of any value so an agent holding the old schema reads these
  // sentences instead of a schema error.
  autoGone: 'Auto is gone: Buddy never posts in chat on its own. Use talk: bubble.',
  chatMode: 'chatMode is now talk: off, bubble or suggest.'
} as const

export const setBuddy: AgentToolExecutor = async (context, args) => {
  const on = typeof args.on === 'boolean' ? args.on : undefined
  if ('chatMode' in args) {
    return {
      ok: false,
      message: args.chatMode === 'auto' ? BUDDY_TOOL_COPY.autoGone : BUDDY_TOOL_COPY.chatMode
    }
  }
  const talk = BUDDY_TALK_MODES.find((mode) => mode === args.talk)
  const onStream = typeof args.onStream === 'boolean' ? args.onStream : undefined
  if (on === undefined && talk === undefined && onStream === undefined) {
    return { ok: false, message: BUDDY_TOOL_COPY.empty }
  }
  const buddy = context.buddy
  if (!buddy) return { ok: false, message: BUDDY_TOOL_COPY.unavailable }
  const current = buddy.settings
  if ((on !== undefined || talk !== undefined) && !current) {
    return { ok: false, message: BUDDY_TOOL_COPY.loading }
  }
  // Only turning Buddy Live on is gated: Premium, and the Cloud AI consent
  // only the streamer can give. `talk` takes the Stream Manager control's own
  // gate (Buddy present, settings loaded) and never Premium: Bubble with the
  // built-in lines is free (plan 211 D12). Off is always allowed.
  const turningOn = on === true && current?.enabled !== true
  if (turningOn && !buddy.entitled) {
    return { ok: false, message: buddy.entitlementReason ?? BUDDY_TOOL_COPY.premium }
  }
  if (turningOn && !buddy.consented) {
    return { ok: false, message: BUDDY_TOOL_COPY.consent }
  }

  const said: string[] = []
  let saved = current
  if (on !== undefined || talk !== undefined) {
    const autoChat = talk ? mergeAutoChatRelayPatch(current?.autoChat ?? null, { talk }) : null
    const patch = cohostEnableRelayPatch(
      current,
      { enabled: on ?? current?.enabled === true },
      autoChat
    )
    if (Object.keys(patch).length > 0) saved = await buddy.saveSettings(patch)
    if (on !== undefined) said.push(on ? 'Buddy Live is on.' : 'Buddy Live is off.')
    if (talk) said.push(`${buddyTalkLabel(current?.persona?.name)}: ${BUDDY_TALK_LABELS[talk]}.`)
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
      talk: saved?.autoChat?.talk ?? 'bubble',
      onStream: onStream ?? buddy.showOnStream
    }
  }
}
