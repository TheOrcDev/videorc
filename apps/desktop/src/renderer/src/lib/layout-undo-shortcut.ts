import { isCommandKey } from '@/lib/platform'

// ⌘Z on the Scene page (plan 174 S3.9, D15): a single-level undo of the last
// committed layout change. The Scene page alone listens, and it yields to
// anything that owns the key already: a text field (the app menu's Edit →
// Undo role sends the native undo there), an open dialog or menu, and a stage
// gesture or commit in flight. ⇧⌘Z (redo) and ⌥⌘Z are not it.

/** A target inside one of these edits text: its own undo wins. */
export const LAYOUT_UNDO_EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="textbox"]'

/** While one of these is open anywhere, the key belongs to it. */
export const LAYOUT_UNDO_MODAL_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[data-videorc-stage-phase="dragging"]',
  '[data-videorc-stage-phase="pending"]'
].join(', ')

/** True for the platform's undo chord alone: ⌘Z on macOS, Ctrl+Z elsewhere. */
export function isLayoutUndoShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform?: string
): boolean {
  return (
    event.key.toLowerCase() === 'z' &&
    !event.shiftKey &&
    !event.altKey &&
    isCommandKey(event, platform)
  )
}

/**
 * True when an undo keydown must be left alone: a repeat, an already handled
 * press, a target that edits text, or an open modal surface or stage gesture.
 */
export function layoutUndoShortcutBlocked(
  event: Pick<KeyboardEvent, 'repeat' | 'defaultPrevented' | 'target'>,
  root: Pick<Document, 'querySelector'>
): boolean {
  if (event.repeat || event.defaultPrevented) return true
  const target = event.target
  if (target instanceof Element && target.closest(LAYOUT_UNDO_EDITABLE_SELECTOR)) return true
  return root.querySelector(LAYOUT_UNDO_MODAL_SELECTOR) !== null
}
