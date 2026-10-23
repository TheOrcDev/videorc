// The soundboard's keys on the Studio page (plan 189): 1 to 9 with no
// modifier press the sound with that key, and a While held sound stops when
// its key comes up. Like Space (studio-space-shortcut.ts) they exist only on
// the Studio page, and they yield to anything that already owns the key: a
// field or a list that types or picks with it, an open dialog or menu, and a
// stage gesture in flight. A button does not own a digit, so a focused pad
// still lets the keys through.

import type { Sound } from './backend'
import { SPACE_SHORTCUT_MODAL_SELECTOR } from './studio-space-shortcut'

/** A target inside any of these takes digits itself (typing, typeahead). */
export const SOUND_KEY_WIDGET_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="spinbutton"]',
  '[role="slider"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="dialog"]',
  '[role="alertdialog"]'
].join(', ')

/**
 * True when a key press must be left alone: a repeat (a held key presses
 * once), an already handled or modified press, a target that takes digits,
 * or an open modal surface.
 */
export function soundKeyBlocked(
  event: Pick<
    KeyboardEvent,
    'repeat' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'
  >,
  root: Pick<Document, 'querySelector'>
): boolean {
  if (event.repeat || event.defaultPrevented) return true
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true
  const target = event.target
  if (target instanceof Element && target.closest(SOUND_KEY_WIDGET_SELECTOR)) return true
  return root.querySelector(SPACE_SHORTCUT_MODAL_SELECTOR) !== null
}

/** The sound a key plays, if any: its own key, 1 to 9. */
export function soundForKey<T extends Pick<Sound, 'hotkey'>>(
  key: string,
  sounds: readonly T[]
): T | undefined {
  return /^[1-9]$/.test(key) ? sounds.find((sound) => sound.hotkey === key) : undefined
}
