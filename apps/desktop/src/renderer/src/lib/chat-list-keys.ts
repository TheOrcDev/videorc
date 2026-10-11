// The Stream Manager chat list's keyboard model (plan 174 S3.16a, H-7): one
// tab stop with roving focus, and single-key row actions. Pure: the list
// component asks what a key means and does the focusing and acting.
//
// Scoping mirrors `removal-cards.tsx` (`removalKeyAnswer`): a key answers
// only when it reached the list from one of its rows, never from a text
// field, a menu or a dialog inside it, never during IME composition, and
// never once another handler took it (`defaultPrevented`).

export type ChatRowMove = 'next' | 'previous' | 'first' | 'last'

export type ChatRowKeyCommand =
  | { kind: 'move'; move: ChatRowMove }
  | { kind: 'reply' }
  | { kind: 'copy' }
  | { kind: 'remove' }
  | { kind: 'composer' }

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const SELF_CLOSING = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]'

/**
 * What a key pressed on a chat row means, or null to leave it alone. ↑/↓,
 * Home and End move; Enter and Space are the row button's own click; R
 * replies, C copies, ⇧⌫ removes from chat; Esc returns to the composer.
 * ⌘L and ⌘F belong to the window, not the row.
 */
export function chatRowKeyCommand(
  event: {
    key: string
    shiftKey: boolean
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
    defaultPrevented: boolean
    isComposing?: boolean
    target: EventTarget | null
  },
  row: Element | null
): ChatRowKeyCommand | null {
  if (!row || event.defaultPrevented || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  const target = event.target instanceof Element ? event.target : null
  if (target && (target.closest(EDITABLE) || target.closest(SELF_CLOSING))) return null
  switch (event.key) {
    case 'ArrowDown':
      return event.shiftKey ? null : { kind: 'move', move: 'next' }
    case 'ArrowUp':
      return event.shiftKey ? null : { kind: 'move', move: 'previous' }
    case 'Home':
      return event.shiftKey ? null : { kind: 'move', move: 'first' }
    case 'End':
      return event.shiftKey ? null : { kind: 'move', move: 'last' }
    case 'Backspace':
    case 'Delete':
      return event.shiftKey ? { kind: 'remove' } : null
    case 'Escape':
      return { kind: 'composer' }
    default:
      break
  }
  if (event.shiftKey) return null
  switch (event.key.toLowerCase()) {
    case 'r':
      return { kind: 'reply' }
    case 'c':
      return { kind: 'copy' }
    default:
      return null
  }
}

/** The row index a move lands on; null for an empty list. */
export function chatRowAfterMove(count: number, index: number, move: ChatRowMove): number | null {
  if (count <= 0) return null
  if (move === 'first') return 0
  if (move === 'last') return count - 1
  if (index < 0 || index >= count) return move === 'next' ? 0 : count - 1
  const next = move === 'next' ? index + 1 : index - 1
  return Math.min(count - 1, Math.max(0, next))
}

/**
 * A mouse drag that ends with words selected inside the row is not a click
 * (owner call, plan 174 D10): copying a message's text never puts it on
 * stream. Any other click, including one that only cleared a selection or
 * selected text elsewhere, still is.
 */
export function clickSelectsText(
  selection: { isCollapsed: boolean; anchorNode: Node | null; toString: () => string } | null,
  row: { contains: (node: Node | null) => boolean }
): boolean {
  if (!selection || selection.isCollapsed) return false
  if (selection.toString().trim() === '') return false
  return row.contains(selection.anchorNode)
}
