// Plan 062: what the Settings shortcut recorder does with one key event.
// Pure so every outcome (commit, cancel, clear, each refusal and its copy)
// is unit-tested without a DOM; the component only applies the step.

import {
  acceleratorFromKeyInput,
  acceleratorLabel,
  normalizeAccelerator,
  validateAccelerator,
  type AcceleratorKeyInput,
  type AcceleratorModifier
} from '../../../shared/accelerator'
import { SHORTCUTS, type ShortcutEntry } from './shortcuts'

export type ShortcutRecorderStep =
  | { type: 'held'; modifiers: AcceleratorModifier[] }
  | { type: 'commit'; accelerator: string }
  | { type: 'cancel' }
  | { type: 'clear' }
  | { type: 'reject'; message: string }

const isMac = (platform: string | undefined): boolean => platform === 'darwin'

/** How a combination reads in running copy: "⌘M" on macOS, "Ctrl+M" elsewhere. */
export function acceleratorInlineLabel(accelerator: string, platform: string | undefined): string {
  return acceleratorLabel(accelerator, platform)
}

/**
 * Videorc's own key for this combination, if it has one (plan 174 I-17). A
 * global binding takes the key from every app, Videorc included, so ⌘K or ⌘1
 * bound globally would stop opening Search or Studio.
 */
export function appShortcutOwner(
  accelerator: string,
  platform: string | undefined
): ShortcutEntry | null {
  const wanted = normalizeAccelerator(accelerator, platform)
  if (!wanted) return null
  return (
    SHORTCUTS.find((entry) =>
      entry.accelerators.some((key) => normalizeAccelerator(key, platform) === wanted)
    ) ?? null
  )
}

/**
 * The recorder's accessible name (plan 174 I-17): the action and its binding,
 * as the field shows it, so a screen reader hears what is set, not only how
 * to change it.
 */
export function shortcutRecorderName({
  label,
  value,
  armed,
  platform
}: {
  label: string
  value: string | undefined
  armed: boolean
  platform: string | undefined
}): string {
  if (armed) return `${label}: press the new shortcut`
  return `${label}: ${value ? acceleratorInlineLabel(value, platform) : 'Unassigned'}`
}

export function shortcutRecorderStep(
  input: AcceleratorKeyInput,
  platform: string | undefined,
  /** The caller's own refusal, e.g. "Already used by Screen + camera." */
  validate: (accelerator: string) => string | null
): ShortcutRecorderStep {
  const result = acceleratorFromKeyInput(input, platform)
  switch (result.kind) {
    case 'modifiers':
      return { type: 'held', modifiers: result.modifiers }
    case 'cancel':
    case 'clear':
      return { type: result.kind }
    case 'unsupported':
      return { type: 'reject', message: "That key can't be part of a shortcut. Try another." }
    case 'combo': {
      const verdict = validateAccelerator(result.accelerator, platform)
      if (!verdict.ok && verdict.reason === 'needs-modifier') {
        return {
          type: 'reject',
          message: isMac(platform)
            ? 'Add ⌘, ⌃ or ⌥ so the key still types in other apps.'
            : 'Add Ctrl, Alt or Win so the key still types in other apps.'
        }
      }
      if (!verdict.ok) {
        return {
          type: 'reject',
          message: `${acceleratorInlineLabel(result.accelerator, platform)} is a system shortcut in every app. Pick another.`
        }
      }
      const owner = appShortcutOwner(result.accelerator, platform)
      if (owner) {
        return {
          type: 'reject',
          message: `${acceleratorInlineLabel(result.accelerator, platform)} is Videorc's shortcut for “${owner.label}”. Pick another.`
        }
      }
      const refusal = validate(result.accelerator)
      return refusal
        ? { type: 'reject', message: refusal }
        : { type: 'commit', accelerator: result.accelerator }
    }
  }
}
