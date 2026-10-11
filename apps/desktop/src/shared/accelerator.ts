// Plan 062: shortcuts are recorded by pressing them, never typed. This module
// is the one place that turns a key event into an Electron accelerator string
// and decides whether a combination may become a system-wide binding; with
// accelerator-format.ts it also renders a stored accelerator. Pure and
// shared: the Settings recorder, the scenes gallery and the main-process
// registration all read it.

import { MODIFIER_ORDER, parseAccelerator, type AcceleratorModifier } from './accelerator-format'
import { globalShortcutEntries, type GlobalShortcutAction } from './global-shortcuts'
import type { GlobalShortcutsConfig } from './backend'

// Reading and printing an accelerator lives in accelerator-format.ts (the
// eager shell prints shortcuts); it is re-exported here for every caller.
export {
  acceleratorAriaKeyShortcuts,
  acceleratorDisplayKeys,
  acceleratorLabel,
  acceleratorModifierLabels,
  acceleratorModifiersLabel,
  commandModifierHeld,
  parseAccelerator,
  type AcceleratorModifier,
  type ParsedAccelerator
} from './accelerator-format'

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
