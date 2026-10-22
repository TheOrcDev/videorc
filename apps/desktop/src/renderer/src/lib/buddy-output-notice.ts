// The Buddy pane's "not on stream" notice: Buddy Live is on and the picture
// is going out, yet neither Buddy switch (`overlayLayout.buddy.showOnStream`,
// `showInRecording`) is on, so viewers never see the pet, its bubbles or
// its reactions. One pure decision for the Stream Manager's Buddy pane, which
// is where the streamer is while live; the Buddy page has its own note for
// the idle case (`buddy-tab.tsx`).
//
// The 2026-10-21 stream: Buddy Live ran the whole session, greeted viewers
// and read chat, while the on-stream switch had been off since an old launch
// bug cleared it (#705). Nothing in the Stream Manager said so.

export interface BuddyOutputNoticeInput {
  /** Buddy Live is on (the header's switch). */
  enabled: boolean
  /** The picture is going out: the window's session is on air. */
  onAir: boolean
  /** `overlayLayout.buddy.showOnStream`; unknown while the relay has no Buddy. */
  showOnStream: boolean | null | undefined
  /** `overlayLayout.buddy.showInRecording`; an older Studio seed omits it. */
  showInRecording?: boolean | null
  /** The Buddy's name, or null before the persona arrives. */
  name: string | null
}

export interface BuddyOutputNotice {
  /** "{name} isn't on stream." */
  title: string
  /** Why it matters, in one plain line. */
  detail: string
  /** The one-click way out: the same switch the footer holds. */
  action: string
}

/**
 * The notice to show, or null while Buddy is off, nothing is on air, the
 * relay has no Buddy yet, or at least one output already carries it.
 */
export function buddyOffOutputsNotice(input: BuddyOutputNoticeInput): BuddyOutputNotice | null {
  if (!input.enabled || !input.onAir) return null
  if (typeof input.showOnStream !== 'boolean') return null
  if (input.showOnStream || input.showInRecording === true) return null
  const name = input.name?.trim() || 'Buddy'
  return {
    title: `${name} isn't on stream.`,
    detail: `Viewers can't see it, its bubbles or its reactions.`,
    action: 'Show on stream'
  }
}
