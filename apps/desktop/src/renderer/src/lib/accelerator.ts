export type AcceleratorModifier = 'Cmd' | 'Ctrl' | 'Alt' | 'Shift' | 'Super'

// How an Electron accelerator reads, per platform: "⇧⌘J" on macOS,
// "Ctrl+Shift+J" elsewhere. Shortcuts are authored once as accelerators
// (`CmdOrCtrl+Shift+J`) and printed through ShortcutKeys or shortcutLabel.
// Pure: no DOM, no React.

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
  backspace: 'Backspace',
  delete: 'Delete',
  down: 'Down',
  end: 'End',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  home: 'Home',
  insert: 'Insert',
  left: 'Left',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  plus: 'Plus',
  return: 'Enter',
  right: 'Right',
  space: 'Space',
  tab: 'Tab',
  up: 'Up'
}

export interface ParsedAccelerator {
  modifiers: AcceleratorModifier[]
  key: string
}

/**
 * The modifier one accelerator part names, or null for a key. Electron gives
 * Command no effect off macOS; it has always read as Ctrl there, so that is
 * what it means.
 */
function modifierFor(lower: string, platform: string | undefined): AcceleratorModifier | null {
  switch (lower) {
    case 'command':
    case 'cmd':
    case 'commandorcontrol':
    case 'cmdorctrl': {
      return isMac(platform) ? 'Cmd' : 'Ctrl'
    }
    case 'control':
    case 'ctrl': {
      return 'Ctrl'
    }
    case 'alt':
    case 'option':
    case 'altgr': {
      return 'Alt'
    }
    case 'shift': {
      return 'Shift'
    }
    case 'super':
    case 'meta': {
      return isMac(platform) ? 'Cmd' : 'Super'
    }
    default: {
      return null
    }
  }
}

const FUNCTION_KEY = /^f\d{1,2}$/iu
const NUMPAD_KEY = /^num/iu

function canonicalKey(part: string): string {
  if (FUNCTION_KEY.test(part)) {
    return `F${Number(part.slice(1))}`
  }
  if (NUMPAD_KEY.test(part)) {
    return part.toLowerCase()
  }
  return part
}

const keyFor = (part: string): string =>
  part.length === 1 ? part.toUpperCase() : (KEY_ALIASES[part.toLowerCase()] ?? canonicalKey(part))

/**
 * Reads any Electron accelerator spelling, including values typed by hand
 * (`Command+Shift+R`, `Control+Alt+C`, `CmdOrCtrl+K`). Returns null for an
 * empty value or one without exactly one key.
 */
export function parseAccelerator(
  value: string | undefined,
  platform: string | undefined
): ParsedAccelerator | null {
  const parts = (value ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return null
  }
  const held = new Set<AcceleratorModifier>()
  let key: string | null = null
  for (const part of parts) {
    const modifier = modifierFor(part.toLowerCase(), platform)
    if (modifier) {
      held.add(modifier)
    } else if (key === null) {
      key = keyFor(part)
    } else {
      return null
    }
  }
  if (key === null) {
    return null
  }
  return {
    key,
    modifiers: MODIFIER_ORDER.filter((modifier) => held.has(modifier))
  }
}

const MAC_MODIFIER_GLYPHS: Record<AcceleratorModifier, string> = {
  Alt: '⌥',
  Cmd: '⌘',
  Ctrl: '⌃',
  Shift: '⇧',
  Super: '⌘'
}
const OTHER_MODIFIER_LABELS: Record<AcceleratorModifier, string> = {
  Alt: 'Alt',
  Cmd: 'Ctrl',
  Ctrl: 'Ctrl',
  Shift: 'Shift',
  Super: 'Win'
}
// macOS draws its own key glyphs; Windows and Linux say the key's name
// ("Enter", "Backspace", "Delete", "Space"), never a Mac glyph (I-18).
const MAC_KEY_GLYPHS: Record<string, string> = {
  Backspace: '⌫',
  Delete: '⌦',
  Down: '↓',
  Enter: '↵',
  Escape: 'Esc',
  Left: '←',
  Plus: '+',
  Right: '→',
  Tab: '⇥',
  Up: '↑'
}
const OTHER_KEY_GLYPHS: Record<string, string> = {
  Down: '↓',
  Escape: 'Esc',
  Left: '←',
  Plus: '+',
  Right: '→',
  Up: '↑'
}

export function acceleratorModifierLabels(
  modifiers: readonly AcceleratorModifier[],
  platform: string | undefined
): string[] {
  const order = isMac(platform) ? MAC_DISPLAY_ORDER : OTHER_DISPLAY_ORDER
  const labels = isMac(platform) ? MAC_MODIFIER_GLYPHS : OTHER_MODIFIER_LABELS
  // Cmd reads as Ctrl off macOS, and Super as Cmd on it.
  const displayed = (modifier: AcceleratorModifier): AcceleratorModifier => {
    if (!isMac(platform) && modifier === 'Cmd') {
      return 'Ctrl'
    }
    if (isMac(platform) && modifier === 'Super') {
      return 'Cmd'
    }
    return modifier
  }
  const present = new Set(modifiers.map(displayed))
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
  if (parts.length === 0) {
    return null
  }
  const held = new Set<AcceleratorModifier>()
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'cmdorctrl' || lower === 'commandorcontrol' || lower === 'cmd') {
      held.add(isMac(platform) ? 'Cmd' : 'Ctrl')
    } else if (lower === 'ctrl' || lower === 'control') {
      held.add('Ctrl')
    } else if (lower === 'alt' || lower === 'option') {
      held.add('Alt')
    } else if (lower === 'shift') {
      held.add('Shift')
    } else {
      return null
    }
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
    if (modifiers) {
      return acceleratorModifierLabels(modifiers, platform)
    }
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
  Alt: 'Alt',
  Cmd: 'Meta',
  Ctrl: 'Control',
  Shift: 'Shift',
  Super: 'Meta'
}
const ARIA_MODIFIER_ORDER: readonly AcceleratorModifier[] = ['Ctrl', 'Alt', 'Shift', 'Cmd', 'Super']
const ARIA_KEYS: Record<string, string> = {
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Plus: '+',
  Right: 'ArrowRight',
  Up: 'ArrowUp'
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
  if (!parsed) {
    return ''
  }
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
