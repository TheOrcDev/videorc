// Plan 062: what the Settings shortcut recorder does with one key event.
// Pure so every outcome (commit, cancel, clear, each refusal and its copy)
// is unit-tested without a DOM; the component only applies the step.

import {
  acceleratorDisplayKeys,
  acceleratorFromKeyInput,
  validateAccelerator,
  type AcceleratorKeyInput,
  type AcceleratorModifier
} from '../../../shared/accelerator'

export type ShortcutRecorderStep =
  | { type: 'held'; modifiers: AcceleratorModifier[] }
  | { type: 'commit'; accelerator: string }
  | { type: 'cancel' }
  | { type: 'clear' }
  | { type: 'reject'; message: string }

const isMac = (platform: string | undefined): boolean => platform === 'darwin'

/** How a combination reads in running copy: "⌘M" on macOS, "Ctrl+M" elsewhere. */
export function acceleratorInlineLabel(accelerator: string, platform: string | undefined): string {
  return acceleratorDisplayKeys(accelerator, platform).join(isMac(platform) ? '' : '+')
}

export function shortcutRecorderStep(
  input: AcceleratorKeyInput,
  platform: string | undefined,
  /** The caller's own refusal, e.g. "Already used by Screen + Cam." */
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
      return { type: 'reject', message: 'That key cannot be part of a shortcut. Try another.' }
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
      const refusal = validate(result.accelerator)
      return refusal
        ? { type: 'reject', message: refusal }
        : { type: 'commit', accelerator: result.accelerator }
    }
  }
}
