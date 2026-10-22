// How a stored Electron accelerator reads, per platform (plan 062; plan 174
// S1.2). Split from accelerator.ts so the renderer's eager shell (status bar,
// sidebar, ⌘K) can print shortcuts without the recorder and validation code.
// Pure and shared: the renderer, the main process and tests all read it.

export type AcceleratorModifier = 'Cmd' | 'Ctrl' | 'Alt' | 'Shift' | 'Super'

const isMac = (platform: string | undefined): boolean => platform === 'darwin'

// Saved order. Electron ignores order, but one spelling per binding keeps
// duplicate detection and diffs honest.
export const MODIFIER_ORDER: readonly AcceleratorModifier[] = [
  'Cmd',
  'Ctrl',
  'Alt',
  'Shift',
  'Super'
]
// macOS menus print modifiers as ⌃⌥⇧⌘; Windows prints Ctrl+Alt+Shift+Win.
const MAC_DISPLAY_ORDER: readonly AcceleratorModifier[] = ['Ctrl', 'Alt', 'Shift', 'Cmd']
const OTHER_DISPLAY_ORDER: readonly AcceleratorModifier[] = ['Ctrl', 'Alt', 'Shift', 'Super']

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  plus: 'Plus'
}

export interface ParsedAccelerator {
  modifiers: AcceleratorModifier[]
  key: string
}

/**
 * Reads any Electron accelerator spelling, including hand-typed values saved
 * before plan 062 (`Command+Shift+R`, `Control+Alt+C`, `CmdOrCtrl+K`).
 * Returns null for an empty value or one without exactly one key.
 */
export function parseAccelerator(
  value: string | undefined,
  platform: string | undefined
): ParsedAccelerator | null {
  const parts = (value ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const held = new Set<AcceleratorModifier>()
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'command' || lower === 'cmd') {
      // Electron gives Command no effect off macOS; everything Videorc has
      // ever displayed there reads it as Ctrl, so that is what it means.
      held.add(isMac(platform) ? 'Cmd' : 'Ctrl')
    } else if (lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      held.add(isMac(platform) ? 'Cmd' : 'Ctrl')
    } else if (lower === 'control' || lower === 'ctrl') {
      held.add('Ctrl')
    } else if (lower === 'alt' || lower === 'option' || lower === 'altgr') {
      held.add('Alt')
    } else if (lower === 'shift') {
      held.add('Shift')
    } else if (lower === 'super' || lower === 'meta') {
      held.add(isMac(platform) ? 'Cmd' : 'Super')
    } else if (key === null) {
      key = part.length === 1 ? part.toUpperCase() : (KEY_ALIASES[lower] ?? canonicalKey(part))
    } else {
      return null
    }
  }
  if (key === null) return null
  return { modifiers: MODIFIER_ORDER.filter((modifier) => held.has(modifier)), key }
}

function canonicalKey(part: string): string {
  const fn = /^f(\d{1,2})$/i.exec(part)
  if (fn) return `F${Number(fn[1])}`
  if (/^num/i.test(part)) return part.toLowerCase()
  return part
}

const MAC_MODIFIER_GLYPHS: Record<AcceleratorModifier, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Super: '⌘'
}
const OTHER_MODIFIER_LABELS: Record<AcceleratorModifier, string> = {
  Cmd: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Win'
}
// macOS draws its own key glyphs; Windows and Linux say the key's name
// ("Enter", "Backspace", "Delete", "Space"), never a Mac glyph (I-18).
const MAC_KEY_GLYPHS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↵',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  Escape: 'Esc',
  Plus: '+'
}
const OTHER_KEY_GLYPHS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Escape: 'Esc',
  Plus: '+'
}

export function acceleratorModifierLabels(
  modifiers: readonly AcceleratorModifier[],
  platform: string | undefined
): string[] {
  const order = isMac(platform) ? MAC_DISPLAY_ORDER : OTHER_DISPLAY_ORDER
  const labels = isMac(platform) ? MAC_MODIFIER_GLYPHS : OTHER_MODIFIER_LABELS
  const present = new Set(
    modifiers.map((modifier) =>
      !isMac(platform) && modifier === 'Cmd'
        ? 'Ctrl'
        : isMac(platform) && modifier === 'Super'
          ? 'Cmd'
          : modifier
    )
  )
  return order.filter((modifier) => present.has(modifier)).map((modifier) => labels[modifier])
}

/**
 * A modifier named alone (`Shift`, `Alt`), as a hint for a drag ("Shift
 * constrains"), or null when the value names a key too.
 */
function parseModifiersOnly(
  value: string | undefined,
  platform: string | undefined
): AcceleratorModifier[] | null {
  const parts = (value ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const held = new Set<AcceleratorModifier>()
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'cmdorctrl' || lower === 'commandorcontrol' || lower === 'cmd') {
      held.add(isMac(platform) ? 'Cmd' : 'Ctrl')
    } else if (lower === 'ctrl' || lower === 'control') held.add('Ctrl')
    else if (lower === 'alt' || lower === 'option') held.add('Alt')
    else if (lower === 'shift') held.add('Shift')
    else return null
  }
  return MODIFIER_ORDER.filter((modifier) => held.has(modifier))
}

/** Stored accelerator → its parts in display order (`['⇧','⌘','M']`, `['Ctrl','Shift','M']`). */
export function acceleratorDisplayKeys(
  accelerator: string | undefined,
  platform: string | undefined
): string[] {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) {
    const modifiers = parseModifiersOnly(accelerator, platform)
    if (modifiers) return acceleratorModifierLabels(modifiers, platform)
    return accelerator?.trim() ? [accelerator.trim()] : []
  }
  const keyGlyphs = isMac(platform) ? MAC_KEY_GLYPHS : OTHER_KEY_GLYPHS
  return [
    ...acceleratorModifierLabels(parsed.modifiers, platform),
    keyGlyphs[parsed.key] ?? parsed.key
  ]
}

/**
 * The one way a combination reads, in a keycap or in running copy: macOS
 * glyphs in system order with no separator ("⇧⌘J", "⌘↵", "Space"); words
 * joined by "+" elsewhere ("Ctrl+Shift+J", "Ctrl+Enter", "Backspace").
 */
export function acceleratorLabel(
  accelerator: string | undefined,
  platform: string | undefined
): string {
  return acceleratorDisplayKeys(accelerator, platform).join(isMac(platform) ? '' : '+')
}

/** Modifiers held mid-press, with no key yet: "⇧⌘" on macOS, "Ctrl+Shift" elsewhere. */
export function acceleratorModifiersLabel(
  modifiers: readonly AcceleratorModifier[],
  platform: string | undefined
): string {
  return acceleratorModifierLabels(modifiers, platform).join(isMac(platform) ? '' : '+')
}

const ARIA_MODIFIERS: Record<AcceleratorModifier, string> = {
  Ctrl: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
  Cmd: 'Meta',
  Super: 'Meta'
}
const ARIA_MODIFIER_ORDER: readonly AcceleratorModifier[] = ['Ctrl', 'Alt', 'Shift', 'Cmd', 'Super']
const ARIA_KEYS: Record<string, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Plus: '+'
}

/**
 * The `aria-keyshortcuts` value (UI Events key names): Meta on macOS, Control
 * elsewhere, as the keys really are (A-5). Empty when nothing parses.
 */
export function acceleratorAriaKeyShortcuts(
  accelerator: string | undefined,
  platform: string | undefined
): string {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return ''
  const modifiers = ARIA_MODIFIER_ORDER.filter((modifier) =>
    parsed.modifiers.includes(modifier)
  ).map((modifier) => ARIA_MODIFIERS[modifier])
  return [...new Set(modifiers), ARIA_KEYS[parsed.key] ?? parsed.key].join('+')
}

/**
 * The platform's command modifier is down: ⌘ on macOS, Ctrl elsewhere. A
 * shell shortcut takes only that key, so ⌃K and ⌃P stay text editing on a
 * Mac (A-17). Electron `Input` and DOM events both map onto the two flags.
 */
export function commandModifierHeld(
  input: { meta: boolean; control: boolean },
  platform: string | undefined
): boolean {
  return isMac(platform) ? input.meta : input.control
}
