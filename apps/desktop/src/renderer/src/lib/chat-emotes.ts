import type { LiveChatMessageFragment } from '@/lib/backend'

/** One emote image: its name (shown until the image is cached) and URL. */
export interface ChatEmoteImage {
  text: string
  url: string
}

/** One drawable piece of a message body. */
export type ChatMessagePiece =
  | { kind: 'text'; text: string }
  | { kind: 'emote'; emote: ChatEmoteImage; overlays: ChatEmoteImage[] }

/**
 * Folds each 7TV zero-width emote onto the emote before it, as 7TV draws
 * them (plan 089): `catJAM RainTime` is one image with rain over the cat. The
 * whitespace between the two is dropped. A zero-width emote with no emote
 * before it (first in the message, or after a word) is drawn inline like any
 * other emote.
 */
export function groupEmoteOverlays(
  fragments: readonly LiveChatMessageFragment[]
): ChatMessagePiece[] {
  const pieces: ChatMessagePiece[] = []
  // Whitespace-only text after an emote, held until we know whether a
  // zero-width emote follows it.
  let gap: string[] = []
  let lastEmote: Extract<ChatMessagePiece, { kind: 'emote' }> | null = null
  const flushGap = (): void => {
    for (const text of gap) pieces.push({ kind: 'text', text })
    gap = []
  }
  for (const fragment of fragments) {
    if (!fragment.imageUrl) {
      if (lastEmote && fragment.text.trim() === '') {
        gap.push(fragment.text)
        continue
      }
      flushGap()
      pieces.push({ kind: 'text', text: fragment.text })
      lastEmote = null
      continue
    }
    const emote = { text: fragment.text, url: fragment.imageUrl }
    if (fragment.zeroWidth && lastEmote) {
      lastEmote.overlays.push(emote)
      gap = []
      continue
    }
    flushGap()
    lastEmote = { kind: 'emote', emote, overlays: [] }
    pieces.push(lastEmote)
  }
  flushGap()
  return pieces
}
