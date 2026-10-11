// One answer to "is something modal open?" (plan 174 S3.21, A-2). Every
// global key in the main window asks it before acting: ⌘1–⌘9 and ⌘, from
// main, the shell's own chords (⌘K, ⌘P, ⌘J…), Space on Studio and the theme
// key. Before, each handler kept its own partial list, and a key that
// navigated from under a dialog lost unsaved schedule edits and bypassed the
// OBS import lock.

/** An open floating surface that owns the keyboard: a dialog, an alert, a menu, an open select. */
export const MODAL_OPEN_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]'
].join(', ')

/** True while a dialog, an alert, a menu or a select is open anywhere in the window. */
export function isModalOpen(root: Pick<Document, 'querySelector'> = document): boolean {
  return root.querySelector(MODAL_OPEN_SELECTOR) !== null
}
