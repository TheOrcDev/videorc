// Space on the Studio page (plan 174 S0.1, D1): Record when idle, Stop
// recording while recording, and the End livestream question while live.
// It exists only on the Studio page, and it yields to anything that already
// owns the key: a focused control or widget, an open dialog, menu or list
// (the shell's one `isModalOpen`, S3.21), and a stage gesture in flight.

import { MODAL_OPEN_SELECTOR } from './modal-open'

/** A target inside any of these owns Space (or Enter) itself. */
export const SPACE_SHORTCUT_WIDGET_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

/** While one of these is open anywhere, Space belongs to it. */
export const SPACE_SHORTCUT_MODAL_SELECTOR = [
  MODAL_OPEN_SELECTOR,
  // Any list of options, open or part of the page: Space picks in it.
  '[role="listbox"]',
  '[data-videorc-stage-phase="dragging"]',
  '[data-videorc-stage-phase="pending"]'
].join(', ')

/**
 * True when a Space keydown must be left alone: a repeat, an already handled
 * or modified press, a target inside a widget, or an open modal surface.
 */
export function spaceShortcutBlocked(
  event: Pick<
    KeyboardEvent,
    'repeat' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'
  >,
  root: Pick<Document, 'querySelector'>
): boolean {
  if (event.repeat || event.defaultPrevented) {
    return true
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return true
  }
  const target = event.target
  if (target instanceof Element && target.closest(SPACE_SHORTCUT_WIDGET_SELECTOR)) {
    return true
  }
  return root.querySelector(SPACE_SHORTCUT_MODAL_SELECTOR) !== null
}
