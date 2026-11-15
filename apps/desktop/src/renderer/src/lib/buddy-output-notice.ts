// The Buddy pane's "not on stream" notice: Buddy would talk (Buddy Live is
// on, or it talks in its bubble) and the picture is going out, yet neither
// Buddy switch (`overlayLayout.buddy.showOnStream`, `showInRecording`) is on,
// so viewers never see the pet, its bubbles or its reactions. One pure
// decision for the Stream Manager's Buddy pane, which is where the streamer
// is while live; the Buddy page has its own note for the idle case
// (`buddy-tab.tsx`).
//
// The 2026-10-21 stream: Buddy Live ran the whole session, greeted viewers
// and read chat, while the on-stream switch had been off since an old launch
// bug cleared it (#705). Nothing in the Stream Manager said so.
//
// Plan 211 D9: Bubble greets without Buddy Live (the built-in lines are
// free), and says nothing while Buddy is on no output, so the notice shows
// in Bubble whether or not Buddy Live is on.
//
// Plan 239 D3: Sidekick writes and the avatar says. While Sidekick Live is on
// and it writes lines (Answers, Banter or AI greetings) in Bubble with the
// avatar on no output, those lines have nowhere to show: the notice then
// says so and offers "Use Suggest" beside "Show on stream", so they become
// cards the streamer posts. The engine is unchanged; the choice is theirs.

import type { CohostTalkMode } from '@/lib/backend'
import { DEFAULT_AVATAR_NAME } from '../../../shared/avatar-name'

export interface BuddyOutputNoticeInput {
  /** Buddy Live is on (the header's switch). */
  enabled: boolean
  /** How Buddy talks (`autoChat.talk`); unknown while the settings load. */
  talk?: CohostTalkMode | null
  /** The picture is going out: the window's session is on air. */
  onAir: boolean
  /** `overlayLayout.buddy.showOnStream`; unknown while the relay has no Buddy. */
  showOnStream: boolean | null | undefined
  /** `overlayLayout.buddy.showInRecording`; an older Studio seed omits it. */
  showInRecording?: boolean | null
  /** The Buddy's name, or null before the persona arrives. */
  name: string | null
  /**
   * Sidekick writes lines on its own (plan 239 D3): Answers, Banter, or
   * greetings written with AI is on. Absent reads as no.
   */
  sidekickWrites?: boolean
}

export interface BuddyOutputNotice {
  /** "{name} isn't on stream." */
  title: string
  /** Why it matters, in one plain line. */
  detail: string
  /** The one-click way out: the same switch the footer holds. */
  action: string
  /**
   * The other way out (plan 239 D3), only while Sidekick writes in Bubble:
   * "Use Suggest", through the talk control's own consent.
   */
  secondaryAction?: string
}

/**
 * The notice to show, or null while Buddy would say nothing (Buddy Live off
 * and not on Bubble), nothing is on air, the relay has no Buddy yet, or at
 * least one output already carries it. In Bubble the detail says the cost:
 * Bubble says nothing while nobody can see it.
 */
export function buddyOffOutputsNotice(input: BuddyOutputNoticeInput): BuddyOutputNotice | null {
  const bubble = input.talk === 'bubble'
  if (!(input.enabled || bubble) || !input.onAir) return null
  if (typeof input.showOnStream !== 'boolean') return null
  if (input.showOnStream || input.showInRecording === true) return null
  const name = input.name?.trim() || DEFAULT_AVATAR_NAME
  if (bubble && input.enabled && input.sidekickWrites === true) {
    return {
      title: `${name} isn't on stream.`,
      detail:
        "Viewers can't see its bubble, so Sidekick's lines have nowhere to show. Show it, or use Suggest to post them as cards.",
      action: 'Show on stream',
      secondaryAction: 'Use Suggest'
    }
  }
  return {
    title: `${name} isn't on stream.`,
    detail: bubble
      ? "Viewers can't see its bubble, so Bubble says nothing."
      : "Viewers can't see it, its bubbles or its reactions.",
    action: 'Show on stream'
  }
}

/**
 * Whether Sidekick writes lines on its own (plan 239 D3): Answers, Banter,
 * or greetings written with AI. The greeting lines alone are the avatar's.
 */
export function sidekickWritesLines(
  autoChat:
    | {
        answers: { enabled: boolean }
        banter: { enabled: boolean }
        greetings: { enabled: boolean; ai?: boolean }
      }
    | null
    | undefined
): boolean {
  if (!autoChat) return false
  return (
    autoChat.answers.enabled ||
    autoChat.banter.enabled ||
    (autoChat.greetings.enabled && autoChat.greetings.ai !== false)
  )
}
