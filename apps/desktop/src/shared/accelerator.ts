// Plan 062: shortcuts are recorded by pressing them, never typed. This module
// is the one place that turns a key event into an Electron accelerator string,
// decides whether a combination may become a system-wide binding, and renders
// a stored accelerator as key chips. Pure and shared: the Settings recorder,
// the scenes gallery and the main-process registration all read it.

import { globalShortcutEntries, type GlobalShortcutAction } from './global-shortcuts'
import type { GlobalShortcutsConfig } from './backend'

export type AcceleratorModifier = 'Cmd' | 'Ctrl' | 'Alt' | 'Shift' | 'Super'

/** The subset of Electron's `Input` (and a DOM KeyboardEvent) the recorder needs. */
export interface AcceleratorKeyInput {
  type?: 'keyDown' | 'keyUp'
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

export type AcceleratorKeyResult =
  /** Only modifiers are held (or one was released): show them live. */
  | { kind: 'modifiers'; modifiers: AcceleratorModifier[] }
  | { kind: 'combo'; accelerator: string; modifiers: AcceleratorModifier[] }
  /** Esc with no modifiers. */
  | { kind: 'cancel' }
  /** Backspace or Delete with no modifiers. */
  | { kind: 'clear' }
  /** A key Electron has no accelerator name for (IME, media, AltGr …). */
  | { kind: 'unsupported'; modifiers: AcceleratorModifier[] }

export type AcceleratorValidation =
  | { ok: true }
  | { ok: false; reason: 'needs-modifier' | 'system-reserved' }

const isMac = (platform: string | undefined): boolean => platform === 'darwin'

// Saved order. Electron ignores order, but one spelling per binding keeps
// duplicate detection and diffs honest.
const MODIFIER_ORDER: readonly AcceleratorModifier[] = ['Cmd', 'Ctrl', 'Alt', 'Shift', 'Super']
// macOS menus print modifiers as ⌃⌥⇧⌘; Windows prints Ctrl+Alt+Shift+Win.
const MAC_DISPLAY_ORDER: readonly AcceleratorModifier[] = ['Ctrl', 'Alt', 'Shift', 'Cmd']
const OTHER_DISPLAY_ORDER: readonly AcceleratorModifier[] = ['Ctrl', 'Alt', 'Shift', 'Super']

const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'CapsLock',
  'Fn'
])

const NAMED_CODES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/**
 * Physical key → Electron key name. Uses `code`, not `key`: on macOS ⌥M
 * reports `key === 'µ'`, and a non-US layout would otherwise save a
 * character Electron cannot register.
 */
export function acceleratorKeyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return `num${numpad[1]}`
  const fn = /^F(\d{1,2})$/.exec(code)
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 24) return `F${Number(fn[1])}`
  return NAMED_CODES[code] ?? null
}

function heldModifiers(input: AcceleratorKeyInput, platform: string | undefined) {
  const held = new Set<AcceleratorModifier>()
  if (input.meta) held.add(isMac(platform) ? 'Cmd' : 'Super')
  if (input.control) held.add('Ctrl')
  if (input.alt) held.add('Alt')
  if (input.shift) held.add('Shift')
  return MODIFIER_ORDER.filter((modifier) => held.has(modifier))
}

/** One key event while the recorder is armed → what the recorder should do. */
export function acceleratorFromKeyInput(
  input: AcceleratorKeyInput,
  platform: string | undefined
): AcceleratorKeyResult {
  const modifiers = heldModifiers(input, platform)
  if (input.type === 'keyUp' || MODIFIER_CODES.has(input.code)) {
    return { kind: 'modifiers', modifiers }
  }
  if (modifiers.length === 0 && input.code === 'Escape') return { kind: 'cancel' }
  if (modifiers.length === 0 && (input.code === 'Backspace' || input.code === 'Delete')) {
    return { kind: 'clear' }
  }
  const key = acceleratorKeyFromCode(input.code)
  if (!key) return { kind: 'unsupported', modifiers }
  return { kind: 'combo', accelerator: [...modifiers, key].join('+'), modifiers }
}

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

interface ParsedAccelerator {
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

/**
 * One spelling per binding for this platform, or null when there is nothing
 * to register. Main registers this form, so a pre-062 `Cmd+Shift+R` on
 * Windows now binds Ctrl+Shift+R — what the UI always showed.
 */
export function normalizeAccelerator(
  value: string | undefined,
  platform: string | undefined
): string | null {
  const parsed = parseAccelerator(value, platform)
  return parsed ? [...parsed.modifiers, parsed.key].join('+') : null
}

// A global binding takes the key away from EVERY app, so these would break
// the machine rather than add a shortcut. Stored normalized.
const RESERVED: Record<'mac' | 'other', ReadonlySet<string>> = {
  mac: new Set([
    'Cmd+Q',
    'Cmd+W',
    'Cmd+H',
    'Cmd+M',
    'Cmd+Tab',
    'Cmd+Space',
    'Cmd+C',
    'Cmd+V',
    'Cmd+X',
    'Cmd+Z',
    'Cmd+Shift+Z',
    'Cmd+A'
  ]),
  other: new Set([
    'Ctrl+C',
    'Ctrl+V',
    'Ctrl+X',
    'Ctrl+Z',
    'Ctrl+Y',
    'Ctrl+A',
    'Alt+F4',
    'Alt+Tab',
    'Ctrl+Alt+Delete',
    'Ctrl+Shift+Escape'
  ])
}

export function validateAccelerator(
  accelerator: string,
  platform: string | undefined
): AcceleratorValidation {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return { ok: false, reason: 'needs-modifier' }
  const isFunctionKey = /^F\d{1,2}$/.test(parsed.key)
  // Shift alone does not count: a global Shift+M would take capital M away
  // from every app. A bare F-key is allowed because Stream Deck hotkeys
  // commonly send F13–F24, which no keyboard types with.
  const hasRealModifier = parsed.modifiers.some((modifier) => modifier !== 'Shift')
  if (!hasRealModifier && !isFunctionKey) return { ok: false, reason: 'needs-modifier' }
  const normalized = [...parsed.modifiers, parsed.key].join('+')
  if (RESERVED[isMac(platform) ? 'mac' : 'other'].has(normalized)) {
    return { ok: false, reason: 'system-reserved' }
  }
  return { ok: true }
}

/** The action that already holds this combination, if any other one does. */
export function findAcceleratorOwner(
  config: GlobalShortcutsConfig,
  accelerator: string,
  exceptAction: GlobalShortcutAction,
  platform: string | undefined
): GlobalShortcutAction | null {
  const wanted = normalizeAccelerator(accelerator, platform)
  if (!wanted) return null
  for (const [action, value] of globalShortcutEntries(config)) {
    if (action !== exceptAction && normalizeAccelerator(value, platform) === wanted) {
      return action
    }
  }
  return null
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
const MAC_KEY_GLYPHS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
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

/** Stored accelerator → the key chips to show (`['⌘','⇧','M']`, `['Ctrl','Shift','M']`). */
export function acceleratorDisplayKeys(
  accelerator: string | undefined,
  platform: string | undefined
): string[] {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return accelerator?.trim() ? [accelerator.trim()] : []
  const keyGlyphs = isMac(platform) ? MAC_KEY_GLYPHS : OTHER_KEY_GLYPHS
  return [
    ...acceleratorModifierLabels(parsed.modifiers, platform),
    keyGlyphs[parsed.key] ?? parsed.key
  ]
}
