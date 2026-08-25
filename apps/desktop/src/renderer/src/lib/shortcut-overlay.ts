import { isMacPlatform } from '@/lib/platform'

/**
 * The sidebar's shortcut layer: key chips stay hidden until the user reaches
 * for the command modifier, then fade in together.
 *
 * The shortcuts themselves are always live — the chips are only the reminder,
 * and a reminder that never goes away stops being read and starts being
 * noise. Holding ⌘ is also how people ASK "what can I press here", so the
 * chips arrive exactly when the question is asked.
 *
 * The state machine lives here rather than in the hook so it can be tested
 * without a DOM (the desktop suite runs in node, per vitest.config.ts).
 */

/** The physical key that opens the shortcut layer: ⌘ on macOS, Ctrl elsewhere. */
export type ModifierKey = 'Meta' | 'Control'

export function commandModifierKey(platform: string | undefined): ModifierKey {
  return isMacPlatform(platform) ? 'Meta' : 'Control'
}

/**
 * A DOM event reduced to only what the state machine needs. `modifierDown`
 * comes from `KeyboardEvent.getModifierState`, which reports the REAL state
 * of the key rather than what the last event implied — that is what lets a
 * missed event self-correct on the next one.
 */
export type ModifierProbe =
  | { kind: 'key'; modifierDown: boolean }
  | { kind: 'blur' }
  | { kind: 'visibility'; hidden: boolean }

/**
 * Next visibility state for the shortcut layer.
 *
 * `blur` and a hidden document both force it closed: when ⌘Tab, ⌘Q or a
 * native menu takes focus mid-press, the window never receives the `keyup`,
 * so without this the chips would stay stuck on until the next key press.
 */
export function nextModifierHeldState(current: boolean, probe: ModifierProbe): boolean {
  switch (probe.kind) {
    case 'key':
      return probe.modifierDown
    case 'blur':
      return false
    case 'visibility':
      return probe.hidden ? false : current
  }
}

/**
 * Presentation for one key chip in the sidebar. The chip is always MOUNTED —
 * hiding it with opacity keeps its width reserved, so rows do not reflow the
 * instant ⌘ goes down — and always `aria-hidden`, because the row's own
 * `aria-keyshortcuts` is what assistive tech reads. Reveal is a 100ms fade
 * (videorc-design motion: fast, subtle, no bounce) and is skipped entirely
 * under `prefers-reduced-motion`.
 */
export function shortcutChipProps(visible: boolean): {
  'aria-hidden': true
  'data-videorc-nav-shortcut': string
  'data-visible': 'true' | 'false'
  className: string
} {
  return {
    'aria-hidden': true,
    'data-videorc-nav-shortcut': '',
    'data-visible': visible ? 'true' : 'false',
    className: `transition-opacity duration-100 ease-out motion-reduce:transition-none ${
      visible ? 'opacity-100' : 'opacity-0'
    }`
  }
}
