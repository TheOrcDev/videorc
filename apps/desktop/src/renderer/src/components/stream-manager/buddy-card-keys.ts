import { useEffect } from 'react'

// One window-level listener for every Buddy card's keys (plan 174 S3.14c,
// H-23), with one precedence: a voice command card answers first (the newest
// thing the streamer did), then a removal card (destructive and timed), then
// a proposed post (the least urgent). Each open card registers one handler
// that answers true when it took the key; the first taker wins, so two open
// cards never both answer Enter or Esc. The listener sits in the bubble phase:
// the composer, a menu or a focused row has its say first, and a key another
// handler took (`defaultPrevented`) stays taken.

export type BuddyCardKind = 'command' | 'removal' | 'utterance'

/** Who answers a window-level key first, when several cards are open. */
export const BUDDY_CARD_PRECEDENCE: readonly BuddyCardKind[] = ['command', 'removal', 'utterance']

/** Answers true when the card took the key (and prevented its default). */
export type BuddyCardKeyHandler = (event: KeyboardEvent) => boolean

const handlers = new Map<BuddyCardKind, BuddyCardKeyHandler>()
let listening = false

/** Pure: of the kinds registered, the one that answers a key first. */
export function buddyCardKeyTaker(registered: readonly BuddyCardKind[]): BuddyCardKind | null {
  return BUDDY_CARD_PRECEDENCE.find((kind) => registered.includes(kind)) ?? null
}

function onWindowKeyDown(event: KeyboardEvent): void {
  for (const kind of BUDDY_CARD_PRECEDENCE) {
    const handler = handlers.get(kind)
    if (handler?.(event)) return
  }
}

/**
 * Registers a card kind's handler (one per kind: the topmost card of that
 * kind) and returns the way to unregister it. The window listener exists
 * only while a card is registered.
 */
export function registerBuddyCardKeys(
  kind: BuddyCardKind,
  handler: BuddyCardKeyHandler
): () => void {
  handlers.set(kind, handler)
  if (!listening) {
    window.addEventListener('keydown', onWindowKeyDown)
    listening = true
  }
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind)
    if (handlers.size === 0 && listening) {
      window.removeEventListener('keydown', onWindowKeyDown)
      listening = false
    }
  }
}

/** The registration as an effect: `null` while the card has nothing to answer. */
export function useBuddyCardKeys(kind: BuddyCardKind, handler: BuddyCardKeyHandler | null): void {
  useEffect(() => (handler ? registerBuddyCardKeys(kind, handler) : undefined), [kind, handler])
}
